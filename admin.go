package main

import (
	"net/http"
	"strconv"
	"strings"
)

const adminSchema = `
CREATE TABLE IF NOT EXISTS hidden_reviews (
 review INTEGER PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
 reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS point_adjustments (
 id INTEGER PRIMARY KEY,
 user INTEGER NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL,
 delta INTEGER NOT NULL,
 reason TEXT NOT NULL,
 UNIQUE(user,request_id)
);
CREATE INDEX IF NOT EXISTS logs_actor ON logs(actor,id);
CREATE INDEX IF NOT EXISTS admin_events_status ON events(status,id);
`

func (a *application) adminRoutes(mux *http.ServeMux) {
	a.route(mux, "GET /api/admin/overview", "", "admin", adminOverview)
	a.route(mux, "GET /api/admin/events", "", "admin", adminEvents)
	a.route(mux, "POST /api/admin/events/bulk", "Пакетная модерация событий", "admin", adminBulkEvents)
	a.route(mux, "GET /api/admin/users", "", "admin", adminUsers)
	a.route(mux, "POST /api/admin/users/{id}/sessions/revoke", "Отзыв сессий", "admin", adminRevokeSessions)
	a.route(mux, "POST /api/admin/users/{id}/points", "Корректировка баллов", "admin", adminAdjustPoints)
	a.route(mux, "GET /api/admin/reviews", "", "admin", adminReviews)
	a.route(mux, "POST /api/admin/reviews/{id}", "Модерация отзыва", "admin", adminModerateReview)
	a.route(mux, "GET /api/admin/logs", "", "admin", adminLogs)
}

func adminOverview(r *request) any {
	return r.one(`SELECT
		(SELECT COUNT(*) FROM events WHERE status='pending') pendingEvents,
		(SELECT COUNT(*) FROM events e JOIN users u ON u.id=e.owner
			WHERE e.status='approved' AND u.banned=0 AND u.deleted=0 AND julianday(e.start)>=julianday('now')) upcomingEvents,
		(SELECT COUNT(*) FROM users WHERE deleted=0 AND banned=0) activeUsers,
		(SELECT COUNT(*) FROM users WHERE deleted=0 AND banned=1) bannedUsers,
		(SELECT COUNT(*) FROM tickets WHERE attended=1) checkIns,
		(SELECT COUNT(*) FROM shop_orders WHERE status IN ('reserved','ready')) openOrders,
		(SELECT COUNT(*) FROM reviews r WHERE r.stars<=2
			AND NOT EXISTS (SELECT 1 FROM hidden_reviews h WHERE h.review=r.id)) lowReviews`)
}

func adminList(r *request, query, idColumn, where string, args ...any) row {
	params := r.r.URL.Query()
	limit, before := int64(25), int64(0)
	if params.Get("limit") != "" {
		limit = adminNumber(params.Get("limit"), "limit")
		if limit > 100 {
			fail(400, "limit должен быть от 1 до 100")
		}
	}
	if params.Get("before") != "" {
		before = adminNumber(params.Get("before"), "before")
	}
	args = append(args, before, before, limit+1)
	items := r.all(query+" WHERE ("+where+") AND (?=0 OR "+idColumn+"<?) ORDER BY "+idColumn+" DESC LIMIT ?", args...)
	var next any
	if int64(len(items)) > limit {
		items = items[:limit]
		next = items[len(items)-1]["id"]
	}
	return row{"items": items, "nextBefore": next}
}

func adminNumber(raw, field string) int64 {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id < 1 {
		fail(400, "Некорректное значение "+field)
	}
	return id
}

func adminFilter(r *request, field string, valid ...string) string {
	value := r.r.URL.Query().Get(field)
	if value == "" {
		return value
	}
	for _, option := range valid {
		if value == option {
			return value
		}
	}
	fail(400, "Некорректный фильтр "+field)
	return ""
}

func adminSearch(r *request) string {
	search := strings.TrimSpace(r.r.URL.Query().Get("q"))
	if !validText(search, 0, 100) {
		fail(400, "Поиск должен содержать до 100 символов")
	}
	return "%" + strings.NewReplacer("\\", "\\\\", "_", "\\_", "%", "\\%").Replace(search) + "%"
}

func adminEvents(r *request) any {
	query := adminSearch(r)
	status := adminFilter(r, "status", "pending", "approved", "rejected", "removed")
	when := adminFilter(r, "when", "upcoming")
	return adminList(r, eventQuery, "e.id", `(?='' OR e.status=?) AND
		(?='' OR u.banned=0 AND u.deleted=0 AND julianday(e.start)>=julianday('now')) AND
		(e.title LIKE ? ESCAPE '\' OR e.sport LIKE ? ESCAPE '\' OR u.name LIKE ? ESCAPE '\' OR CAST(e.id AS TEXT)=?)`,
		status, status, when, query, query, query, strings.TrimSpace(r.r.URL.Query().Get("q")))
}

func adminUsers(r *request) any {
	query := adminSearch(r)
	state := adminFilter(r, "state", "active", "banned", "deleted", "admin")
	return adminList(r, `SELECT id,name,email,role,banned,deleted FROM users`, "id", `
		(?='' OR ?='active' AND banned=0 AND deleted=0 OR ?='banned' AND banned=1 AND deleted=0
		OR ?='deleted' AND deleted=1 OR ?='admin' AND role='admin') AND
		(name LIKE ? ESCAPE '\' OR email LIKE ? ESCAPE '\' OR CAST(id AS TEXT)=?)`,
		state, state, state, state, state, query, query, strings.TrimSpace(r.r.URL.Query().Get("q")))
}

func adminReviews(r *request) any {
	query := adminSearch(r)
	state := adminFilter(r, "state", "visible", "hidden")
	stars := adminFilter(r, "stars", "low", "1", "2", "3", "4", "5")
	return adminList(r, `SELECT r.id,r.event,r.user,r.stars,r.body,e.title eventTitle,u.name author,
		h.review IS NOT NULL hidden,COALESCE(h.reason,'') reason FROM reviews r
		JOIN events e ON e.id=r.event JOIN users u ON u.id=r.user LEFT JOIN hidden_reviews h ON h.review=r.id`, "r.id", `
		(?='' OR ?='hidden' AND h.review IS NOT NULL OR ?='visible' AND h.review IS NULL)
		AND (?='' OR ?='low' AND r.stars<=2 OR CAST(r.stars AS TEXT)=?) AND
		(r.body LIKE ? ESCAPE '\' OR e.title LIKE ? ESCAPE '\' OR u.name LIKE ? ESCAPE '\')`,
		state, state, state, stars, stars, stars, query, query, query)
}

func adminLogs(r *request) any {
	query := adminSearch(r)
	var actor int64
	if raw := r.r.URL.Query().Get("actor"); raw != "" {
		actor = adminNumber(raw, "actor")
	}
	return adminList(r, "SELECT id,at,actor,action,ip,target FROM logs", "id", `
		(?=0 OR actor=?) AND (action LIKE ? ESCAPE '\' OR target LIKE ? ESCAPE '\' OR ip LIKE ? ESCAPE '\')`,
		actor, actor, query, query, query)
}

func adminReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if !validText(reason, 3, 300) {
		fail(400, "Укажите причину от 3 до 300 символов")
	}
	return reason
}

func adminBulkEvents(r *request) any {
	b := body[struct {
		IDs            []int64
		Status, Reason string
	}](r)
	if len(b.IDs) < 1 || len(b.IDs) > 50 {
		fail(400, "Выберите от 1 до 50 событий")
	}
	reason := adminReason(b.Reason)
	validateEventStatus(b.Status)
	seen := make(map[int64]bool, len(b.IDs))
	var updated int
	for _, id := range b.IDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		event := r.one("SELECT id,owner,status FROM events WHERE id=?", id)
		if event == nil {
			fail(404, "Одно из событий не найдено")
		}
		if applyEventStatus(r, event, b.Status) {
			r.audit(b.Status+": "+reason, id)
			updated++
		}
	}
	return row{"updated": updated}
}

func adminRevokeSessions(r *request) any {
	result := r.exec("UPDATE users SET version=version+1 WHERE id=? AND role='user' AND deleted=0", r.id)
	if must(result.RowsAffected()) == 0 {
		fail(404, "Аккаунт участника не найден")
	}
	return nil
}

func adminAdjustPoints(r *request) any {
	b := body[struct {
		Delta             int64
		Reason, RequestID string
	}](r)
	if b.Delta == 0 || b.Delta < -10000 || b.Delta > 10000 || !requestKey.MatchString(b.RequestID) {
		fail(400, "Проверьте сумму и идентификатор операции")
	}
	reason := adminReason(b.Reason)
	if r.one("SELECT id FROM users WHERE id=? AND role='user' AND deleted=0", r.id) == nil {
		fail(404, "Аккаунт участника не найден")
	}
	if previous := r.one("SELECT id,delta,reason FROM point_adjustments WHERE user=? AND request_id=?", r.id, b.RequestID); previous != nil {
		if previous.num("delta") != b.Delta || previous.str("reason") != reason {
			fail(409, "Идентификатор уже использован с другими параметрами")
		}
		return row{"id": previous["id"], "balance": r.balance(r.id)}
	}
	r.syncPoints(r.id)
	if r.balance(r.id)+b.Delta < 0 {
		fail(409, "У пользователя недостаточно баллов")
	}
	id := must(r.exec("INSERT INTO point_adjustments(user,request_id,delta,reason) VALUES(?,?,?,?)",
		r.id, b.RequestID, b.Delta, reason).LastInsertId())
	r.credit(r.id, "admin_adjustment", id, b.Delta)
	r.audit("Баллы "+strconv.FormatInt(b.Delta, 10)+": "+reason, r.id)
	return row{"id": id, "balance": r.balance(r.id)}
}

func adminModerateReview(r *request) any {
	b := body[struct {
		Hidden *bool
		Reason string
	}](r)
	if b.Hidden == nil {
		fail(400, "Укажите hidden")
	}
	reason := adminReason(b.Reason)
	if r.one("SELECT id FROM reviews WHERE id=?", r.id) == nil {
		fail(404, "Отзыв не найден")
	}
	if *b.Hidden {
		r.exec("INSERT INTO hidden_reviews(review,reason) VALUES(?,?) ON CONFLICT(review) DO UPDATE SET reason=excluded.reason", r.id, reason)
		r.audit("Отзыв скрыт: "+reason, r.id)
	} else {
		r.exec("DELETE FROM hidden_reviews WHERE review=?", r.id)
		r.audit("Отзыв восстановлен: "+reason, r.id)
	}
	return nil
}
