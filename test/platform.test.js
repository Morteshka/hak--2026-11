import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";

test("Полный цикл события, границы доступа и журнал", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "temp-sport-"));
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const password = randomBytes(16).toString("hex");
  const child = spawn(process.env.TEST_SERVER_BIN || "temp", [], {
    env: {
      ...process.env,
      PORT: String(port),
      BIND: "127.0.0.1",
      HTTPS: "0",
      DATA_DIR: dir,
      ADMIN_EMAIL: "admin@example.org",
      ADMIN_PASSWORD: password,
      SEED_DEMO: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stopped = once(child, "exit");
  t.after(async () => {
    child.kill();
    await stopped;
    rmSync(dir, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, "data"),
    stopped.then(() => {
      throw Error("Server exited");
    }),
  ]);
  const base = "http://127.0.0.1:" + port;
  async function req(path, method = "GET", token, body, expected = 200) {
    const res = await fetch(base + "/api" + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.headers.get("content-type").includes("image/png")
      ? Buffer.from(await res.arrayBuffer())
      : await res.json();
    assert.equal(
      res.status,
      expected,
      path + " " + JSON.stringify(data).slice(0, 200),
    );
    return data;
  }
  const admin = (
    await req("/login", "POST", null, { email: "admin@example.org", password })
  ).token;
  const reg = (name, birth = "1995-01-01") =>
    req("/register", "POST", null, {
      name,
      email: name + "@example.org",
      birth,
      password,
    });
  const org = await reg("coach"),
    u = await reg("runner"),
    other = await reg("second"),
    young = await reg("junior", new Date().toISOString().slice(0, 10));
  const spec = await req("/openapi.json");
  assert.ok(spec.paths["/api/events/{id}/checkin"].post.requestBody);
  assert.ok(spec.components.schemas.Profile);
  assert.match(spec.paths["/api/admin/overview"].get.summary, /Сводка/);
  await req("/admin", "GET", u.token, null, 403);
  const data = {
    title: "Тестовый забег",
    description: "Групповая тренировка на стадионе",
    sport: "  Настольный   теннис  ",
    place: "Стадион",
    lat: 47.22,
    lng: 39.72,
    start: new Date(Date.now() + 1800000).toISOString(),
    duration: 5,
    capacity: 1,
    minAge: 18,
    gate: "qr",
  };
  await req("/events", "POST", org.token, { ...data, lat: 0 }, 400);
  await req("/events", "POST", org.token, { ...data, sport: " " }, 400);
  await req("/events", "POST", org.token, { ...data, sport: "Бег\nпрыжки" }, 400);
  const { id } = await req("/events", "POST", org.token, data),
    path = "/events/" + id;
  const pending = await req("/admin/events?status=pending", "GET", admin);
  assert.equal(pending.items.find((entry) => entry.id === id).sport, "Настольный теннис");
  assert.equal((await req("/events")).length, 0);
  await req(path + "/join", "POST", u.token, null, 409);
  await req("/admin/events/" + id, "POST", admin, { status: "approved" });
  assert.equal((await req(path)).sport, "Настольный теннис");
  await req(path + "/join", "POST", young.token, null, 403);
  const contenders = await Promise.all(
    [u, other].map(async (who) => {
      const res = await fetch(base + "/api" + path + "/join", {
        method: "POST",
        headers: { Authorization: "Bearer " + who.token },
      });
      return { who, status: res.status };
    }),
  );
  assert.deepEqual(contenders.map((x) => x.status).sort(), [200, 409]);
  const who = contenders.find((x) => x.status === 200).who;
  const ticket = (await req("/me", "GET", who.token)).tickets[0];
  assert.ok(
    (await req("/tickets/" + ticket.id + "/qr", "GET", who.token))
      .subarray(1, 4)
      .equals(Buffer.from("PNG")),
  );
  await req("/tickets/" + ticket.id + "/qr", "GET", org.token, null, 404);
  await req("/admin/users/"+org.id,"POST",admin,{action:"ban"});
  assert.equal((await req("/me","GET",who.token)).tickets[0].status,"removed");
  await req("/tickets/"+ticket.id+"/qr","GET",who.token,null,404);
  await req("/admin/users/"+org.id,"POST",admin,{action:"unban"});
  org.token=(await req("/login","POST",null,{email:"coach@example.org",password})).token;
  await req(path + "/roster", "GET", who.token, null, 403);
  await req(path + "/checkin", "POST", who.token, { token: ticket.token }, 403);
  await req(path + "/checkin", "POST", org.token, { ticket: ticket.id }, 404);
  await req(path + "/checkin", "POST", org.token, { token: ticket.token });
  await req(path + "/join","DELETE",who.token,null,409);
  await req("/tickets/"+ticket.id+"/qr","GET",who.token,null,404);
  await req(path + "/checkin", "POST", org.token, { token: ticket.token }, 409);
  await req(
    path + "/reviews",
    "POST",
    who.token,
    { stars: 5, body: "Спасибо за забег!" },
    403,
  );
  // Advance only this isolated fixture into the completed state.
  const database = new DatabaseSync(join(dir, "temp.sqlite"));
  database
    .prepare("UPDATE events SET start=? WHERE id=?")
    .run(new Date(Date.now() - 3600000).toISOString(), id);
  database.close();
  await req(path + "/awards", "POST", org.token, {
    ticket: ticket.id,
    rank: 1,
  });
  await req(path + "/reviews", "POST", who.token, {
    stars: 5,
    body: "Спасибо за забег!",
  });
  await req(
    path + "/reviews",
    "POST",
    who.token,
    { stars: 5, body: "Повторный отзыв" },
    409,
  );
  assert.equal((await req(path)).reviews.length, 1);
  const profile = await req("/me", "GET", who.token);
  assert.equal(profile.xp, 250);
  assert.equal(profile.achievements.length, 2);
  assert.equal((await req("/me", "GET", org.token)).held, 1);
  // A visual ticket can be checked against the roster without scanning a QR.
  const visual = await req("/events", "POST", org.token, {
    ...data,
    gate: "ticket",
    capacity: 3,
    minAge: 0,
  });
  const visualPath = "/events/" + visual.id;
  await req("/admin/events/" + visual.id, "POST", admin, {
    status: "approved",
  });
  await req(visualPath + "/join", "POST", u.token);
  await req(visualPath + "/join", "DELETE", u.token);
  for (const participant of [u, other, young]) {
    await req(visualPath + "/join", "POST", participant.token);
    const entry = (await req("/me", "GET", participant.token)).tickets.find(
      (x) => x.event === visual.id,
    );
    await req(visualPath + "/checkin", "POST", org.token, { ticket: entry.id });
  }
  const conn = new DatabaseSync(join(dir, "temp.sqlite"));
  conn
    .prepare("UPDATE events SET start=? WHERE id=?")
    .run(new Date(Date.now() - 3600000).toISOString(), visual.id);
  conn.close();
  for (const participant of [u, other, young])
    await req(visualPath + "/reviews", "POST", participant.token, {
      stars: 2,
      body: "Начали поздно",
    });
  // Three reviewers on one event alone do not trigger a ban.
  await req("/me", "GET", org.token);
  const finalEvent = await req("/events", "POST", org.token, {
    ...data,
    capacity:2,
    gate: "open",
  });
  await req("/admin/events/" + finalEvent.id, "POST", admin, {
    status: "approved",
  });
  const finalPath = "/events/" + finalEvent.id;
  await req(finalPath + "/join", "POST", u.token);
  await req(finalPath + "/join", "POST", other.token);
  const roster = await req(finalPath + "/roster", "GET", org.token);
  await req(finalPath + "/checkin", "POST", org.token, {
    ticket: roster[0].id,
  });
  await req(finalPath + "/checkin", "POST", org.token, {ticket:roster[1].id});
  const lastDb = new DatabaseSync(join(dir, "temp.sqlite"));
  lastDb
    .prepare("UPDATE events SET start=? WHERE id=?")
    .run(new Date(Date.now() - 3600000).toISOString(), finalEvent.id);
  lastDb.close();
  await req(finalPath + "/reviews", "POST", u.token, {
    stars: 1,
    body: "Не хватило инвентаря",
  });
  await req("/me", "GET", org.token, null, 401);
  assert.equal((await req("/events")).length, 0);
  await req("/admin/users/" + org.id, "POST", admin, { action: "unban" });
  await req(finalPath+"/reviews","POST",other.token,{stars:2,body:"Старт задержался"});
  assert.ok((await req("/events")).length>0);
  await req("/admin/overview", "GET", null, null, 401);
  await req("/admin/reviews", "GET", u.token, null, 403);
  const reviewPage = await req("/admin/reviews?stars=low&limit=1", "GET", admin);
  assert.equal(reviewPage.items.length, 1);
  const reviewed = reviewPage.items[0];
  const following = await req("/admin/reviews?limit=1&before=" + reviewPage.nextBefore, "GET", admin);
  assert.ok(following.items[0].id < reviewed.id);
  const moderation = "/admin/reviews/" + reviewed.id;
  await req(moderation, "POST", admin, { hidden: true }, 400);
  await req(moderation, "POST", admin, { hidden: true, reason: "Проверка модерации" });
  assert.ok((await req("/admin/reviews?state=hidden", "GET", admin)).items.some((r) => r.id === reviewed.id));
  assert.ok(!(await req(finalPath)).reviews.some((r) => r.body === reviewed.body));
  await req(moderation, "POST", admin, { hidden: false, reason: "Отзыв проверен" });
  assert.ok((await req(finalPath)).reviews.some((r) => r.body === reviewed.body));
  // Points, order retries, last item contention, refund and public decoration.
  const buyer = u;
  const initial = await req("/wallet", "GET", buyer.token);
  assert.ok(initial.balance >= 20);
  assert.equal((await req("/wallet", "GET", buyer.token)).balance, initial.balance);
  const badge = { title: "Значок бегуна", description: "Оформление профиля", kind: "badge", price: 5, active: true };
  await req("/admin/shop/products", "POST", buyer.token, badge, 403);
  const digital = await req("/admin/shop/products", "POST", admin, badge);
  const buyDigital = { product: digital.id, requestId: "integration-badge-001" };
  const bought = await req("/shop/orders", "POST", buyer.token, buyDigital);
  assert.equal(bought.balance, initial.balance - 5);
  assert.equal(bought.order.status, "fulfilled");
  assert.equal((await req("/shop/orders", "POST", buyer.token, buyDigital)).order.id, bought.order.id);
  await req("/shop/orders", "POST", buyer.token, { ...buyDigital, requestId: "integration-badge-002" }, 409);
  await req("/profile/decoration", "PUT", other.token, { badge: bought.order.id, theme: null }, 403);
  await req("/profile/decoration", "PUT", buyer.token, { badge: bought.order.id, theme: null });
  const publicProfile = await req("/people/" + buyer.id);
  assert.equal(publicProfile.badge, badge.title);
  assert.ok(!("email" in publicProfile) && !("balance" in publicProfile));

  const physical = { title: "Футболка M", description: "Спортивная футболка", kind: "physical", price: 5, stock: 1, pickup: "Покажите номер заказа организатору на площадке.", active: true };
  const shirt = await req("/admin/shop/products", "POST", admin, physical);
  assert.ok(!("pickup" in (await req("/shop/products")).find(p => p.id === shirt.id)));
  const race = await Promise.all([buyer, other].map(async (person) => {
    const payload = { product: shirt.id, requestId: "integration-shirt-" + person.id };
    const res = await fetch(base + "/api/shop/orders", {
      method: "POST",
      headers: { Authorization: "Bearer " + person.token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, data: await res.json(), person, payload };
  }));
  assert.deepEqual(race.map(x => x.status).sort(), [200, 409]);
  const order = race.find(x => x.status === 200);
  assert.equal(order.data.order.status, "reserved");
  assert.equal(order.data.order.pickup, physical.pickup);
  assert.equal((await req("/shop/products")).find(p => p.id === shirt.id).stock, 0);
  await req("/admin/shop/products/" + shirt.id, "PUT", admin, { ...physical, expectedStock: 1 }, 409);
  const adminOrders = await req("/admin/shop", "GET", admin);
  assert.equal(adminOrders.orders[0].id, order.data.order.id);
  const processOrder = "/admin/shop/orders/" + order.data.order.id;
  await req(processOrder, "POST", admin, { status: "fulfilled" }, 409);
  await req(processOrder, "POST", admin, { status: "ready" });
  await req(processOrder, "POST", admin, { status: "cancelled" });
  await req(processOrder, "POST", admin, { status: "cancelled" });
  assert.equal((await req("/wallet", "GET", order.person.token)).balance, order.data.balance + physical.price);
  assert.equal((await req("/shop/products")).find(p => p.id === shirt.id).stock, 1);
  await req("/admin/shop/products/" + shirt.id, "PUT", admin, { ...physical, expectedStock: 1, active: false });
  assert.ok(!(await req("/shop/products")).some(p => p.id === shirt.id));

  const cleanOrgToken = (await req("/login","POST",null,{email:"coach@example.org",password})).token;
  const scored = await req("/wallet","GET",cleanOrgToken);
  assert.equal(scored.organizer.rewardedEvents, 3);
  assert.equal(scored.balance, 90);
  const fixtures = new DatabaseSync(join(dir, "temp.sqlite"));
  for (let i=0;i<2;i++) {
    const fixture = fixtures.prepare("INSERT INTO events(owner,title,sport,description,place,lat,lng,start,duration,capacity,minAge,gate,status) SELECT owner,title,sport,description,place,lat,lng,start,duration,capacity,minAge,gate,status FROM events WHERE id=?").run(finalEvent.id);
    fixtures.prepare("INSERT INTO tickets(event,user,attended,token) VALUES(?,?,1,?)").run(fixture.lastInsertRowid,buyer.id,randomBytes(20).toString("hex"));
  }
  fixtures.close();
  const rewarded = await req("/wallet","GET",cleanOrgToken);
  assert.equal(rewarded.organizer.rewardedEvents,5);
  assert.equal(rewarded.organizer.nextMilestone,10);
  assert.equal(rewarded.balance,190);
  assert.equal((await req("/wallet","GET",cleanOrgToken)).balance,190);
  assert.equal((await req("/organizers/leaderboard")).organizers[0].events,5);
  const seriesTitle = "Ежегодный кубок Дона";
  const upcoming = await req("/events", "POST", cleanOrgToken, { ...data, seriesTitle });
  const seriesID = upcoming.seriesId;
  const seriesPath = "/series/" + seriesID;
  await req(seriesPath, "GET", null, null, 404);
  assert.equal((await req("/series/mine", "GET", cleanOrgToken))[0].id, seriesID);
  assert.deepEqual(await req("/series/mine", "GET", other.token), []);
  await req("/events", "POST", other.token, { ...data, seriesId: seriesID }, 404);
  await req("/events", "POST", cleanOrgToken, { ...data, sport: "Йога", seriesId: seriesID }, 409);
  const latestYear = new Date().getUTCFullYear() - 1;
  const history = new DatabaseSync(join(dir, "temp.sqlite"));
  const editionIDs = [];
  for (let year = latestYear - 3; year <= latestYear; year++) {
    const fixture = history.prepare("INSERT INTO events(owner,title,sport,description,place,lat,lng,start,duration,capacity,minAge,gate,status) SELECT owner,title,sport,description,place,lat,lng,?,duration,capacity,minAge,gate,status FROM events WHERE id=?").run(year + "-07-01T09:00:00.000Z", finalEvent.id);
    history.prepare("INSERT INTO tickets(event,user,attended,token) VALUES(?,?,1,?)").run(fixture.lastInsertRowid,buyer.id,randomBytes(20).toString("hex"));
    editionIDs.push(fixture.lastInsertRowid);
  }
  history.close();
  for (const edition of editionIDs) {
    await req("/events/" + edition + "/series", "PUT", cleanOrgToken, { seriesId: seriesID });
  }
  await req("/events/" + editionIDs[0] + "/series", "PUT", cleanOrgToken, { seriesId: seriesID });
  await req("/events/" + editionIDs[0] + "/series", "PUT", other.token, { seriesId: seriesID }, 403);
  await req("/events/" + editionIDs[0] + "/series", "PUT", cleanOrgToken, { seriesTitle: "Чужая история" }, 409);
  const chronology = await req(seriesPath);
  assert.equal(chronology.title, seriesTitle);
  assert.equal(chronology.firstYear, latestYear - 3);
  assert.equal(chronology.yearsHeld, 4);
  assert.deepEqual(chronology.editions.map(x => [x.edition,x.seriesYear,x.completed]), [[1,1,true],[2,2,true],[3,3,true],[4,4,true]]);
  assert.equal((await req("/series/leaderboard?year="+latestYear))[0].events,1);
  assert.equal((await req("/organizers/leaderboard?year="+latestYear)).totalEvents,1);
  await req("/series/leaderboard?year=x", "GET", null, null, 400);
  await req("/admin/events/" + upcoming.id, "POST", admin, { status: "approved" });
  assert.equal((await req(seriesPath)).editions.at(-1).edition,5);
  assert.equal((await req("/events/" + upcoming.id)).seriesId,seriesID);
  const overview = await req("/admin/overview", "GET", admin);
  assert.equal(overview.upcomingEvents, 1);
  const bulk = "/admin/events/bulk";
  const eventChange = { ids: [upcoming.id, 9999999], status: "removed", reason: "Проверка отката" };
  await req(bulk, "POST", admin, eventChange, 404);
  assert.equal((await req("/events/" + upcoming.id)).status, "approved");
  const archive = { ...eventChange, ids: [upcoming.id, upcoming.id] };
  assert.equal((await req(bulk, "POST", admin, archive)).updated, 1);
  assert.equal((await req(bulk, "POST", admin, archive)).updated, 0);
  assert.equal((await req("/admin/events?status=removed&q=" + upcoming.id, "GET", admin)).items[0].id, upcoming.id);
  assert.equal((await req(bulk, "POST", admin, { ...archive, status: "approved" })).updated, 1);
  const points = "/admin/users/" + who.id + "/points";
  const adjustment = { delta: 25, reason: "Награда за помощь", requestId: randomBytes(16).toString("hex") };
  await req(points, "POST", who.token, adjustment, 403);
  const balanceBefore = (await req("/wallet", "GET", who.token)).balance;
  const adjusted = await req(points, "POST", admin, adjustment);
  assert.equal(adjusted.balance, balanceBefore + 25);
  assert.deepEqual(await req(points, "POST", admin, adjustment), adjusted);
  await req(points, "POST", admin, { ...adjustment, delta: 26 }, 409);
  await req(points, "POST", admin, { ...adjustment, delta: -adjusted.balance - 1, requestId: randomBytes(16).toString("hex") }, 409);
  assert.equal((await req("/wallet", "GET", who.token)).history[0].kind, "admin_adjustment");
  const adminActions = await req("/admin/logs?actor=1&q=Награда", "GET", admin);
  assert.equal(adminActions.items.length, 1);
  await req("/admin/users/" + who.id + "/sessions/revoke", "POST", admin);
  await req("/me", "GET", who.token, null, 401);
  await req("/admin/users/1/sessions/revoke", "POST", admin, null, 404);
  await req("/admin/users?limit=101", "GET", admin, null, 400);
  assert.equal((await req("/admin/users?q="+who.id, "GET", admin)).items[0].id, who.id);
  await req("/admin/users/" + who.id, "POST", admin, { action: "ban" });
  await req("/me", "GET", who.token, null, 401);
  const dashboard = await req("/admin", "GET", admin);
  assert.ok(
    dashboard.logs.some((l) => l.ip && l.action === "Присуждение места"),
  );
  await req("/admin/users/" + who.id, "POST", admin, { action: "delete" });
  assert.equal((await fetch(base + "/missing-page")).status, 404);
  assert.equal((await fetch(base + "/docs")).status, 200);
});

test("Тестовый HTTP и HTTPS используют одну базу и разные cookie", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "temp-dual-"));
  const child = spawn(process.env.TEST_SERVER_BIN || "temp", [], {
    env: {
      ...process.env,
      HTTPS: "1",
      PORT: "0",
      BIND: "127.0.0.1",
      HTTP_TEST_PORT: "0",
      DATA_DIR: dir,
      SEED_DEMO: "0",
      TLS_CERT: "",
      TLS_KEY: "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stopped = once(child, "exit");
  t.after(async () => {
    child.kill();
    await stopped;
    rmSync(dir, { recursive: true, force: true });
  });
  const [http, https] = await Promise.race([
    new Promise((resolve) => {
      let logs = "";
      child.stdout.on("data", (chunk) => {
        logs += chunk.toString();
        const plain = logs.match(/http:\/\/127\.0\.0\.1:\d+(?=\n)/)?.[0];
        const secure = logs.match(/https:\/\/127\.0\.0\.1:\d+(?=\n)/)?.[0];
        if (plain && secure) resolve([plain, secure]);
      });
    }),
    stopped.then(() => { throw new Error("Server exited"); }),
  ]);
  const credentials = { email: "dual@example.org", password: randomBytes(16).toString("hex") };
  const plain = await fetch(http + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: http },
    body: JSON.stringify({ ...credentials, name: "Dual", birth: "2000-01-01" }),
  });
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get("set-cookie"), /^session_http=/);
  assert.doesNotMatch(plain.headers.get("set-cookie"), /; Secure/);
  const { id } = await plain.json();
  const login = await new Promise((resolve, reject) => {
    // Only this throwaway service uses a generated loopback certificate.
    const req = httpsRequest(https + "/api/login", {
      method: "POST",
      rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", Origin: https },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { data += part; });
      res.on("end", () => resolve({ code: res.statusCode, cookie: res.headers["set-cookie"][0], body: JSON.parse(data) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(credentials));
  });
  assert.equal(login.code, 200);
  assert.equal(login.body.id, id);
  assert.match(login.cookie, /^session=/);
  assert.match(login.cookie, /; Secure/);
});
