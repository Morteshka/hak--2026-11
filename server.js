import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import https from "node:https";
import { isIP } from "node:net";
import selfsigned from "selfsigned";
import { completeContract } from "./contract.js";
import {
  db,
  dir,
  secret,
  one,
  all,
  run,
  hash,
  check,
  sports,
  eventQuery,
  profile,
} from "./db.js";

const app = express(),
  key = process.env.JWT_SECRET || secret("jwt-key");
const secure = process.env.HTTPS !== "0",
  port = Number(process.env.PORT || 3443);
app.disable("x-powered-by");
const mapKey = (process.env.YANDEX_MAPS_API_KEY || "").trim();
const mapHosts = mapKey ? ["https://api-maps.yandex.ru", "https://*.api-maps.yandex.ru",
  "https://*.maps.yandex.net", "https://suggest-maps.yandex.ru", "https://yandex.ru", "https://yastatic.net"] : [];
app.use(
  helmet({
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'", ...mapHosts],
        "frame-src": ["'self'", "https://yandex.ru", "https://api-maps.yandex.ru"],
        "connect-src": ["'self'", ...mapHosts],
        "style-src": ["'self'", "'unsafe-inline'", "blob:"],
        "img-src": [
          "'self'",
          "data:",
          "blob:",
          "https://tile.openstreetmap.org",
          ...mapHosts,
        ],
        "media-src": ["'self'", "blob:"],
        "upgrade-insecure-requests": secure ? [] : null,
      },
    },
    strictTransportSecurity: false,
  }),
  express.json({ limit: "32kb" }),
);
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host)
        return res.status(403).json({ error: "Недопустимый источник запроса" });
    } catch {
      return res.sendStatus(403);
    }
  }
  const token =
    req.headers.authorization?.replace(/^Bearer /, "") ||
    req.headers.cookie?.match(/(?:^|; )session=([^;]+)/)?.[1];
  try {
    const c = jwt.verify(token, key, { algorithms: ["HS256"], issuer: "temp" });
    req.user = one(
      "SELECT * FROM users WHERE id=? AND version=? AND banned=0 AND deleted=0",
      c.sub,
      c.v,
    );
  } catch {}
  next();
});
app.use(
  ["/api/login", "/api/register"],
  rateLimit({
    windowMs: 900000,
    limit: 40,
    message: { error: "Слишком много попыток. Попробуйте позже." },
  }),
);
const spec = {
  openapi: "3.1.0",
  info: { title: "Темп · API", version: "1.0.0" },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  paths: {},
};
const fail = (code, message) => {
  throw Object.assign(new Error(message), { status: code });
};
const log = (r, action, target = "") =>
  run(
    "INSERT INTO logs(actor,action,ip,target) VALUES(?,?,?,?)",
    r.user?.id || null,
    action,
    r.socket.remoteAddress || "",
    String(target),
  );
function api(method, path, title, access, schema, fn) {
  const url = "/api" + path,
    route = url.replace(/:(\w+)/g, "{$1}");
  (spec.paths[route] ??= {})[method] = {
    summary: title,
    tags: [access === "admin" ? "Администрирование" : "Платформа"],
    security: access ? [{ bearer: [] }] : [],
    parameters: [...path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "integer" },
    })),
    ...(schema
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: z.toJSONSchema(schema, {
                  io: "input",
                  unrepresentable: "any",
                }),
              },
            },
          },
        }
      : {}),
    responses: {
      200: { description: "Успешно" },
      400: { description: "Ошибка данных" },
      403: { description: "Доступ ограничен" },
    },
  };
  app[method](url, async (r, s) => {
    if (access && !r.user) fail(401, "Войдите в аккаунт");
    if (access === "admin" && r.user.role !== "admin")
      fail(403, "Требуются права администратора");
    const parsed = schema?.safeParse(r.body);
    if (parsed && !parsed.success)
      fail(
        400,
        "Проверьте поля: " +
          parsed.error.issues.map((i) => i.path.join(".")).join(", "),
      );
    let result;
    if (method === "get") result = await fn(r, parsed?.data, s);
    else {
      db.exec("BEGIN IMMEDIATE");
      try {
        result = fn(r, parsed?.data, s);
        log(r, title, r.params.id || "");
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    if (!s.headersSent) s.json(result ?? { ok: true });
  });
}
const str = (min, max) => z.string().trim().min(min).max(max),
  int = (min, max) => z.number().int().min(min).max(max);
const mail = z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  pw = z.string().min(10).max(128);
const cookie = { httpOnly: true, secure, sameSite: "strict", path: "/" };
function login(r, s, u) {
  const token = jwt.sign({ v: u.version }, key, {
    algorithm: "HS256",
    issuer: "temp",
    subject: String(u.id),
    expiresIn: "2h",
  });
  r.user = u;
  s.cookie("session", token, { ...cookie, maxAge: 7200000 });
  return { token, id: u.id, name: u.name, role: u.role };
}
api(
  "post",
  "/register",
  "Регистрация",
  null,
  z.object({
    name: str(2, 60),
    birth: z.iso.date(),
    email: mail,
    password: pw,
  }),
  (r, b, s) => {
    if (
      b.birth > new Date().toISOString().slice(0, 10) ||
      b.birth < "1900-01-01"
    )
      fail(400, "Проверьте дату рождения");
    if (one("SELECT id FROM users WHERE email=?", b.email))
      fail(409, "Электронная почта уже используется");
    const id = run(
      "INSERT INTO users(name,birth,email,hash) VALUES(?,?,?,?)",
      b.name,
      b.birth,
      b.email,
      hash(b.password),
    ).lastInsertRowid;
    return login(r, s, one("SELECT * FROM users WHERE id=?", id));
  },
);
api(
  "post",
  "/login",
  "Вход",
  null,
  z.object({ email: mail, password: z.string().min(1).max(128) }),
  (r, b, s) => {
    const u = one("SELECT * FROM users WHERE email=? AND deleted=0", b.email);
    if (!u || !check(b.password, u.hash) || u.banned)
      fail(401, "Неверные данные или доступ ограничен");
    return login(r, s, u);
  },
);
api("post", "/logout", "Выход", "user", null, (r, b, s) => {
  run("UPDATE users SET version=version+1 WHERE id=?", r.user.id);
  s.clearCookie("session", cookie);
});
api("get", "/me", "Профиль и билеты", "user", null, (r) => profile(r.user.id));
api("get", "/events", "Афиша", null, null, () =>
  all(
    eventQuery +
      " WHERE e.status='approved' AND u.banned=0 AND u.deleted=0 ORDER BY e.start",
  ),
);
const event = (id) =>
  one(eventQuery + " WHERE e.id=?", id) || fail(404, "Событие не найдено");
function owner(r) {
  const e = event(r.params.id);
  if (e.owner !== r.user.id && r.user.role !== "admin")
    fail(403, "Только для организатора");
  return e;
}
const ended = (e) => Date.now() >= Date.parse(e.start) + e.duration * 60000;
api("get", "/events/:id", "Карточка события", null, null, (r) => {
  const e = event(r.params.id);
  if (
    (e.status !== "approved" ||
      one("SELECT banned FROM users WHERE id=?", e.owner).banned) &&
    r.user?.id !== e.owner &&
    r.user?.role !== "admin"
  )
    fail(404, "Событие недоступно");
  return {
    ...e,
    reviews: all(
      "SELECT r.stars,r.body,u.name FROM reviews r JOIN users u ON u.id=r.user WHERE event=? ORDER BY r.id DESC",
      e.id,
    ),
  };
});
const fields = z.object({
  title: str(3, 100),
  sport: z.enum(sports),
  description: str(10, 2000),
  place: str(3, 150),
  lat: z.number().min(47.1).max(47.36),
  lng: z.number().min(39.52).max(39.92),
  start: z.iso.datetime(),
  duration: int(5, 1440),
  capacity: int(1, 5000),
  minAge: int(0, 100),
  gate: z.enum(["open", "ticket", "qr"]),
});
api("post", "/events", "Заявка на проведение", "user", fields, (r, b) => {
  if (Date.parse(b.start) <= Date.now()) fail(400, "Выберите будущее время");
  const id = run(
    "INSERT INTO events(owner,title,sport,description,place,lat,lng,start,duration,capacity,minAge,gate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    r.user.id,
    b.title,
    b.sport,
    b.description,
    b.place,
    b.lat,
    b.lng,
    b.start,
    b.duration,
    b.capacity,
    b.minAge,
    b.gate,
  ).lastInsertRowid;
  return { id: Number(id), status: "pending" };
});
api("post", "/events/:id/join", "Запись на мероприятие", "user", null, (r) => {
  const e = event(r.params.id);
  if (
    e.status !== "approved" ||
    one("SELECT banned FROM users WHERE id=?", e.owner).banned ||
    Date.parse(e.start) <= Date.now() ||
    e.owner === r.user.id
  )
    fail(409, "Запись недоступна");
  if (one("SELECT id FROM tickets WHERE event=? AND user=?", e.id, r.user.id))
    fail(409, "Вы уже записаны");
  if (e.booked >= e.capacity) fail(409, "Свободных мест нет");
  const on = new Date(Date.parse(e.start) + 10800000)
      .toISOString()
      .slice(0, 10),
    birth = r.user.birth;
  if (
    e.minAge &&
    (!birth ||
      Number(on.slice(0, 4)) -
        Number(birth.slice(0, 4)) -
        (on.slice(5) < birth.slice(5)) <
        e.minAge)
  )
    fail(403, "Возрастное ограничение");
  run(
    "INSERT INTO tickets(event,user,token) VALUES(?,?,?)",
    e.id,
    r.user.id,
    randomBytes(20).toString("hex"),
  );
  return { event: e.id };
});
api("delete", "/events/:id/join", "Отмена записи", "user", null, (r) => {
  const e = event(r.params.id);
  if (Date.now() >= Date.parse(e.start)) fail(409, "Событие уже началось");
  if (one("SELECT id FROM tickets WHERE event=? AND user=? AND attended=1",e.id,r.user.id))
    fail(409, "Посещение уже подтверждено");
  run(
    "DELETE FROM tickets WHERE event=? AND user=? AND attended=0",
    e.id,
    r.user.id,
  );
});
api(
  "get",
  "/tickets/:id/qr",
  "QR-код билета",
  "user",
  null,
  async (r, b, s) => {
    const t =
      one(
        "SELECT t.token FROM tickets t JOIN events e ON e.id=t.event JOIN users u ON u.id=e.owner WHERE t.id=? AND t.user=? AND t.attended=0 AND e.gate='qr' AND e.status='approved' AND u.banned=0 AND julianday(e.start)+e.duration/1440.0>julianday('now')",
        r.params.id,
        r.user.id,
      ) || fail(404, "Билет не найден");
    s.type("png").send(await QRCode.toBuffer(t.token));
  },
);
api("get", "/events/:id/roster", "Участники", "user", null, (r) => {
  owner(r);
  return all(
    "SELECT t.id,t.user,t.attended,t.rank,u.name FROM tickets t JOIN users u ON u.id=t.user WHERE t.event=?",
    r.params.id,
  );
});
api(
  "post",
  "/events/:id/checkin",
  "Подтверждение прихода",
  "user",
  z.object({
    token: str(1, 80).optional(),
    ticket: int(1, 2147483647).optional(),
  }),
  (r, b) => {
    const e = owner(r);
    if (
      e.status !== "approved" ||
      ended(e) ||
      Date.now() < Date.parse(e.start) - 3600000
    )
      fail(409, "Отметка доступна за час до начала и во время события");
    const byList = e.gate === "open" || (e.gate === "ticket" && b.ticket);
    const t = byList
      ? one("SELECT * FROM tickets WHERE event=? AND id=?", e.id, b.ticket || 0)
      : one(
          "SELECT * FROM tickets WHERE event=? AND token=?",
          e.id,
          b.token || "",
        );
    if (!t || one("SELECT banned FROM users WHERE id=?", t.user).banned)
      fail(404, "Билет недействителен");
    if (t.attended) fail(409, "Участник уже отмечен");
    run("UPDATE tickets SET attended=1 WHERE id=?", t.id);
    return { name: one("SELECT name FROM users WHERE id=?", t.user).name };
  },
);
api(
  "post",
  "/events/:id/awards",
  "Присуждение места",
  "user",
  z.object({ ticket: int(1, 2147483647), rank: int(1, 3) }),
  (r, b) => {
    const e = owner(r);
    if (!ended(e) || e.status !== "approved")
      fail(409, "Дождитесь окончания события");
    if (
      one(
        "SELECT id FROM tickets WHERE event=? AND rank=? AND id<>?",
        e.id,
        b.rank,
        b.ticket,
      )
    )
      fail(409, "Место уже присуждено");
    if (
      !run(
        "UPDATE tickets SET rank=? WHERE id=? AND event=? AND attended=1",
        b.rank,
        b.ticket,
        e.id,
      ).changes
    )
      fail(400, "Участие не подтверждено");
  },
);
api(
  "post",
  "/events/:id/reviews",
  "Отзыв участника",
  "user",
  z.object({ stars: int(1, 5), body: str(5, 1500) }),
  (r, b) => {
    const e = event(r.params.id);
    if (
      !ended(e) ||
      e.status !== "approved" ||
      !one(
        "SELECT id FROM tickets WHERE user=? AND event=? AND attended=1",
        r.user.id,
        e.id,
      )
    )
      fail(403, "Отзыв доступен участникам после окончания");
    if (one("SELECT id FROM reviews WHERE user=? AND event=?", r.user.id, e.id))
      fail(409, "Отзыв уже опубликован");
    run(
      "INSERT INTO reviews(event,user,stars,body) VALUES(?,?,?,?)",
      e.id,
      r.user.id,
      b.stars,
      b.body,
    );
    if(b.stars>2) return;
    const stats = one(
      "SELECT count(DISTINCT r.user) people,count(DISTINCT e.id) events FROM reviews r JOIN events e ON e.id=r.event LEFT JOIN moderation_resets m ON m.owner=e.owner WHERE e.owner=? AND r.id>COALESCE(m.last_review,0) AND r.stars<=2",
      e.owner,
    );
    if (stats.people >= 3 && stats.events >= 2) {
      const updated=run(
        "UPDATE users SET banned=1,version=version+1 WHERE role='user' AND banned=0 AND id=?",
        e.owner,
      );
      if(updated.changes){
        run("DELETE FROM tickets WHERE user=? AND attended=0",e.owner);
        log(r, "Автоблокировка по отзывам", e.owner);
      }
    }
  },
);
api("get", "/admin", "Панель администратора", "admin", null, () => ({
  events: all(eventQuery + " ORDER BY e.id DESC"),
  users: all(
    "SELECT id,name,email,role,banned,deleted FROM users ORDER BY id DESC",
  ),
  logs: all("SELECT * FROM logs ORDER BY id DESC LIMIT 500"),
}));
api(
  "post",
  "/admin/events/:id",
  "Модерация события",
  "admin",
  z.object({ status: z.enum(["approved", "rejected", "removed"]) }),
  (r, b) => {
    event(r.params.id);
    run("UPDATE events SET status=? WHERE id=?", b.status, r.params.id);
    log(r, b.status, r.params.id);
  },
);
api(
  "post",
  "/admin/users/:id",
  "Управление пользователем",
  "admin",
  z.object({ action: z.enum(["ban", "unban", "delete"]) }),
  (r, b) => {
    const u =
      one(
        "SELECT id,banned FROM users WHERE id=? AND role='user' AND deleted=0",
        r.params.id,
      ) || fail(403, "Действие недоступно");
    if(b.action==="unban" && u.banned){
      run("INSERT OR REPLACE INTO moderation_resets(owner,last_review) SELECT ?,COALESCE(MAX(id),0) FROM reviews",u.id);
    }
    if (b.action === "delete") {
      run(
        "UPDATE users SET name='Удалённый участник',email=?,birth=NULL,deleted=1 WHERE id=?",
        randomBytes(16).toString("hex") + "@removed.invalid",
        u.id,
      );
      run("UPDATE events SET status='removed' WHERE owner=?", u.id);
    }
    run(
      "UPDATE users SET banned=?,version=version+1 WHERE id=?",
      Number(b.action !== "unban"),
      u.id,
    );
    if (b.action !== "unban")
      run("DELETE FROM tickets WHERE user=? AND attended=0", u.id);
    log(r, b.action, u.id);
  },
);
completeContract(spec);
app.get("/api/openapi.json", (r, s) => s.json(spec));
app.use("/api", (r, s) => s.status(404).json({ error: "Метод не найден" }));
app.use("/vendor/map", express.static("node_modules/leaflet/dist"));
app.use("/vendor/swagger", express.static("node_modules/swagger-ui-dist"));
app.use("/vendor/icon", express.static("node_modules/lucide-static/icons"));
app.get("/vendor/scanner.js", (r, s) =>
  s.sendFile("node_modules/html5-qrcode/html5-qrcode.min.js", { root: "." }),
);
app.get("/docs", (r, s) =>
  s.send(
    '<meta charset=utf-8><title>Темп · Swagger API</title><link rel="stylesheet" href="/vendor/swagger/swagger-ui.css"><div id="swagger"></div><script src="/vendor/swagger/swagger-ui-bundle.js"></script><script src="/static/docs.js"></script>',
  ),
);
app.use("/static", express.static("static", { index: false }));
app.get("/robots.txt", (r, s) =>
  s
    .type("text")
    .send(
      "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /profile\nDisallow: /api/\n",
    ),
);
const esc = (v) =>
  String(v).replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const titles = {
  "/": "Афиша событий",
  "/map": "Карта событий",
  "/create": "Создать событие",
  "/profile": "Мой профиль",
  "/login": "Вход",
  "/register": "Регистрация",
  "/thanks": "Спасибо за заявку",
  "/admin": "Администрирование",
  "/privacy": "Политика конфиденциальности",
};
app.get("/{*path}", (r, s) => {
  const e = /^\/events\/\d+$/.test(r.path)
    ? one(
        eventQuery + " WHERE e.id=? AND e.status='approved' AND u.banned=0",
        r.path.split("/")[2],
      )
    : null;
  const title = e?.title || titles[r.path] || "Страница не найдена",
    desc =
      e?.description ||
      title + " — спортивные встречи в Ростове-на-Дону на платформе Темп.";
  const origin =
    process.env.PUBLIC_ORIGIN || r.protocol + "://" + r.get("host");
  const ld = e
    ? {
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        name: e.title,
        startDate: e.start,
        description: e.description,
        location: {
          "@type": "Place",
          name: e.place,
          address: "Ростов-на-Дону, " + e.place,
        },
      }
    : {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Темп",
        url: origin,
      };
  s.status(titles[r.path] || e ? 200 : 404).send(
    readFileSync("index.html", "utf8")
      .replace("__MAP_KEY__", () => esc(mapKey))
      .replaceAll("__TITLE__", () => esc(title))
      .replaceAll("__DESC__", () => esc(desc))
      .replace("__IMAGE__", () => esc(origin + "/static/media/hero.jpg"))
      .replace("__LD__", () => JSON.stringify(ld).replace(/</g, "\\u003c")),
  );
});
app.use((err, r, s, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  s.status(status).json({
    error: status >= 500 ? "Ошибка сервера" : err.message,
  });
});
let server;
if (secure) {
  let tls;
  if (process.env.TLS_CERT && process.env.TLS_KEY)
    tls = {
      cert: readFileSync(process.env.TLS_CERT),
      key: readFileSync(process.env.TLS_KEY),
    };
  else {
    const file = dir + "/local-tls.json";
    if (!existsSync(file)) {
      const publicIp = process.env.TLS_PUBLIC_IP;
      if (publicIp && !isIP(publicIp)) throw new Error("TLS_PUBLIC_IP должен быть IP-адресом");
      const p = selfsigned.generate(
        [{ name: "commonName", value: publicIp || "localhost" }],
        {
          days: 365,
          keySize: 2048,
          algorithm: "sha256",
          extensions: [
            {
              name: "subjectAltName",
              altNames: [
                { type: 2, value: "localhost" },
                { type: 7, ip: "127.0.0.1" },
                ...(publicIp ? [{ type: 7, ip: publicIp }] : []),
              ],
            },
          ],
        },
      );
      writeFileSync(file, JSON.stringify({ cert: p.cert, key: p.private }), {
        mode: 0o600,
      });
    }
    tls = JSON.parse(readFileSync(file));
  }
  server = https.createServer(tls, app);
} else server = (await import("node:http")).createServer(app);
server.listen(port, process.env.BIND || "127.0.0.1", () =>
  console.log("Темп · " + (secure ? "https" : "http") + "://localhost:" + port),
);
