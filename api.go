package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/golang-jwt/jwt/v5"
	qrcode "github.com/skip2/go-qrcode"
)

type apiError struct {
	code    int
	message string
}

func fail(code int, message string) { panic(apiError{code, message}) }

type claims struct {
	Version int64 `json:"v"`
	jwt.RegisteredClaims
}

type request struct {
	store
	r      *http.Request
	w      http.ResponseWriter
	id     int64
	user   row
	cookie *http.Cookie
}
type imagePNG []byte
type endpoint func(*request) any

type attempt struct {
	until time.Time
	count int
}
type loginLimiter struct {
	mu      sync.Mutex
	clients map[string]attempt
	cleanup time.Time
}

func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.After(l.cleanup) {
		for ip, record := range l.clients {
			if now.After(record.until) {
				delete(l.clients, ip)
			}
		}
		l.cleanup = now.Add(15 * time.Minute)
	}
	record := l.clients[ip]
	if now.After(record.until) {
		record = attempt{until: now.Add(15 * time.Minute)}
	}
	record.count++
	l.clients[ip] = record
	return record.count <= 40
}
func peerIP(r *http.Request) string {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func jsonReply(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Print(err)
	}
}

func (a *application) authenticate(r *request) row {
	token := strings.TrimPrefix(r.r.Header.Get("Authorization"), "Bearer ")
	if token == "" {
		if c, err := r.r.Cookie(sessionCookieName(r.r)); err == nil {
			token = c.Value
		}
	}
	if token == "" {
		return nil
	}
	data := new(claims)
	_, err := jwt.ParseWithClaims(token, data, func(*jwt.Token) (any, error) { return a.jwtKey, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("temp"), jwt.WithExpirationRequired())
	if err != nil {
		return nil
	}
	return r.one("SELECT * FROM users WHERE id=? AND version=? AND banned=0 AND deleted=0", data.Subject, data.Version)
}

func (r *request) audit(action string, target any) {
	r.exec("INSERT INTO logs(actor,action,ip,target) VALUES(?,?,?,?)", r.user["id"], action, peerIP(r.r), fmt.Sprint(target))
}

func (a *application) route(mux *http.ServeMux, pattern, title, access string, handler endpoint) {
	mux.HandleFunc(pattern, func(w http.ResponseWriter, raw *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				if known, ok := err.(apiError); ok {
					jsonReply(w, known.code, row{"error": known.message})
				} else {
					log.Printf("%s %s: %v", raw.Method, raw.URL.Path, err)
					jsonReply(w, 500, row{"error": "Ошибка сервера"})
				}
			}
		}()
		w.Header().Set("Cache-Control", "no-store")
		r := &request{store: store{raw.Context(), a.db}, r: raw, w: w}
		writes := raw.Method != "GET" && raw.Method != "HEAD"
		if writes {
			if origin := raw.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || !strings.EqualFold(u.Host, raw.Host) || u.Scheme != requestScheme(raw) {
					fail(403, "Недопустимый источник запроса")
				}
			}
			if (raw.URL.Path == "/api/login" || raw.URL.Path == "/api/register") && !a.limiter.allow(peerIP(raw)) {
				w.Header().Set("Retry-After", "900")
				fail(429, "Слишком много попыток. Попробуйте позже.")
			}
		}
		if id := raw.PathValue("id"); id != "" {
			r.id, _ = strconv.ParseInt(id, 10, 64)
			if r.id < 1 {
				fail(404, "Объект не найден")
			}
		}
		if writes {
			tx := must(a.db.BeginTx(raw.Context(), nil))
			defer tx.Rollback()
			r.queryer = tx
			r.user = a.authenticate(r)
			r.authorize(access)
			result := handler(r)
			r.audit(title, raw.PathValue("id"))
			if err := tx.Commit(); err != nil {
				panic(err)
			}
			if r.cookie != nil {
				http.SetCookie(w, r.cookie)
			}
			if result == nil {
				result = row{"ok": true}
			}
			jsonReply(w, 200, result)
			return
		}
		r.user = a.authenticate(r)
		r.authorize(access)
		if result := handler(r); result != nil {
			if png, ok := result.(imagePNG); ok {
				w.Header().Set("Content-Type", "image/png")
				_, _ = w.Write(png)
			} else {
				jsonReply(w, 200, result)
			}
		}
	})
}

func (r *request) authorize(access string) {
	if access != "" && r.user == nil {
		fail(401, "Войдите в аккаунт")
	}
	if access == "admin" && r.user.str("role") != "admin" {
		fail(403, "Требуются права администратора")
	}
}

func body[T any](r *request) T {
	var data *T
	dec := json.NewDecoder(http.MaxBytesReader(r.w, r.r.Body, 32<<10))
	err := dec.Decode(&data)
	if err == nil {
		var extra any
		err = dec.Decode(&extra)
		if err == io.EOF && data != nil {
			return *data
		}
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		fail(413, "Слишком большой запрос")
	}
	fail(400, "Проверьте формат JSON")
	return *new(T)
}
func validText(value string, min, max int) bool {
	n := utf8.RuneCountInString(value)
	return n >= min && n <= max
}
func validEmail(value string) bool {
	addr, err := mail.ParseAddress(value)
	return err == nil && addr.Address == value && strings.Contains(value, ".") && len(value) <= 254
}

func requestScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	return "http"
}
func sessionCookieName(r *http.Request) string {
	if r.TLS == nil {
		return "session_http"
	}
	return "session"
}
func sessionCookie(r *http.Request, value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: sessionCookieName(r), Value: value, Path: "/", HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode, MaxAge: maxAge}
}
func (a *application) establishSession(r *request, user row) row {
	now := time.Now()
	token := must(jwt.NewWithClaims(jwt.SigningMethodHS256, claims{user.num("version"), jwt.RegisteredClaims{
		Issuer: "temp", Subject: strconv.FormatInt(user.num("id"), 10), IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(2 * time.Hour)),
	}}).SignedString(a.jwtKey))
	r.user = user
	r.cookie = sessionCookie(r.r, token, 7200)
	return row{"token": token, "id": user["id"], "name": user["name"], "role": user["role"]}
}
func (a *application) register(r *request) any {
	b := body[struct{ Name, Email, Birth, Password string }](r)
	b.Name, b.Email = strings.TrimSpace(b.Name), strings.ToLower(b.Email)
	if !validText(b.Name, 2, 60) || !validEmail(b.Email) || !validText(b.Password, 10, 128) {
		fail(400, "Проверьте имя, почту и пароль")
	}
	if _, err := time.Parse(time.DateOnly, b.Birth); err != nil || b.Birth > time.Now().UTC().Format(time.DateOnly) || b.Birth < "1900-01-01" {
		fail(400, "Проверьте дату рождения")
	}
	if r.one("SELECT id FROM users WHERE email=?", b.Email) != nil {
		fail(409, "Электронная почта уже используется")
	}
	id := must(r.exec("INSERT INTO users(name,birth,email,hash) VALUES(?,?,?,?)", b.Name, b.Birth, b.Email, passwordHash(b.Password)).LastInsertId())
	return a.establishSession(r, r.one("SELECT * FROM users WHERE id=?", id))
}
func (a *application) login(r *request) any {
	b := body[struct{ Email, Password string }](r)
	if !validEmail(b.Email) || !validText(b.Password, 1, 128) {
		fail(400, "Проверьте почту и пароль")
	}
	u := r.one("SELECT * FROM users WHERE email=? AND deleted=0", strings.ToLower(b.Email))
	if u == nil || !passwordMatches(b.Password, u.str("hash")) || u.num("banned") != 0 {
		fail(401, "Неверные данные или доступ ограничен")
	}
	return a.establishSession(r, u)
}

func (r *request) event() row {
	e := r.one(eventQuery+" WHERE e.id=?", r.id)
	if e == nil {
		fail(404, "Событие не найдено")
	}
	return e
}
func (r *request) manages(e row) bool {
	return r.user.num("id") == e.num("owner") || r.user.str("role") == "admin"
}
func (r *request) ownEvent() row {
	e := r.event()
	if !r.manages(e) {
		fail(403, "Только для организатора")
	}
	return e
}
func (r *request) available(e row) bool {
	return e.str("status") == "approved" && r.one("SELECT id FROM users WHERE id=? AND banned=0 AND deleted=0", e["owner"]) != nil
}

func createEvent(r *request) any {
	b := body[struct {
		seriesInput
		Title, Sport, Description, Place, Start, Gate string
		Lat, Lng                                      float64
		Duration, Capacity                            int
		MinAge                                        *int
	}](r)
	b.Title, b.Description, b.Place = strings.TrimSpace(b.Title), strings.TrimSpace(b.Description), strings.TrimSpace(b.Place)
	if !validText(b.Title, 3, 100) || !validText(b.Description, 10, 2000) || !validText(b.Place, 3, 150) || !slices.Contains(sports, b.Sport) ||
		b.Lat < 47.1 || b.Lat > 47.36 || b.Lng < 39.52 || b.Lng > 39.92 || b.Duration < 5 || b.Duration > 1440 || b.Capacity < 1 || b.Capacity > 5000 ||
		b.MinAge == nil || *b.MinAge < 0 || *b.MinAge > 100 || !slices.Contains([]string{"open", "ticket", "qr"}, b.Gate) {
		fail(400, "Проверьте поля события и координаты")
	}
	start, err := time.Parse(time.RFC3339Nano, b.Start)
	if err != nil || !strings.HasSuffix(b.Start, "Z") || !start.After(time.Now()) {
		fail(400, "Выберите будущее время")
	}
	id := must(r.exec("INSERT INTO events(owner,title,sport,description,place,lat,lng,start,duration,capacity,minAge,gate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
		r.user["id"], b.Title, b.Sport, b.Description, b.Place, b.Lat, b.Lng, formatTime(start), b.Duration, b.Capacity, *b.MinAge, b.Gate).LastInsertId())
	result := row{"id": id, "status": "pending"}
	if b.SeriesID != 0 || b.SeriesTitle != "" {
		linked := r.linkEdition(row{"id": id, "owner": r.user["id"], "sport": b.Sport}, b.seriesInput)
		result["seriesId"] = linked["seriesId"]
	}
	return result
}
func ageOn(birth string, t time.Time) int {
	date, err := time.Parse(time.DateOnly, birth)
	if err != nil {
		return -1
	}
	age := t.Year() - date.Year()
	if t.Month() < date.Month() || (t.Month() == date.Month() && t.Day() < date.Day()) {
		age--
	}
	return age
}
func joinEvent(r *request) any {
	e := r.event()
	if !r.available(e) || !startTime(e).After(time.Now()) || e.num("owner") == r.user.num("id") {
		fail(409, "Запись недоступна")
	}
	if r.one("SELECT id FROM tickets WHERE event=? AND user=?", r.id, r.user["id"]) != nil {
		fail(409, "Вы уже записаны")
	}
	if e.num("booked") >= e.num("capacity") {
		fail(409, "Свободных мест нет")
	}
	if min := e.num("minAge"); min > 0 && ageOn(r.user.str("birth"), startTime(e).In(moscow)) < int(min) {
		fail(403, "Возрастное ограничение")
	}
	r.exec("INSERT INTO tickets(event,user,token) VALUES(?,?,?)", r.id, r.user["id"], randomHex(20))
	return row{"event": r.id}
}
func cancelTicket(r *request) any {
	e := r.event()
	if !startTime(e).After(time.Now()) {
		fail(409, "Событие уже началось")
	}
	if r.one("SELECT id FROM tickets WHERE event=? AND user=? AND attended=1", r.id, r.user["id"]) != nil {
		fail(409, "Посещение уже подтверждено")
	}
	r.exec("DELETE FROM tickets WHERE event=? AND user=? AND attended=0", r.id, r.user["id"])
	return nil
}
func ticketQR(r *request) any {
	t := r.one("SELECT t.token FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=e.owner WHERE t.id=? AND t.user=? AND t.attended=0 AND e.gate='qr' AND e.status='approved' AND u.banned=0 AND julianday(e.start)+e.duration/1440.0>julianday('now')", r.id, r.user["id"])
	if t == nil {
		fail(404, "Билет не найден")
	}
	return imagePNG(must(qrcode.Encode(t.str("token"), qrcode.Medium, 256)))
}
func checkIn(r *request) any {
	b := body[struct {
		Token  *string
		Ticket *int64
	}](r)
	var token string
	var ticket int64
	if b.Token != nil {
		token = strings.TrimSpace(*b.Token)
		if !validText(token, 1, 80) {
			fail(400, "Проверьте код билета")
		}
	}
	if b.Ticket != nil {
		ticket = *b.Ticket
		if ticket < 1 || ticket > 2147483647 {
			fail(400, "Проверьте номер билета")
		}
	}
	e := r.ownEvent()
	if !r.available(e) || expired(e) || time.Now().Before(startTime(e).Add(-time.Hour)) {
		fail(409, "Отметка доступна за час до начала и во время события")
	}
	const eligible = "SELECT t.id,t.user,t.attended,u.name FROM tickets t JOIN users u ON u.id=t.user WHERE t.event=? AND u.banned=0 AND u.deleted=0 AND "
	var t row
	if e.str("gate") == "open" || (e.str("gate") == "ticket" && ticket > 0) {
		t = r.one(eligible+"t.id=?", r.id, ticket)
	} else {
		t = r.one(eligible+"t.token=?", r.id, token)
	}
	if t == nil {
		fail(404, "Билет недействителен")
	}
	if t.num("attended") != 0 {
		fail(409, "Участник уже отмечен")
	}
	r.exec("UPDATE tickets SET attended=1 WHERE id=?", t["id"])
	r.credit(t.num("user"), "attendance", t.num("id"), 10)
	return row{"name": t["name"]}
}
func award(r *request) any {
	b := body[struct {
		Ticket int64
		Rank   int
	}](r)
	if b.Ticket < 1 || b.Ticket > 2147483647 || b.Rank < 1 || b.Rank > 3 {
		fail(400, "Проверьте билет и место")
	}
	e := r.ownEvent()
	if !expired(e) || !r.available(e) {
		fail(409, "Дождитесь окончания события")
	}
	if r.one("SELECT id FROM tickets WHERE event=? AND rank=? AND id<>?", r.id, b.Rank, b.Ticket) != nil {
		fail(409, "Место уже присуждено")
	}
	if must(r.exec("UPDATE tickets SET rank=? WHERE id=? AND event=? AND attended=1", b.Rank, b.Ticket, r.id).RowsAffected()) == 0 {
		fail(400, "Участие не подтверждено")
	}
	return nil
}
func review(r *request) any {
	b := body[struct {
		Stars int
		Body  string
	}](r)
	b.Body = strings.TrimSpace(b.Body)
	if b.Stars < 1 || b.Stars > 5 || !validText(b.Body, 5, 1500) {
		fail(400, "Проверьте оценку и текст отзыва")
	}
	e := r.event()
	if !expired(e) || e.str("status") != "approved" || r.one("SELECT id FROM tickets WHERE user=? AND event=? AND attended=1", r.user["id"], r.id) == nil {
		fail(403, "Отзыв доступен участникам после окончания")
	}
	if r.one("SELECT id FROM reviews WHERE user=? AND event=?", r.user["id"], r.id) != nil {
		fail(409, "Отзыв уже опубликован")
	}
	r.exec("INSERT INTO reviews(event,user,stars,body) VALUES(?,?,?,?)", r.id, r.user["id"], b.Stars, b.Body)
	if b.Stars > 2 {
		return nil
	}
	owner := e["owner"]
	stats := r.one("SELECT count(DISTINCT r.user) people,count(DISTINCT e.id) events FROM reviews r JOIN events e ON e.id=r.event LEFT JOIN moderation_resets m ON m.owner=e.owner WHERE e.owner=? AND r.id>COALESCE(m.last_review,0) AND r.stars<=2", owner)
	if stats.num("people") >= 3 && stats.num("events") >= 2 {
		if must(r.exec("UPDATE users SET banned=1,version=version+1 WHERE role='user' AND banned=0 AND id=?", owner).RowsAffected()) > 0 {
			r.exec("DELETE FROM tickets WHERE user=? AND attended=0", owner)
			r.audit("Автоблокировка по отзывам", owner)
		}
	}
	return nil
}
func moderateEvent(r *request) any {
	b := body[struct{ Status string }](r)
	if !slices.Contains([]string{"approved", "rejected", "removed"}, b.Status) {
		fail(400, "Проверьте статус")
	}
	event := r.event()
	if event.str("status") == "approved" && b.Status != "approved" {
		r.syncPoints(event.num("owner"))
	}
	r.exec("UPDATE events SET status=? WHERE id=?", b.Status, r.id)
	r.audit(b.Status, r.id)
	return nil
}
func moderateUser(r *request) any {
	b := body[struct{ Action string }](r)
	if !slices.Contains([]string{"ban", "unban", "delete"}, b.Action) {
		fail(400, "Проверьте действие")
	}
	u := r.one("SELECT id,banned FROM users WHERE id=? AND role='user' AND deleted=0", r.id)
	if u == nil {
		fail(403, "Действие недоступно")
	}
	banned := b.Action != "unban"
	if !banned && u.num("banned") != 0 {
		r.exec("INSERT OR REPLACE INTO moderation_resets(owner,last_review) SELECT ?,COALESCE(MAX(id),0) FROM reviews", r.id)
	}
	if b.Action == "delete" {
		r.exec("UPDATE users SET name='Удалённый участник',email=?,birth=NULL,deleted=1 WHERE id=?", randomHex(16)+"@removed.invalid", r.id)
		r.exec("UPDATE events SET status='removed' WHERE owner=?", r.id)
	}
	r.exec("UPDATE users SET banned=?,version=version+1 WHERE id=?", banned, r.id)
	if banned {
		r.exec("DELETE FROM tickets WHERE user=? AND attended=0", r.id)
	}
	r.audit(b.Action, r.id)
	return nil
}
