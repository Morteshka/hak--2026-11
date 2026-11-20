package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"golang.org/x/crypto/scrypt"
)

const schema = `PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,role TEXT DEFAULT 'user',banned INTEGER DEFAULT 0,birth TEXT,version INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,owner INTEGER REFERENCES users(id),title TEXT,sport TEXT,description TEXT,place TEXT,lat REAL,lng REAL,start TEXT,duration INTEGER,capacity INTEGER,minAge INTEGER,gate TEXT,status TEXT DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY,event INTEGER REFERENCES events(id),user INTEGER REFERENCES users(id),token TEXT UNIQUE,attended INTEGER DEFAULT 0,rank INTEGER,UNIQUE(event,user),UNIQUE(event,rank));
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,event INTEGER REFERENCES events(id),user INTEGER REFERENCES users(id),stars INTEGER,body TEXT,UNIQUE(event,user));
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,at TEXT DEFAULT CURRENT_TIMESTAMP,actor INTEGER,action TEXT,ip TEXT,target TEXT);
CREATE TABLE IF NOT EXISTS moderation_resets(owner INTEGER PRIMARY KEY REFERENCES users(id),last_review INTEGER NOT NULL);
`

type row map[string]any

func (r row) str(key string) string { value, _ := r[key].(string); return value }
func (r row) num(key string) int64  { value, _ := r[key].(int64); return value }

type queryer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}
type store struct {
	context.Context
	queryer
}

func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func (s store) all(query string, args ...any) []row {
	rows := must(s.QueryContext(s.Context, query, args...))
	defer rows.Close()
	names := must(rows.Columns())
	out := []row{}
	for rows.Next() {
		values, ptrs := make([]any, len(names)), make([]any, len(names))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(err)
		}
		next := make(row, len(names))
		for i, name := range names {
			next[name] = values[i]
		}
		out = append(out, next)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

func (s store) one(query string, args ...any) row {
	rows := s.all(query, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
func (s store) exec(query string, args ...any) sql.Result {
	return must(s.ExecContext(s.Context, query, args...))
}
func randomHex(size int) string {
	b := make([]byte, size)
	must(rand.Read(b))
	return hex.EncodeToString(b)
}
func secret(dir, name string, size int) string {
	p := filepath.Join(dir, name)
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		_, writeErr := f.WriteString(randomHex(size))
		closeErr := f.Close()
		if writeErr != nil {
			panic(writeErr)
		}
		if closeErr != nil {
			panic(closeErr)
		}
	} else if !os.IsExist(err) {
		panic(err)
	}
	return strings.TrimSpace(string(must(os.ReadFile(p))))
}
func derivePassword(password, salt string) []byte {
	return must(scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 64))
}
func passwordHash(password string) string {
	salt := randomHex(16)
	return salt + ":" + hex.EncodeToString(derivePassword(password, salt))
}
func passwordMatches(password, stored string) bool {
	salt, digest, ok := strings.Cut(stored, ":")
	if !ok {
		return false
	}
	decoded, err := hex.DecodeString(digest)
	return err == nil && subtle.ConstantTimeCompare(decoded, derivePassword(password, salt)) == 1
}

var sports = []string{"Бег", "Баскетбол", "Йога", "Футбол"}
var moscow = time.FixedZone("Europe/Moscow", 3*60*60)

func openDB(dir string) *sql.DB {
	db := must(sql.Open("sqlite3", filepath.Join(dir, "temp.sqlite")))
	// A single connection serializes SQLite writes and keeps connection-local PRAGMAs consistent.
	db.SetMaxOpenConns(1)
	s := store{context.Background(), db}
	s.exec("PRAGMA busy_timeout=5000")
	s.exec(schema)
	tx := must(db.Begin())
	defer tx.Rollback()
	s.queryer = tx
	if s.one("SELECT id FROM users WHERE role='admin' LIMIT 1") == nil {
		password := os.Getenv("ADMIN_PASSWORD")
		if password == "" {
			password = secret(dir, "admin-password", 16)
		}
		s.exec("INSERT INTO users(name,email,hash,role) VALUES(?,?,?,'admin')",
			"Администратор", strings.ToLower(env("ADMIN_EMAIL", "admin@temp.local")), passwordHash(password))
	}
	if os.Getenv("SEED_DEMO") != "0" && s.one("SELECT id FROM users WHERE email='club@seed.invalid'") == nil {
		s.seed()
	}
	if err := tx.Commit(); err != nil {
		panic(err)
	}
	return db
}

func (s store) seed() {
	owner := must(s.exec("INSERT INTO users(name,email,hash) VALUES(?,?,?)", "Команда Темпа", "club@seed.invalid", passwordHash(randomHex(32))).LastInsertId())
	fixtures := []struct {
		title, place, description, gate string
		lat, lng                        float64
		hour, duration, limit           int
	}{
		{"Утренний бег по набережной", "Набережная Дона", "Лёгкая разминка и совместная пробежка вдоль Дона. Подойдёт любой темп.", "qr", 47.2138, 39.7172, 8, 60, 20},
		{"Стритбол 3×3", "Парк Левобережный", "Собираемся на открытой площадке, делимся на тройки и играем короткие матчи.", "ticket", 47.2036, 39.7392, 18, 90, 18},
		{"Йога в парке", "Парк Горького", "Спокойная практика на свежем воздухе. Возьмите коврик и воду.", "open", 47.2202, 39.7095, 10, 60, 15},
		{"Футбол на выходных", "Парк Островского", "Товарищеская игра с разминкой. Команды составим на площадке.", "qr", 47.2528, 39.7661, 16, 90, 22},
	}
	for i, e := range fixtures {
		date := time.Now().In(moscow).AddDate(0, 0, i+1)
		start := time.Date(date.Year(), date.Month(), date.Day(), e.hour, 0, 0, 0, moscow).UTC()
		s.exec("INSERT INTO events(owner,title,sport,description,place,lat,lng,start,duration,capacity,minAge,gate,status) VALUES(?,?,?,?,?,?,?,?,?,?,12,?,'approved')",
			owner, e.title, sports[i], e.description, e.place, e.lat, e.lng, formatTime(start), e.duration, e.limit, e.gate)
	}
}

const eventQuery = "SELECT e.*,u.name organizer,(SELECT count(*) FROM tickets t WHERE t.event=e.id) booked FROM events e JOIN users u ON u.id=e.owner"

func formatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func startTime(e row) time.Time     { return must(time.Parse(time.RFC3339Nano, e.str("start"))) }
func expired(e row) bool {
	return !time.Now().Before(startTime(e).Add(time.Duration(e.num("duration")) * time.Minute))
}

func (s store) profile(id int64) row {
	user := s.one("SELECT id,name,email,role,birth FROM users WHERE id=?", id)
	created := s.all("SELECT * FROM events WHERE owner=? ORDER BY start DESC", id)
	tickets := s.all("SELECT t.*,e.title,e.start,e.sport,e.duration,CASE WHEN u.banned=1 THEN 'removed' ELSE e.status END status,e.gate FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=e.owner WHERE t.user=? ORDER BY e.start DESC", id)
	achievements := []row{}
	held, attended, xp := 0, 0, 0
	for _, e := range created {
		if e.str("status") == "approved" && expired(e) {
			held++
			xp += 100
		}
	}
	for _, t := range tickets {
		if t.num("attended") == 0 {
			continue
		}
		attended++
		xp += 100
		achievements = append(achievements, row{"event": t["event"], "title": t["title"], "kind": "participant", "rank": nil})
		if rank := t.num("rank"); rank >= 1 && rank <= 3 {
			xp += [3]int{150, 100, 50}[rank-1]
			achievements = append(achievements, row{"event": t["event"], "title": t["title"], "kind": "podium", "rank": rank})
		}
	}
	user["created"], user["tickets"], user["achievements"] = created, tickets, achievements
	user["held"], user["attended"], user["xp"], user["level"] = held, attended, xp, 1+xp/300
	return user
}
