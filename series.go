package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

const seriesSchema = `
CREATE TABLE IF NOT EXISTS event_series (
 id INTEGER PRIMARY KEY,
 owner INTEGER NOT NULL REFERENCES users(id),
 title TEXT NOT NULL,
 sport TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_series_owner ON event_series(owner);
CREATE TABLE IF NOT EXISTS event_editions (
 event INTEGER PRIMARY KEY REFERENCES events(id),
 series INTEGER NOT NULL REFERENCES event_series(id)
);
CREATE INDEX IF NOT EXISTS event_editions_series ON event_editions(series);
`

type seriesInput struct {
	SeriesID    int64
	SeriesTitle string
}

func (r *request) linkEdition(event row, input seriesInput) row {
	title := strings.TrimSpace(input.SeriesTitle)
	if input.SeriesID < 0 || (input.SeriesID != 0 && title != "") || (title != "" && !validText(title, 3, 100)) {
		fail(400, "Выберите серию или укажите новое название длиной 3–100 символов")
	}
	if input.SeriesID == 0 && title == "" {
		fail(400, "Укажите серию")
	}
	owner, sport := event.num("owner"), event.str("sport")
	current := r.one("SELECT series FROM event_editions WHERE event=?", event["id"])
	if current != nil {
		if current.num("series") == input.SeriesID {
			return row{"seriesId": input.SeriesID}
		}
		fail(409, "Выпуск уже относится к серии")
	}
	id := input.SeriesID
	if id == 0 {
		id = must(r.exec("INSERT INTO event_series(owner,title,sport) VALUES(?,?,?)", owner, title, sport).LastInsertId())
	} else {
		series := r.one("SELECT owner,sport FROM event_series WHERE id=?", id)
		if series == nil || series.num("owner") != owner {
			fail(404, "Серия не найдена")
		}
		if series.str("sport") != sport {
			fail(409, "Вид спорта выпуска должен совпадать с серией")
		}
	}
	r.exec("INSERT INTO event_editions(event,series) VALUES(?,?)", event["id"], id)
	return row{"seriesId": id}
}

func seriesDetail(r *request) any {
	series := r.one("SELECT s.*,u.name organizer FROM event_series s JOIN users u ON u.id=s.owner WHERE s.id=? AND u.banned=0 AND u.deleted=0", r.id)
	if series == nil {
		fail(404, "Серия не найдена")
	}
	editions := r.all("SELECT e.id,e.title,e.start,e.place,e.duration,(SELECT count(*) FROM tickets t WHERE t.event=e.id AND t.attended=1) attended FROM event_editions m JOIN events e ON e.id=m.event WHERE m.series=? AND e.status='approved' ORDER BY e.start,e.id", r.id)
	if len(editions) == 0 && !r.manages(series) {
		fail(404, "В серии нет опубликованных выпусков")
	}
	years := make(map[int]bool)
	firstYear := 0
	for position, e := range editions {
		year := startTime(e).In(moscow).Year()
		if firstYear == 0 {
			firstYear = year
		}
		e["edition"], e["year"], e["seriesYear"], e["completed"] = position+1, year, year-firstYear+1, expired(e)
		if expired(e) {
			years[year] = true
		}
	}
	series["city"], series["firstYear"], series["yearsHeld"], series["editions"] = rewardCity, firstYear, len(years), editions
	return series
}

func rankingPeriod(r *request) (string, []any) {
	value := r.r.URL.Query().Get("year")
	if value == "" {
		return "", nil
	}
	year, err := strconv.Atoi(value)
	if err != nil || len(value) != 4 || year < 1900 || year > time.Now().In(moscow).Year() {
		fail(400, "Укажите год от 1900 до текущего года")
	}
	return " AND strftime('%Y',e.start,'+3 hours')=?", []any{value}
}

func organizerRanking(r *request) any {
	period, args := rankingPeriod(r)
	from := " FROM events e JOIN users u ON u.id=e.owner WHERE u.banned=0 AND u.deleted=0 AND " + qualifyingEvents
	years := r.all("SELECT DISTINCT CAST(strftime('%Y',e.start,'+3 hours') AS INTEGER) year" + from + " ORDER BY year DESC")
	return row{"city": rewardCity, "totalEvents": r.one("SELECT count(*) n"+from+period, args...).num("n"),
		"organizers": r.all("SELECT u.id,u.name,count(*) events"+from+period+" GROUP BY u.id,u.name ORDER BY events DESC,u.id LIMIT 30", args...),
		"years":      years}
}

func (a *application) seriesRoutes(mux *http.ServeMux) {
	a.route(mux, "GET /api/series/mine", "", "user", func(r *request) any {
		return r.all("SELECT id,title,sport FROM event_series WHERE owner=? ORDER BY title,id", r.user["id"])
	})
	a.route(mux, "GET /api/series/{id}", "", "", seriesDetail)
	a.route(mux, "GET /api/series/leaderboard", "", "", func(r *request) any {
		period, args := rankingPeriod(r)
		return r.all("SELECT s.id,s.title,s.sport,s.owner,u.name organizer,count(*) events,COUNT(DISTINCT strftime('%Y',e.start,'+3 hours')) years FROM event_series s JOIN users u ON u.id=s.owner JOIN event_editions m ON m.series=s.id JOIN events e ON e.id=m.event WHERE u.banned=0 AND u.deleted=0 AND "+qualifyingEvents+period+
			" GROUP BY s.id ORDER BY events DESC,years DESC,s.id LIMIT 30", args...)
	})
	a.route(mux, "PUT /api/events/{id}/series", "Привязка выпуска к серии", "user", func(r *request) any {
		event := r.ownEvent()
		return r.linkEdition(event, body[seriesInput](r))
	})
}
