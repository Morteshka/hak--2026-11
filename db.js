import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const dir = path.resolve(process.env.DATA_DIR || "data");
mkdirSync(dir, { recursive: true, mode: 0o700 });
export function secret(name, bytes = 32) {
  const file = path.join(dir, name);
  if (!existsSync(file))
    writeFileSync(file, randomBytes(bytes).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  return readFileSync(file, "utf8").trim();
}
export const db = new DatabaseSync(path.join(dir, "temp.sqlite"));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,role TEXT DEFAULT 'user',banned INTEGER DEFAULT 0,birth TEXT,version INTEGER DEFAULT 0,deleted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,owner INTEGER REFERENCES users(id),title TEXT,sport TEXT,description TEXT,place TEXT,lat REAL,lng REAL,start TEXT,duration INTEGER,capacity INTEGER,minAge INTEGER,gate TEXT,status TEXT DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY,event INTEGER REFERENCES events(id),user INTEGER REFERENCES users(id),token TEXT UNIQUE,attended INTEGER DEFAULT 0,rank INTEGER,UNIQUE(event,user),UNIQUE(event,rank));
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,event INTEGER REFERENCES events(id),user INTEGER REFERENCES users(id),stars INTEGER,body TEXT,UNIQUE(event,user));
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,at TEXT DEFAULT CURRENT_TIMESTAMP,actor INTEGER,action TEXT,ip TEXT,target TEXT);
CREATE TABLE IF NOT EXISTS moderation_resets(owner INTEGER PRIMARY KEY REFERENCES users(id),last_review INTEGER NOT NULL);
`);
export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export function hash(pass) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(pass, salt, 64).toString("hex");
}
export function check(pass, stored) {
  const [salt, digest] = stored.split(":");
  return timingSafeEqual(
    Buffer.from(digest, "hex"),
    scryptSync(pass, salt, 64),
  );
}
export const sports = ["Бег", "Баскетбол", "Йога", "Футбол"];
if (!one("SELECT id FROM users WHERE role='admin'")) {
  run(
    "INSERT INTO users(name,email,hash,role) VALUES(?,?,?,'admin')",
    "Администратор",
    process.env.ADMIN_EMAIL || "admin@temp.local",
    hash(process.env.ADMIN_PASSWORD || secret("admin-password", 16)),
  );
}
if (
  !one("SELECT id FROM users WHERE email='club@seed.invalid'") &&
  process.env.SEED_DEMO !== "0"
) {
  db.exec("BEGIN");
  try {
    const owner = Number(
      run(
        "INSERT INTO users(name,email,hash) VALUES(?,?,?)",
        "Команда Темпа",
        "club@seed.invalid",
        hash(randomBytes(32).toString("hex")),
      ).lastInsertRowid,
    );
    const rows = [
      [
        "Утренний бег по набережной",
        0,
        "Набережная Дона",
        47.2138,
        39.7172,
        8,
        60,
        20,
      ],
      ["Стритбол 3×3", 1, "Парк Левобережный", 47.2036, 39.7392, 18, 90, 18],
      ["Йога в парке", 2, "Парк Горького", 47.2202, 39.7095, 10, 60, 15],
      [
        "Футбол на выходных",
        3,
        "Парк Островского",
        47.2528,
        39.7661,
        16,
        90,
        22,
      ],
    ];
    rows.forEach(([title, s, place, lat, lng, h, duration, capacity], i) => {
      const start = new Date(Date.now() + (i + 1) * 86400000);
      start.setUTCHours(h - 3, 0, 0, 0);
      run(
        "INSERT INTO events(owner,title,sport,description,place,lat,lng,start,duration,capacity,minAge,gate,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'approved')",
        owner,
        title,
        sports[s],
        [
          "Лёгкая разминка и совместная пробежка вдоль Дона. Подойдёт любой темп.",
          "Собираемся на открытой площадке, делимся на тройки и играем короткие матчи.",
          "Спокойная практика на свежем воздухе. Возьмите коврик и воду.",
          "Товарищеская игра с разминкой. Команды составим на площадке.",
        ][i],
        place,
        lat,
        lng,
        start.toISOString(),
        duration,
        capacity,
        12,
        ["qr", "ticket", "open", "qr"][i],
      );
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export const eventQuery = `SELECT e.*,u.name organizer,(SELECT count(*) FROM tickets t WHERE t.event=e.id) booked FROM events e JOIN users u ON u.id=e.owner`;
export function profile(id) {
  const user = one("SELECT id,name,email,role,birth FROM users WHERE id=?", id);
  const created = all(
    "SELECT * FROM events WHERE owner=? ORDER BY start DESC",
    id,
  );
  const tickets = all(
    "SELECT t.*,e.title,e.start,e.sport,e.duration,CASE WHEN u.banned=1 THEN 'removed' ELSE e.status END status,e.gate FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=e.owner WHERE t.user=? ORDER BY e.start DESC",
    id,
  );
  const attended = tickets.filter((t) => t.attended);
  const held = created.filter(
    (e) =>
      e.status === "approved" &&
      +new Date(e.start) + e.duration * 60000 <= Date.now(),
  ).length;
  const xp =
    attended.reduce((sum, t) => sum + 100 + [0, 150, 100, 50][t.rank || 0], 0) +
    held * 100;
  const achievements = attended.flatMap((t) => {
    const entry = { event: t.event, title: t.title };
    const badges = [{ ...entry, kind: "participant", rank: null }];
    if (t.rank) badges.push({ ...entry, kind: "podium", rank: t.rank });
    return badges;
  });
  return {
    ...user,
    created,
    tickets,
    achievements,
    attended: attended.length,
    held,
    xp,
    level: 1 + Math.floor(xp / 300),
  };
}
