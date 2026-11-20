package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

const shopSchema = `
CREATE TABLE IF NOT EXISTS point_entries (
 id INTEGER PRIMARY KEY,
 user INTEGER NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL,
 reference INTEGER NOT NULL,
 delta INTEGER NOT NULL CHECK(delta<>0),
 at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user,kind,reference)
);
CREATE TABLE IF NOT EXISTS shop_products (
 id INTEGER PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('physical','badge','theme')),
 price INTEGER NOT NULL CHECK(price>0),
 stock INTEGER CHECK(stock>=0),
 theme TEXT NOT NULL DEFAULT '',
 image TEXT NOT NULL DEFAULT '',
 pickup TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE IF NOT EXISTS shop_orders (
 id INTEGER PRIMARY KEY,
 user INTEGER NOT NULL REFERENCES users(id),
 product INTEGER NOT NULL REFERENCES shop_products(id),
 requestId TEXT NOT NULL,
 title TEXT NOT NULL,
 kind TEXT NOT NULL,
 price INTEGER NOT NULL,
 theme TEXT NOT NULL DEFAULT '',
 pickup TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('reserved','ready','fulfilled','cancelled')),
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user,requestId)
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_unique_digital ON shop_orders(user,product) WHERE kind <> 'physical';
CREATE INDEX IF NOT EXISTS shop_orders_user ON shop_orders(user,id);
CREATE TABLE IF NOT EXISTS profile_decoration (
 user INTEGER PRIMARY KEY REFERENCES users(id),
 badge INTEGER REFERENCES shop_orders(id),
 theme INTEGER REFERENCES shop_orders(id)
);
CREATE INDEX IF NOT EXISTS events_owner ON events(owner);
CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user);
`

const rewardCity = "Ростов-на-Дону"
const qualifyingEvents = "e.status='approved' AND julianday(e.start)+e.duration/1440.0<=julianday('now') AND EXISTS (SELECT 1 FROM tickets t WHERE t.event=e.id AND t.attended=1)"
const ordersSQL = "SELECT id,product,title,kind,price,theme,pickup,status,created FROM shop_orders"
const profileStyleSQL = "SELECT COALESCE(b.title,'') badge,COALESCE(t.theme,'') theme FROM profile_decoration d LEFT JOIN shop_orders b ON b.id=d.badge LEFT JOIN shop_orders t ON t.id=d.theme WHERE d.user=?"

var shopThemes = []string{"mint", "ocean", "violet", "amber"}
var requestKey = regexp.MustCompile("^[A-Za-z0-9_-]{16,80}$")

func (s store) credit(user int64, kind string, reference, points int64) {
	s.exec("INSERT OR IGNORE INTO point_entries(user,kind,reference,delta) VALUES(?,?,?,?)", user, kind, reference, points)
}

func (s store) syncPoints(user int64) {
	// The ledger keys keep historical backfills and retries idempotent.
	s.exec("INSERT OR IGNORE INTO point_entries(user,kind,reference,delta) SELECT user,'attendance',id,10 FROM tickets WHERE user=? AND attended=1", user)
	s.exec("INSERT OR IGNORE INTO point_entries(user,kind,reference,delta) SELECT ?, 'organization', e.id, 30 FROM events e WHERE e.owner=? AND "+qualifyingEvents, user, user)
	held := s.one("SELECT count(*) n FROM point_entries WHERE user=? AND kind='organization'", user).num("n")
	paid := s.one("SELECT COALESCE(MAX(reference),0) n FROM point_entries WHERE user=? AND kind='city_bonus'", user).num("n")
	for milestone := paid + 1; milestone <= held/5; milestone++ {
		s.credit(user, "city_bonus", milestone, 40)
	}
}
func (s store) balance(user int64) int64 {
	return s.one("SELECT COALESCE(SUM(delta),0) balance FROM point_entries WHERE user=?", user).num("balance")
}

func (a *application) wallet(r *request) any {
	user := r.user.num("id")
	tx := must(a.db.BeginTx(r.Context, nil))
	defer tx.Rollback()
	s := store{r.Context, tx}
	s.syncPoints(user)
	held := s.one("SELECT count(*) n FROM point_entries WHERE user=? AND kind='organization'", user).num("n")
	result := row{
		"balance":    s.balance(user),
		"history":    s.all("SELECT id,kind,reference,delta,at FROM point_entries WHERE user=? ORDER BY id DESC LIMIT 50", user),
		"organizer":  row{"city": rewardCity, "rewardedEvents": held, "nextMilestone": (held/5 + 1) * 5},
		"orders":     s.all(ordersSQL+" WHERE user=? ORDER BY id DESC", user),
		"decoration": s.decoration(user),
	}
	must(struct{}{}, tx.Commit())
	return result
}

func (s store) decoration(user int64) row {
	style := s.one("SELECT badge badgeOrder,theme themeOrder FROM profile_decoration WHERE user=?", user)
	if style == nil {
		style = row{"badgeOrder": nil, "themeOrder": nil}
	}
	applied := s.one(profileStyleSQL, user)
	style["badge"], style["theme"] = applied.str("badge"), applied.str("theme")
	return style
}

func purchase(r *request) any {
	b := body[struct {
		Product   int64
		RequestID string
	}](r)
	b.RequestID = strings.TrimSpace(b.RequestID)
	if b.Product < 1 || !requestKey.MatchString(b.RequestID) {
		fail(400, "Проверьте ID товара и ключ покупки")
	}
	user := r.user.num("id")
	r.syncPoints(user)
	if previous := r.one(ordersSQL+" WHERE user=? AND requestId=?", user, b.RequestID); previous != nil {
		if previous.num("product") != b.Product {
			fail(409, "Ключ покупки уже использован")
		}
		return row{"order": previous, "balance": r.balance(user)}
	}
	p := r.one("SELECT * FROM shop_products WHERE id=? AND active=1", b.Product)
	if p == nil {
		fail(404, "Товар недоступен")
	}
	status := "fulfilled"
	if p.str("kind") == "physical" {
		if must(r.exec("UPDATE shop_products SET stock=stock-1 WHERE id=? AND stock>0", b.Product).RowsAffected()) == 0 {
			fail(409, "Товар закончился")
		}
		status = "reserved"
	} else if r.one("SELECT id FROM shop_orders WHERE user=? AND product=?", user, b.Product) != nil {
		fail(409, "Украшение уже приобретено")
	}
	balance := r.balance(user)
	price := p.num("price")
	if balance < price {
		fail(409, "Недостаточно баллов")
	}
	id := must(r.exec("INSERT INTO shop_orders(user,product,requestId,title,kind,price,theme,pickup,status) VALUES(?,?,?,?,?,?,?,?,?)",
		user, b.Product, b.RequestID, p["title"], p["kind"], price, p["theme"], p["pickup"], status).LastInsertId())
	r.credit(user, "purchase", id, -price)
	return row{"order": r.one(ordersSQL+" WHERE id=?", id), "balance": balance - price}
}

func setDecoration(r *request) any {
	b := body[struct{ Badge, Theme json.RawMessage }](r)
	var badge, theme *int64
	if json.Unmarshal(b.Badge, &badge) != nil || json.Unmarshal(b.Theme, &theme) != nil {
		fail(400, "Передайте badge и theme с номером заказа или null")
	}
	user := r.user.num("id")
	for kind, id := range map[string]*int64{"badge": badge, "theme": theme} {
		if id != nil && r.one("SELECT id FROM shop_orders WHERE id=? AND user=? AND kind=? AND status='fulfilled'", *id, user, kind) == nil {
			fail(403, "Украшение не принадлежит аккаунту")
		}
	}
	r.exec("INSERT INTO profile_decoration(user,badge,theme) VALUES(?,?,?) ON CONFLICT(user) DO UPDATE SET badge=excluded.badge,theme=excluded.theme",
		user, badge, theme)
	return r.decoration(user)
}

type productInput struct {
	Title, Description, Kind, Theme, Image, Pickup string
	Price                                          int
	Stock                                          *int
	ExpectedStock                                  *int
	Active                                         *bool
}

func saveProduct(r *request) any {
	b := body[productInput](r)
	b.Title, b.Description, b.Pickup, b.Image = strings.TrimSpace(b.Title), strings.TrimSpace(b.Description), strings.TrimSpace(b.Pickup), strings.TrimSpace(b.Image)
	if !validText(b.Title, 2, 90) || !validText(b.Description, 4, 1000) || b.Price < 1 || b.Price > 100000 || b.Active == nil ||
		!slices.Contains([]string{"physical", "badge", "theme"}, b.Kind) {
		fail(400, "Проверьте название, описание, тип, цену и доступность")
	}
	if b.Image != "" {
		u, err := url.Parse(b.Image)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || len(b.Image) > 1500 {
			fail(400, "Укажите HTTPS-ссылку на фото")
		}
	}
	if b.Kind == "physical" {
		if b.Stock == nil || *b.Stock < 0 || *b.Stock > 100000 || !validText(b.Pickup, 5, 500) {
			fail(400, "Укажите остаток и инструкцию по получению")
		}
	} else {
		b.Stock = nil
		b.Pickup = ""
	}
	if b.Kind == "theme" {
		if !slices.Contains(shopThemes, b.Theme) {
			fail(400, "Выберите тему оформления")
		}
	} else {
		b.Theme = ""
	}
	if r.id == 0 {
		r.id = must(r.exec("INSERT INTO shop_products(title,description,kind,price,stock,theme,image,pickup,active) VALUES(?,?,?,?,?,?,?,?,?)",
			b.Title, b.Description, b.Kind, b.Price, b.Stock, b.Theme, b.Image, b.Pickup, *b.Active).LastInsertId())
	} else {
		current := r.one("SELECT kind,stock FROM shop_products WHERE id=?", r.id)
		if current == nil {
			fail(404, "Товар не найден")
		}
		if current.str("kind") != b.Kind {
			fail(409, "Тип существующего товара изменить нельзя")
		}
		if b.Kind == "physical" && (b.ExpectedStock == nil || int64(*b.ExpectedStock) != current.num("stock")) {
			fail(409, "Остаток изменился. Обновите страницу и повторите редактирование.")
		}
		r.exec("UPDATE shop_products SET title=?,description=?,price=?,stock=?,theme=?,image=?,pickup=?,active=? WHERE id=?",
			b.Title, b.Description, b.Price, b.Stock, b.Theme, b.Image, b.Pickup, *b.Active, r.id)
	}
	r.audit("Товар магазина", r.id)
	return r.one("SELECT * FROM shop_products WHERE id=?", r.id)
}

func updateOrder(r *request) any {
	b := body[struct{ Status string }](r)
	if !slices.Contains([]string{"ready", "fulfilled", "cancelled"}, b.Status) {
		fail(400, "Проверьте статус заказа")
	}
	order := r.one("SELECT * FROM shop_orders WHERE id=? AND kind='physical'", r.id)
	if order == nil {
		fail(404, "Заказ не найден")
	}
	from := order.str("status")
	if from == b.Status {
		return r.one(ordersSQL+" WHERE id=?", r.id)
	}
	if (from != "reserved" && from != "ready") || (b.Status == "fulfilled" && from != "ready") ||
		(b.Status == "ready" && from != "reserved") {
		fail(409, "Недопустимый переход статуса")
	}
	if b.Status == "cancelled" {
		r.credit(order.num("user"), "refund", r.id, order.num("price"))
		r.exec("UPDATE shop_products SET stock=stock+1 WHERE id=?", order["product"])
	}
	r.exec("UPDATE shop_orders SET status=? WHERE id=?", b.Status, r.id)
	return r.one(ordersSQL+" WHERE id=?", r.id)
}

func (a *application) shopRoutes(mux *http.ServeMux) {
	a.route(mux, "GET /api/shop/products", "", "", func(r *request) any {
		return r.all("SELECT id,title,description,kind,price,stock,theme,image FROM shop_products WHERE active=1 ORDER BY id DESC")
	})
	a.route(mux, "GET /api/wallet", "", "user", a.wallet)
	a.route(mux, "POST /api/shop/orders", "Покупка за баллы", "user", purchase)
	a.route(mux, "PUT /api/profile/decoration", "Оформление профиля", "user", setDecoration)
	a.route(mux, "GET /api/organizers/leaderboard", "", "", organizerRanking)
	a.route(mux, "GET /api/people/{id}", "", "", func(r *request) any {
		person := r.one("SELECT id,name FROM users WHERE id=? AND banned=0 AND deleted=0", r.id)
		if person == nil {
			fail(404, "Профиль не найден")
		}
		stats := r.profile(r.id)
		style := r.decoration(r.id)
		for _, key := range []string{"level", "attended", "held"} {
			person[key] = stats[key]
		}
		person["city"], person["badge"], person["theme"] = rewardCity, style["badge"], style["theme"]
		return person
	})
	a.route(mux, "GET /api/admin/shop", "", "admin", func(r *request) any {
		return row{"products": r.all("SELECT * FROM shop_products ORDER BY id DESC"), "orders": r.all(
			"SELECT o.id,o.product,o.title,o.kind,o.price,o.theme,o.pickup,o.status,o.created,o.user,u.name buyer FROM shop_orders o JOIN users u ON u.id=o.user WHERE o.kind='physical' ORDER BY (o.status IN ('reserved','ready')) DESC,o.id DESC")}
	})
	a.route(mux, "POST /api/admin/shop/products", "Добавление товара", "admin", saveProduct)
	a.route(mux, "PUT /api/admin/shop/products/{id}", "Редактирование товара", "admin", saveProduct)
	a.route(mux, "POST /api/admin/shop/orders/{id}", "Обработка заказа", "admin", updateOrder)
}
