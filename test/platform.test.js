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

test("Полный цикл события, границы доступа и журнал", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "temp-sport-"));
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const password = randomBytes(16).toString("hex");
  const child = spawn(process.execPath, ["server.js"], {
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
  await req("/admin", "GET", u.token, null, 403);
  const data = {
    title: "Тестовый забег",
    description: "Групповая тренировка на стадионе",
    sport: "Бег",
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
  const { id } = await req("/events", "POST", org.token, data),
    path = "/events/" + id;
  assert.equal((await req("/events")).length, 0);
  await req(path + "/join", "POST", u.token, null, 409);
  await req("/admin/events/" + id, "POST", admin, { status: "approved" });
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
