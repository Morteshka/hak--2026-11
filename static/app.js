const $ = (s) => document.querySelector(s),
  main = $("#main"),
  route = location.pathname;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const ic = (name) =>
  `<i aria-hidden="true" class="ic" style="--icon:url('/vendor/icon/${name}.svg')"></i>`;
const sports = {
  Бег: ["footprints", "running"],
  Баскетбол: ["circle-dot", "basketball"],
  Йога: ["flower-2", "yoga"],
  Футбол: ["goal", "football"],
};
const status = {
  approved: "Одобрено",
  pending: "На проверке",
  rejected: "Отклонено",
  removed: "Снято",
};
const gates = { qr: "QR-код", ticket: "Электронный билет", open: "По списку" };
const date = (v) =>
  new Date(v)
    .toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(",", " ·");
const crumb = (t) =>
  `<div class="crumb"><a href="/">Главная</a> &nbsp; / &nbsp; ${esc(t)}</div>`;
const link = (href, label, style = "lime") =>
  `<a class="btn ${style}" href="${href}">${label}</a>`;
const btn = (label, action, id, style = "light") =>
  `<button class="btn ${style}" data-action="${action}" data-id="${id}">${label}</button>`;
const input = (name, label, type = "text", attrs = "") =>
  `<label>${label}<input type="${type}" name="${name}" required ${attrs}></label>`;
const select = (name, label, items) =>
  `<label>${label}<select name="${name}">${Object.entries(items)
    .map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`)
    .join("")}</select></label>`;
const form = (id, content, submit) =>
  `<form class="form" id="${id}">${content}<div class="error" role="alert"></div><button class="btn lime">${submit}</button></form>`;
const panel = (title, body) =>
  `<section class="panel"><h2>${title}</h2>${body}</section>`;
let me = null,
  events = [],
  sport = "",
  onlyFree = false,
  day = "";
async function api(path, method = "GET", body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}
function handleForm(id, fn) {
  $("#" + id).onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget,
      submit = f.querySelector("button[type=submit],button:last-child");
    submit.disabled = true;
    try {
      await fn(Object.fromEntries(new FormData(f)));
    } catch (e) {
      f.querySelector(".error").textContent = e.message;
    } finally {
      submit.disabled = false;
    }
  };
}
function card(e) {
  const [icon, image] = sports[e.sport];
  const admission = e.gate === "qr" ? `<span class="qr-label">${ic("qr-code")} QR-допуск</span>` : "";
  return `<a class="card" href="/events/${e.id}"><div class="photo"><img src="/static/media/${image}.jpg" alt=""><span class="tag">${ic(icon)}${esc(e.sport)}</span><span class="availability">Свободно ${e.capacity - e.booked} из ${e.capacity}</span></div><div class="cardBody"><div class="when">${date(e.start)}</div><h3>${esc(e.title)}</h3><div class="smallrow"><span>${ic("map-pin")}${esc(e.place)}</span></div><div class="cardFoot"><div class="smallrow"><span>${ic("clock-3")}${e.duration} мин</span>${admission}</div><span class="round">${ic("arrow-up-right")}</span></div></div></a>`;
}
async function catalogue() {
  events = await api("/events");
  const isMap = route === "/map";
  main.innerHTML =
    (isMap
      ? crumb("Карта событий")
      : `<section class="hero"><div><div class="heroTag"><i></i> СПОРТИВНОЕ СООБЩЕСТВО РОСТОВА</div><h1>Твой город.<br><em>Твой темп.</em></h1><p>Находи тренировки рядом и собирай свою команду.</p><div class="actions">${link("#events", ic("compass") + " Найти событие")}${link("/create", ic("plus") + " Создать событие", "ghost")}</div></div></section>`) +
    `<section id="events"><div class="sectionTop"><div><div class="eyebrow">РОСТОВ-НА-ДОНУ</div><h2>${isMap ? "Карта событий" : "Ближайшие события"}</h2></div><div class="switch"><a href="/" aria-label="Список" class="${isMap ? "" : "on"}">${ic("layout-grid")}<span class="lbl">Список</span></a><a href="/map" aria-label="Карта" class="${isMap ? "on" : ""}">${ic("map")}<span class="lbl">Карта</span></a></div></div><div id="chips" class="chips"></div><div id="results"></div></section>`;
  function draw() {
    const filtered = events.filter(
      (e) =>
        Date.parse(e.start) > Date.now() &&
        (!sport || sport === e.sport) &&
        (!onlyFree || e.booked < e.capacity) &&
        (!day ||
          new Date(Date.parse(e.start) + 10800000)
            .toISOString()
            .startsWith(day)),
    );
    $("#chips").innerHTML =
      ["", ...Object.keys(sports)]
        .map(
          (s) =>
            `<button data-sport="${s}" class="chip ${s === sport ? "on" : ""}">${ic(s ? sports[s][0] : "layers")}${s || "Все виды"}</button>`,
        )
        .join("") +
      `<button id="filter" class="chip filter ${onlyFree || day ? "on" : ""}">${ic("sliders-horizontal")} Фильтры</button>`;
    document.querySelectorAll("[data-sport]").forEach(
      (b) =>
        (b.onclick = () => {
          sport = b.dataset.sport;
          draw();
        }),
    );
    $("#filter").onclick = () => {
      const d = $("#filters");
      d.innerHTML =
        "<h2>Фильтры</h2>" +
        form(
          "filterform",
          `<label>Дата в Ростове-на-Дону<input type="date" name="day" value="${day}"></label><label><span><input name="free" type="checkbox" style="width:auto" ${onlyFree ? "checked" : ""}> Только со свободными местами</span></label>`,
          "Применить",
        ) +
        '<button class="btn light" id="close">Закрыть</button>';
      d.showModal();
      $("#close").onclick = () => d.close();
      handleForm("filterform", (v) => {
        onlyFree = !!v.free;
        day = v.day;
        d.close();
        draw();
      });
    };
    $("#results").innerHTML =
      (isMap ? '<div id="map" class="map"></div>' : "") +
      (filtered.length
        ? `<div class="grid" style="${isMap ? "margin-top:20px" : ""}">${filtered.map(card).join("")}</div>`
        : '<p class="empty">По этим условиям событий пока нет.</p>');
    if (isMap) tempMaps.show($("#map"), filtered, true);
  }
  draw();
}
function auth(register) {
  const next = new URLSearchParams(location.search).get("next"),
    dest =
      next && /^\/(?:create|admin|profile|shop(?:\/admin)?|events\/\d+)$/.test(next)
        ? next
        : "/profile";
  main.innerHTML =
    crumb(register ? "Регистрация" : "Вход") +
    `<div class="narrow">${panel(register ? "Регистрация" : "Вход в Темп", form("auth", (register ? input("name", "Ваше имя", "text", "minlength=2 maxlength=60") + input("birth", "Дата рождения", "date") : "") + input("email", "Электронная почта", "email") + input("password", "Пароль", "password", register ? 'minlength=10 placeholder="Минимум 10 символов"' : "") + (register ? '<a class="link" href="/privacy">Политика конфиденциальности</a>' : ""), register ? "Создать аккаунт" : "Войти") + `<p><a class="link" href="/${register ? "login" : "register"}?next=${encodeURIComponent(dest)}">${register ? "Уже есть аккаунт? Войти" : "Впервые здесь? Зарегистрироваться"}</a></p>`)}</div>`;
  handleForm("auth", async (v) => {
    await api(register ? "/register" : "/login", "POST", v);
    location.assign(dest);
  });
}
function create() {
  main.innerHTML =
    crumb("Создать событие") +
    `<div class="narrow"><h1 class="pageTitle">Создать событие</h1>${panel("Заявка на проведение", form("create", input("title", "Название", "text", "minlength=3 maxlength=100") + select("sport", "Вид спорта", Object.fromEntries(Object.keys(sports).map((s) => [s, s]))) + '<label>Программа тренировки<textarea name="description" minlength="10" maxlength="2000" required></textarea></label>' + input("place", "Место встречи") + '<label>Выберите точку на карте Ростова-на-Дону</label><div id="map" class="map"></div><div class="cols">' + input("lat", "Широта", "number", "step=any value=47.223 min=47.10 max=47.36") + input("lng", "Долгота", "number", "step=any value=39.722 min=39.52 max=39.92") + "</div>" + input("start", "Начало по Москве", "datetime-local") + '<div class="cols">' + input("duration", "Длительность, минут", "number", "min=5 max=1440 value=60") + input("capacity", "Количество мест", "number", "min=1 max=5000 value=20") + "</div>" + input("minAge", "Минимальный возраст", "number", "min=0 max=100 value=0") + select("gate", "Допуск на площадку", gates), "Отправить на проверку"))}</div>`;
  tempMaps.pick($("#map"), $("[name=lat]"), $("[name=lng]"));
  const createSeries = document.createElement("div");
  createSeries.id = "create-series";
  createSeries.className = "form";
  $("#create [name=sport]").closest("label").after(createSeries);
  buildCreateSeries().catch((error) => { createSeries.textContent = error.message; });
  handleForm("create", async (v) => {
    for (const k of ["duration", "capacity", "minAge", "lat", "lng"])
      v[k] = Number(v[k]);
    v.start = new Date(v.start + ":00+03:00").toISOString();
    const series = seriesPayload(v);
    delete v.seriesChoice;
    delete v.seriesTitle;
    await api("/events", "POST", { ...v, ...series });
    location.assign("/thanks?type=create");
  });
}
function ticketPass(t) {
  if (t.attended) return '<p class="ticket-state">Участие подтверждено.</p>';
  if (t.status !== "approved") return '<p class="ticket-state">Допуск закрыт.</p>';
  if (Date.now() >= Date.parse(t.start) + t.duration * 60000) {
    return '<p class="ticket-state">Событие завершилось.</p>';
  }
  if (t.gate === "qr") {
    const src = "/api/tickets/" + t.id + "/qr";
    return `<div class="ticket-pass"><img class="qr" src="${src}" width="256" height="256" alt="QR-код билета № ${t.id}"><div><strong>${ic("qr-code")} QR-билет № ${t.id}</strong><p>Покажите код организатору на входе.</p><a href="${src}" class="link" target="_blank" rel="noopener">Открыть QR на весь экран</a></div></div>`;
  }
  if (t.gate === "ticket") {
    return `<div class="ticket-pass"><div><strong>Электронный билет № ${t.id}</strong><p>${esc(me.name)} · Покажите билет организатору.</p></div></div>`;
  }
  return '<p class="ticket-state">Вы записаны. Организатор отметит вас по списку.</p>';
}
async function profilePage() {
  main.innerHTML =
    crumb("Личный кабинет") +
    `<div id="profile-identity">${profileIdentity(me, {}, true)}</div><p class="muted">${esc(me.email)}</p><div class="actions">${link("/create", "Создать событие")}${link("#wallet", "Баллы и заказы", "light")}${link("/people/" + me.id, "Публичный профиль", "light")}${me.role === "admin" ? link("/admin", "Администрирование", "light") : ""}${btn("Выйти", "logout", 0)}</div><div class="cabinet-grid"><div>` +
    panel(
      "Мои билеты",
      me.tickets
        .slice()
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .map((t) => `<article class="row ticket"><h3><a class="link" href="/events/${t.event}">${esc(t.title)}</a></h3><p class="muted">${date(t.start)} МСК · ${gates[t.gate]}</p>${ticketPass(t)}</article>`)
        .join("") || `<p>Запишитесь на мероприятие, чтобы здесь появился билет. События с QR-билетом отмечены в афише.</p>${link("/", "К афише")}`,
    ) +
    panel(
      "Спортивный профиль",
      `<div class="stats">${[
        [me.level, "Уровень"],
        [me.xp, "Опыт"],
        [me.attended, "Посещено"],
        [me.held, "Проведено"],
      ]
        .map(([v, l]) => `<div><b>${v}</b>${l}</div>`)
        .join("")}</div>`,
    ) +
    panel(
      "Достижения",
      me.tickets
        .filter((t) => t.attended)
        .map(
          (t) =>
            `<div class="row"><span class="badge">Участник · ${esc(t.title)}</span>${t.rank ? `<span class="badge">${t.rank} место</span>` : ""}</div>`,
        )
        .join("") || "Первое достижение появится после подтверждения участия.",
    ) +
    panel(
      "Мои мероприятия",
      me.created
        .map(
          (e) =>
            `<div class="row">${e.status === "approved" ? `<a class="link" href="/events/${e.id}">${esc(e.title)}</a>` : esc(e.title)} · ${status[e.status]}</div>`,
        )
        .join("") || "Вы пока не подавали заявок.",
    ) + '</div><aside id="wallet" aria-label="Баллы и заказы"><p>Загружаем баллы…</p></aside></div>';
  await fillCabinet($("#wallet"));
  if (location.hash === "#wallet") $("#wallet").scrollIntoView();
}
async function detail() {
  const e = await api(route),
    t = me?.tickets.find((t) => t.event === e.id),
    manage = me && (me.id === e.owner || me.role === "admin"),
    done = Date.now() >= Date.parse(e.start) + e.duration * 60000;
  const pass = t ? `<div id="my-ticket">${panel("Ваш билет", ticketPass(t))}</div>` : "";
  main.innerHTML =
    crumb(e.title) +
    `<div class="narrow"><img class="detailphoto" src="/static/media/${sports[e.sport][1]}.jpg" alt=""><p class="when">${date(e.start)} МСК · ${esc(e.sport)}</p><h1 class="pageTitle">${esc(e.title)}</h1><p>${esc(e.description)}</p><div class="smallrow"><span>${ic("map-pin")}${esc(e.place)}</span><span>${e.duration} мин</span><span>${e.minAge}+</span></div><p>Организатор · <a class="link" href="/people/${e.owner}">${esc(e.organizer)}</a><br>Допуск · ${gates[e.gate]}<br>Свободных мест · ${e.capacity - e.booked} из ${e.capacity}</p><div class="actions">${t ? link("#my-ticket", "Мой билет") + (Date.now() < Date.parse(e.start) && !t.attended ? btn("Отменить запись", "cancel", e.id) : "") : e.owner !== me?.id && Date.parse(e.start) > Date.now() && e.booked < e.capacity ? (me ? btn("Записаться", "join", e.id, "lime") : link("/login?next=" + route, "Войти и записаться")) : ""}</div>${pass}${panel("Место встречи", '<div id="map" class="map"></div>')}<div id="manage"></div>${panel("Отзывы участников", e.reviews.map((x) => `<div class="row"><strong>${esc(x.name)} · ${x.stars}/5</strong>${esc(x.body)}</div>`).join("") || "Участники пока не оставили отзывов.")}${t?.attended && done ? panel("Ваш отзыв", form("review", select("stars", "Оценка", { 5: "5", 4: "4", 3: "3", 2: "2", 1: "1" }) + '<label>Впечатления<textarea name="body" minlength="5" maxlength="1500" required></textarea></label>', "Опубликовать")) : ""}</div>`;
  tempMaps.show($("#map"), [e]);
  $("#manage").insertAdjacentHTML("beforebegin", '<div id="event-series"></div>');
  fillEventSeries(e).catch((error) => { $("#event-series").textContent = error.message; });
  if ($("#review"))
    handleForm("review", async (v) => {
      await api(route + "/reviews", "POST", { ...v, stars: +v.stars });
      location.reload();
    });
  if (manage) {
    const roster = await api(route + "/roster");
    $("#manage").innerHTML = panel(
      "Площадка организатора",
      (e.gate === "qr" && !done
        ? form(
            "admit",
            input(
              "token",
              e.gate === "qr"
                ? "Значение QR-кода"
                : "Номер электронного билета",
            ) +
              (e.gate === "qr"
                ? '<button type="button" class="btn light" id="camera">Сканировать камерой</button><div id="reader"></div>'
                : ""),
            "Подтвердить приход",
          )
        : "") +
        "<p>Отметка прихода открывается за час до начала.</p>" +
        roster
          .map(
            (t) =>
              `<div class="row"><b>${esc(t.name)}</b> · Билет № ${t.id} · ${t.attended ? "На площадке" : "В списке"} ${t.rank ? " · " + t.rank + " место" : ""}<div class="actions">${!t.attended && e.gate !== "qr" && !done ? btn("Пришёл на площадку", "mark", t.id) : ""}${done && t.attended ? [1, 2, 3].map((n) => btn(n + " место", "award" + n, t.id)).join("") : ""}</div></div>`,
          )
          .join(""),
    );
    if ($("#admit"))
      handleForm("admit", async (v) => {
        await api(route + "/checkin", "POST", v);
        location.reload();
      });
    if ($("#camera"))
      $("#camera").onclick = async () => {
        try {
          if (!window.Html5Qrcode)
            await new Promise((ok, no) => {
              const s = document.createElement("script");
              s.src = "/vendor/scanner.js";
              s.onload = ok;
              s.onerror = no;
              document.head.append(s);
            });
          const scanner = new Html5Qrcode("reader");
          let found = false;
          await scanner.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: 200 },
            async (value) => {
              if (found) return;
              found = true;
              await scanner.stop();
              $("[name=token]").value = value;
            },
          );
          $("#camera").disabled = true;
        } catch {
          $("#admit .error").textContent =
            "Камера недоступна. Проверьте разрешение камеры и HTTPS.";
        }
      };
  }
}
async function admin() {
  const a = await api("/admin");
  main.innerHTML =
    crumb("Администрирование") +
    '<div class="sectionTop"><h1 class="pageTitle">Администрирование</h1>' + link("/shop/admin", "Управление магазином") + '</div>' +
    panel(
      "Модерация мероприятий",
      a.events
        .map(
          (e) =>
            `<div class="row"><strong>${esc(e.title)}</strong>${esc(e.organizer)} · ${date(e.start)} · ${status[e.status]}<div class="actions">${e.status !== "approved" ? btn("Одобрить", "approved", e.id, "lime") : ""}${e.status === "pending" ? btn("Отклонить", "rejected", e.id) : ""}${e.status !== "removed" ? btn("Снять с публикации", "removed", e.id) : ""}</div><details><summary>Данные заявки</summary><p>${esc(e.description)}</p>${esc(e.place)} (${e.lat}, ${e.lng}) · ${e.capacity} мест · ${e.minAge}+ · ${gates[e.gate]}</details></div>`,
        )
        .join(""),
    ) +
    panel(
      "Пользователи",
      a.users
        .map(
          (u) =>
            `<div class="row"><strong>${esc(u.name)}</strong>${esc(u.email)} · ${u.deleted ? "Удалён" : u.banned ? "Заблокирован" : u.role}<div class="actions">${u.role === "user" && !u.deleted ? btn(u.banned ? "Разблокировать" : "Заблокировать", u.banned ? "unban" : "ban", u.id) + btn("Удалить", "delete", u.id) : ""}</div></div>`,
        )
        .join(""),
    ) +
    panel(
      "Журнал действий",
      `<div class="adminTable"><table><thead><tr><th>Время UTC</th><th>Пользователь ID</th><th>Действие</th><th>Объект</th><th>IP</th></tr></thead><tbody>${a.logs.map((l) => `<tr>${[l.at, l.actor, l.action, l.target, l.ip].map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
    );
}
main.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-action]");
  if (!b) return;
  const a = b.dataset.action,
    id = +b.dataset.id;
  b.disabled = true;
  try {
    if (a === "logout") {
      await api("/logout", "POST");
      location.assign("/");
      return;
    }
    if (a === "join") {
      const booking = await api(route + "/join", "POST");
      location.assign("/thanks?event=" + booking.event);
      return;
    }
    if (a === "cancel") {
      if (!confirm("Отменить запись на событие?")) return;
      await api(route + "/join", "DELETE");
    }
    if (a === "mark") await api(route + "/checkin", "POST", { ticket: id });
    if (a.startsWith("award"))
      await api(route + "/awards", "POST", { ticket: id, rank: +a.slice(-1) });
    if (["approved", "removed", "rejected"].includes(a))
      await api("/admin/events/" + id, "POST", { status: a });
    if (["ban", "unban", "delete"].includes(a)) {
      if (!confirm("Подтвердить действие с пользователем?")) return;
      await api("/admin/users/" + id, "POST", { action: a });
    }
    location.reload();
  } catch (e) {
    alert(e.message);
  } finally {
    b.disabled = false;
  }
});
(async () => {
  try {
    me = await api("/me");
  } catch (e) {
    if (e.status !== 401) {
      main.textContent = e.message;
      return;
    }
  }
  $("#account").innerHTML = ic("user-round") + (me ? esc(me.name) : "Войти");
  $("#account").href = me ? "/profile" : "/login";
  $(".city i").style.setProperty("--icon", "url('/vendor/icon/map-pin.svg')");
  document
    .querySelector(
      `nav a[href="${route.startsWith("/shop") ? "/shop" : route === "/organizers" || route.startsWith("/series/") ? "/organizers" : route === "/map" ? "/map" : route === "/profile" ? "/profile" : "/"}"]`,
    )
    ?.classList.add("active");
  try {
    if (["/profile", "/create", "/admin", "/shop/admin"].includes(route) && !me) {
      location.replace("/login?next=" + route);
      return;
    }
    if (route === "/" || route === "/map") await catalogue();
    else if (route === "/login" || route === "/register")
      auth(route === "/register");
    else if (route === "/profile") await profilePage();
    else if (route === "/shop") await shopPage();
    else if (route === "/shop/admin") await shopAdmin();
    else if (route === "/organizers") await rankingPage();
    else if (/^\/series\/\d+$/.test(route)) await seriesPage();
    else if (/^\/people\/\d+$/.test(route)) await publicProfile();
    else if (route === "/create") create();
    else if (route === "/admin") await admin();
    else if (/^\/events\/\d+$/.test(route)) await detail();
    else if (route === "/thanks") {
      const params = new URLSearchParams(location.search);
      const submitted = params.get("type") === "create";
      const ticket = me?.tickets.find((item) => item.event === Number(params.get("event")));
      main.innerHTML =
        crumb("Спасибо") +
        panel(
          submitted ? "Спасибо за заявку!" : "Вы записаны!",
          `<p>${submitted ? "Администратор проверит мероприятие. Статус доступен в профиле." : "Билет и сведения о мероприятии доступны в профиле."}</p>${ticket ? ticketPass(ticket) : ""}<div class="actions">${link("/profile", "Мои билеты")}${ticket ? link("/events/" + ticket.event, "К мероприятию", "light") : ""}</div>`,
        );
    } else if (route === "/privacy")
      main.innerHTML =
        crumb("Конфиденциальность") +
        `<div class="narrow">${panel("Политика конфиденциальности", `<p>Тестовый сервис «Темп» хранит имя, адрес электронной почты, дату рождения и хеш пароля. Дата рождения нужна для проверки возрастных ограничений. Имя организатора и отзывы участников видны в карточке события.</p><p>Организатор видит список зарегистрированных участников, отметки о посещении и места. Администратор видит аккаунты и журнал действий с IP-адресами. Билеты, покупки и баланс доступны в личном кабинете. В публичном профиле видны имя, город, уровень, счётчики спортивной активности и выбранное оформление. При покупке физического товара администратор видит имя получателя и сведения о заказе.</p><p>Сеансовый cookie действует два часа. При открытии карты Яндекс получает IP-адрес браузера и координаты отображаемого места. В резервном редакторе точки браузер также обращается к OpenStreetMap. Данные стенда хранятся в локальном томе Docker. Для удаления аккаунта обратитесь к администратору стенда.</p>`)}</div>`;
    else
      main.innerHTML =
        crumb("404") +
        panel("404 · Страница не найдена", link("/", "Вернуться к событиям"));
  } catch (e) {
    main.innerHTML = panel(
      e.status === 404
        ? "404 · Событие не найдено"
        : "Не удалось открыть страницу",
      `<p>${esc(e.message)}</p>${link("/", "К афише")}`,
    );
  }
})();
