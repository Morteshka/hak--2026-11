package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"errors"
	"html"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type application struct {
	db             *sql.DB
	jwtKey         []byte
	secure         bool
	mapKey, origin string
	indexHTML      string
	limiter        loginLimiter
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func (a *application) scheme() string {
	if a.secure {
		return "https"
	}
	return "http"
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	a.route(mux, "POST /api/register", "Регистрация", "", a.register)
	a.route(mux, "POST /api/login", "Вход", "", a.login)
	a.route(mux, "POST /api/logout", "Выход", "user", func(r *request) any {
		r.exec("UPDATE users SET version=version+1 WHERE id=?", r.user["id"])
		r.cookie = a.sessionCookie("", -1)
		return nil
	})
	a.route(mux, "GET /api/me", "", "user", func(r *request) any { return r.profile(r.user.num("id")) })
	a.route(mux, "GET /api/events", "", "", func(r *request) any {
		return r.all(eventQuery + " WHERE e.status='approved' AND u.banned=0 AND u.deleted=0 ORDER BY e.start")
	})
	a.route(mux, "GET /api/events/{id}", "", "", func(r *request) any {
		e := r.event()
		if !r.available(e) && !r.manages(e) {
			fail(404, "Событие недоступно")
		}
		e["reviews"] = r.all("SELECT r.stars,r.body,u.name FROM reviews r JOIN users u ON u.id=r.user WHERE event=? ORDER BY r.id DESC", r.id)
		return e
	})
	a.route(mux, "POST /api/events", "Заявка на проведение", "user", createEvent)
	a.route(mux, "POST /api/events/{id}/join", "Запись на мероприятие", "user", joinEvent)
	a.route(mux, "DELETE /api/events/{id}/join", "Отмена записи", "user", cancelTicket)
	a.route(mux, "GET /api/tickets/{id}/qr", "", "user", ticketQR)
	a.route(mux, "GET /api/events/{id}/roster", "", "user", func(r *request) any {
		r.ownEvent()
		return r.all("SELECT t.id,t.user,t.attended,t.rank,u.name FROM tickets t JOIN users u ON u.id=t.user WHERE t.event=?", r.id)
	})
	a.route(mux, "POST /api/events/{id}/checkin", "Подтверждение прихода", "user", checkIn)
	a.route(mux, "POST /api/events/{id}/awards", "Присуждение места", "user", award)
	a.route(mux, "POST /api/events/{id}/reviews", "Отзыв участника", "user", review)
	a.route(mux, "GET /api/admin", "", "admin", func(r *request) any {
		return row{"events": r.all(eventQuery + " ORDER BY e.id DESC"), "users": r.all("SELECT id,name,email,role,banned,deleted FROM users ORDER BY id DESC"),
			"logs": r.all("SELECT * FROM logs ORDER BY id DESC LIMIT 500")}
	})
	a.route(mux, "POST /api/admin/events/{id}", "Модерация события", "admin", moderateEvent)
	a.route(mux, "POST /api/admin/users/{id}", "Управление пользователем", "admin", moderateUser)
	mux.HandleFunc("GET /api/openapi.json", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, "openapi.json") })
	api404 := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		jsonReply(w, 404, row{"error": "Метод не найден"})
	}
	// Keep the JSON fallback outside the API mux. Mixed method/path fallbacks conflict in ServeMux.
	apiMux := mux
	mux = http.NewServeMux()
	mux.Handle("/api/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := apiMux.Handler(r); pattern == "" {
			api404(w, r)
			return
		}
		apiMux.ServeHTTP(w, r)
	}))
	mux.HandleFunc("/api", api404)
	for path, dir := range map[string]string{"/static/": "static", "/vendor/map/": "node_modules/leaflet/dist", "/vendor/swagger/": "node_modules/swagger-ui-dist", "/vendor/icon/": "node_modules/lucide-static/icons"} {
		mux.Handle("GET "+path, http.StripPrefix(path, http.FileServer(http.Dir(dir))))
	}
	mux.HandleFunc("GET /vendor/scanner.js", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "node_modules/html5-qrcode/html5-qrcode.min.js")
	})
	mux.HandleFunc("GET /docs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><meta charset=utf-8><title>Темп · Swagger API</title><link rel=\"stylesheet\" href=\"/vendor/swagger/swagger-ui.css\"><div id=\"swagger\"></div><script src=\"/vendor/swagger/swagger-ui-bundle.js\"></script><script src=\"/static/docs.js\"></script>"))
	})
	mux.HandleFunc("GET /robots.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /profile\nDisallow: /api/\n"))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		a.page(w, r)
	})
	return a.headers(mux)
}

var titles = map[string]string{"/": "Афиша событий", "/map": "Карта событий", "/create": "Создать событие", "/profile": "Мой профиль", "/login": "Вход", "/register": "Регистрация", "/thanks": "Спасибо за заявку", "/admin": "Администрирование", "/privacy": "Политика конфиденциальности"}

func (a *application) page(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if err := recover(); err != nil {
			log.Print(err)
			http.Error(w, "Ошибка сервера", 500)
		}
	}()
	title, found := titles[r.URL.Path]
	var e row
	if id, ok := strings.CutPrefix(r.URL.Path, "/events/"); ok {
		n, err := strconv.ParseInt(id, 10, 64)
		if err == nil {
			s := store{r.Context(), a.db}
			e = s.one(eventQuery+" WHERE e.id=? AND e.status='approved' AND u.banned=0 AND u.deleted=0", n)
		}
	}
	origin := a.origin
	if origin == "" {
		origin = a.scheme() + "://" + r.Host
	}
	linkedData := row{"@context": "https://schema.org", "@type": "WebSite", "name": "Темп", "url": origin}
	if e != nil {
		title = e.str("title")
		found = true
	}
	if !found {
		title = "Страница не найдена"
	}
	description := title + " — спортивные встречи в Ростове-на-Дону на платформе Темп."
	if e != nil {
		description = e.str("description")
		linkedData = row{"@context": "https://schema.org", "@type": "SportsEvent", "name": title, "startDate": e["start"], "description": description,
			"location": row{"@type": "Place", "name": e["place"], "address": "Ростов-на-Дону, " + e.str("place")}}
	}
	markup := strings.NewReplacer("__MAP_KEY__", html.EscapeString(a.mapKey), "__TITLE__", html.EscapeString(title),
		"__DESC__", html.EscapeString(description), "__IMAGE__", html.EscapeString(origin+"/static/media/hero.jpg"),
		"__LD__", string(must(json.Marshal(linkedData)))).Replace(a.indexHTML)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if !found {
		w.WriteHeader(404)
	}
	_, _ = w.Write([]byte(markup))
}
func (a *application) headers(next http.Handler) http.Handler {
	mapHosts := ""
	if a.mapKey != "" {
		mapHosts = " https://api-maps.yandex.ru https://*.api-maps.yandex.ru https://*.maps.yandex.net https://suggest-maps.yandex.ru https://yandex.ru https://yastatic.net"
	}
	policy := "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'self'; " +
		"script-src 'self'" + mapHosts + "; connect-src 'self'" + mapHosts + "; frame-src 'self' https://yandex.ru https://api-maps.yandex.ru; " +
		"style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob: https://tile.openstreetmap.org" + mapHosts + "; media-src 'self' blob:"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", policy)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

func localTLS(dir string) tls.Certificate {
	p := filepath.Join(dir, "local-tls.json")
	data, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		pubIP := os.Getenv("TLS_PUBLIC_IP")
		name := env("TLS_PUBLIC_IP", "localhost")
		private := must(ecdsa.GenerateKey(elliptic.P256(), rand.Reader))
		serial := must(rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)))
		cert := x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: name},
			NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(1, 0, 0), DNSNames: []string{"localhost"},
			IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		if pubIP != "" {
			ip := net.ParseIP(pubIP)
			if ip == nil {
				panic("TLS_PUBLIC_IP должен быть IP-адресом")
			}
			cert.IPAddresses = append(cert.IPAddresses, ip)
		}
		pemCert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: must(x509.CreateCertificate(rand.Reader, &cert, &cert, private.Public(), private))})
		pemKey := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: must(x509.MarshalPKCS8PrivateKey(private))})
		data = must(json.Marshal(map[string]string{"cert": string(pemCert), "key": string(pemKey)}))
		if err := os.WriteFile(p, data, 0600); err != nil {
			panic(err)
		}
	} else if err != nil {
		panic(err)
	}
	var pair struct{ Cert, Key string }
	if err := json.Unmarshal(data, &pair); err != nil {
		panic(err)
	}
	return must(tls.X509KeyPair([]byte(pair.Cert), []byte(pair.Key)))
}

func main() {
	// Docker initializes an empty named volume with the app user's ownership.
	dir := env("DATA_DIR", "data")
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Fatal(err)
	}
	key := os.Getenv("JWT_SECRET")
	if key == "" {
		key = secret(dir, "jwt-key", 32)
	}
	a := &application{db: openDB(dir), jwtKey: []byte(key), secure: os.Getenv("HTTPS") != "0",
		mapKey: strings.TrimSpace(os.Getenv("YANDEX_MAPS_API_KEY")), origin: strings.TrimRight(os.Getenv("PUBLIC_ORIGIN"), "/"),
		indexHTML: string(must(os.ReadFile("index.html"))), limiter: loginLimiter{clients: make(map[string]attempt)}}
	defer a.db.Close()
	s := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	listener := must(net.Listen("tcp", net.JoinHostPort(env("BIND", "127.0.0.1"), env("PORT", "3443"))))
	if a.secure {
		var cert tls.Certificate
		certFile, keyFile := os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY")
		if certFile != "" || keyFile != "" {
			cert = must(tls.LoadX509KeyPair(certFile, keyFile))
		} else {
			cert = localTLS(dir)
		}
		s.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() {
		<-ctx.Done()
		timeout, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.Shutdown(timeout); err != nil {
			log.Print(err)
		}
		close(done)
	}()
	// stdout marks readiness for the integration harness.
	os.Stdout.WriteString("Темп · " + a.scheme() + "://" + listener.Addr().String() + "\n")
	var err error
	if a.secure {
		err = s.ServeTLS(listener, "", "")
	} else {
		err = s.Serve(listener)
	}
	if !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-done
}
