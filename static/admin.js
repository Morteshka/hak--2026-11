const adminSections = {
  events: "Мероприятия",
  users: "Пользователи",
  reviews: "Отзывы",
  logs: "Журнал",
};

function adminCounts(data) {
  const metrics = [
    ["На проверке", data.pendingEvents, "/admin?tab=events&status=pending"],
    ["Предстоящие", data.upcomingEvents, "/admin?tab=events&status=approved&when=upcoming"],
    ["Активные аккаунты", data.activeUsers, "/admin?tab=users&state=active"],
    ["Заблокированы", data.bannedUsers, "/admin?tab=users&state=banned"],
    ["Подтверждённые посещения", data.checkIns],
    ["Заказы на выдачу", data.openOrders, "/shop/admin"],
    ["Отзывы с 1–2 звёздами", data.lowReviews, "/admin?tab=reviews&stars=low&state=visible"],
  ];
  return metrics.map(([label, value, href]) => {
    const inner = `<strong>${value}</strong><span>${label}</span>`;
    return href ? `<a class="adminMetric" href="${href}">${inner}</a>` : `<div class="adminMetric">${inner}</div>`;
  }).join("");
}

function adminAction(label, action, id, style = "light") {
  return `<button class="btn ${style}" type="button" data-admin-action="${action}" data-id="${id}">${label}</button>`;
}

function adminEventRow(e) {
  return `<article class="row adminRow">
    <label class="adminCheck"><input type="checkbox" form="admin-bulk" name="ids" value="${e.id}"><span><strong>${esc(e.title)}</strong><small>#${e.id} · ${date(e.start)}</small></span></label>
    <p><b>Вид спорта</b> · ${esc(e.sport)}</p>
    <p>${esc(e.organizer)} · ${esc(e.place)} · ${e.booked}/${e.capacity} мест</p>
    <div class="actions"><span class="adminState">${esc(status[e.status])}</span>
      ${e.status !== "approved" ? adminAction("Одобрить", "approved", e.id, "lime") : ""}
      ${e.status === "pending" ? adminAction("Отклонить", "rejected", e.id) : ""}
      ${e.status !== "removed" ? adminAction("Снять", "removed", e.id) : ""}
      ${link("/events/" + e.id, "Карточка", "light")}
    </div>
    <details><summary>Данные заявки</summary><p>${esc(e.description)}</p><small>${e.minAge}+ · ${esc(gates[e.gate])} · ${e.lat}, ${e.lng}</small></details>
  </article>`;
}

function adminUserRow(u) {
  const state = u.deleted ? "Удалён" : u.banned ? "Заблокирован" : u.role === "admin" ? "Администратор" : "Активен";
  return `<article class="row adminRow">
    <strong>${esc(u.name)} <span class="muted">#${u.id}</span></strong>
    <p>${esc(u.email)} · ${state}</p>
    ${u.role === "user" && !u.deleted ? `<div class="actions">
      ${adminAction(u.banned ? "Разблокировать" : "Заблокировать", u.banned ? "unban" : "ban", u.id)}
      ${adminAction("Завершить сессии", "revoke", u.id)}
      ${adminAction("Баллы", "points", u.id)}
      ${adminAction("Удалить", "delete", u.id)}
      ${link("/admin?tab=logs&actor=" + u.id, "Действия", "light")}
    </div>` : ""}
  </article>`;
}

function adminReviewRow(r) {
  return `<article class="row adminRow">
    <strong>${r.stars}/5 · ${esc(r.author)}</strong>
    <small>Отзыв #${r.id} · <a href="/events/${r.event}">${esc(r.eventTitle)}</a></small>
    <p>${esc(r.body)}</p>
    ${r.hidden ? `<p class="muted">Скрыт · ${esc(r.reason)}</p>` : ""}
    <div class="actions">${adminAction(r.hidden ? "Восстановить отзыв" : "Скрыть отзыв", r.hidden ? "show" : "hide", r.id)}</div>
  </article>`;
}

function adminLogRows(items) {
  return `<div class="adminTable" tabindex="0" aria-label="Журнал действий"><table>
    <thead><tr><th>Время UTC</th><th>Автор</th><th>Действие</th><th>Объект</th><th>IP</th></tr></thead>
    <tbody>${items.map((l) => `<tr><td>${esc(l.at)}</td>
      <td>${l.actor ? `<a href="/admin?tab=users&q=${l.actor}">#${l.actor}</a>` : "—"}</td>
      <td>${esc(l.action)}</td><td>${esc(l.target)}</td><td>${esc(l.ip)}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function adminFilters(tab) {
  const eventStates = { "": "Все статусы", ...status };
  const filters = {
    events: select("status", "Статус", eventStates) + select("when", "Дата", { "": "Все даты", upcoming: "Предстоящие" }),
    users: select("state", "Статус", { "": "Все аккаунты", active: "Активные", banned: "Заблокированные", deleted: "Удалённые", admin: "Администраторы" }),
    reviews: select("state", "Видимость", { "": "Все отзывы", visible: "Видимые", hidden: "Скрытые" }) +
      '<label>Оценка<select name="stars"><option value="">Все оценки</option><option value="low">1–2 звезды</option>' +
      [1, 2, 3, 4, 5].map((star) => `<option>${star}</option>`).join("") + '</select></label>',
    logs: '<label>ID автора<input type="number" name="actor" min="1" step="1"></label>',
  };
  const placeholders = { events: "Название, спорт, организатор или ID", users: "Имя, почта или ID", reviews: "Текст, автор или событие", logs: "Действие, объект или IP" };
  return `<form class="form adminFilters" id="admin-filters" action="/admin">
    <input type="hidden" name="tab" value="${tab}">
    <label>Поиск<input name="q" maxlength="100" placeholder="${placeholders[tab]}"></label>
    ${filters[tab]}
    <div class="actions"><button class="btn lime">Найти</button>${link("/admin?tab=" + tab, "Сбросить", "light")}</div>
  </form>`;
}

function adminBulkForm() {
  return `<form class="form adminFilters adminBulk" id="admin-bulk">
    <label class="adminCheck"><input type="checkbox" id="admin-select-page">Выбрать страницу</label>
    ${select("status", "Действие для выбранных", { approved: "Одобрить", rejected: "Отклонить", removed: "Снять с публикации" })}
    ${input("reason", "Причина", "text", 'minlength="3" maxlength="300"')}
    <button class="btn light">Применить</button>
  </form>`;
}

function adminDialog(title, content, onSubmit) {
  const dialog = $("#admin-dialog");
  dialog.innerHTML = `<form class="form" id="admin-dialog-form"><h2>${title}</h2>${content}
    <p class="error" role="alert"></p><div class="actions"><button class="btn lime" type="submit">Подтвердить</button>
    <button class="btn light" type="button" id="admin-dialog-cancel">Отмена</button></div></form>`;
  $("#admin-dialog-cancel").onclick = () => dialog.close();
  handleForm("admin-dialog-form", async (fields) => {
    await onSubmit(fields);
    dialog.close();
    admin().catch((error) => { $("#admin-notice").textContent = error.message; });
  });
  dialog.showModal();
}

async function admin() {
  const params = new URLSearchParams(location.search);
  const requested = params.get("tab");
  const tab = Object.hasOwn(adminSections, requested) ? requested : "events";
  params.delete("tab");
  params.set("limit", "20");
  const [overview, page] = await Promise.all([api("/admin/overview"), api("/admin/" + tab + "?" + params)]);
  const render = { events: adminEventRow, users: adminUserRow, reviews: adminReviewRow };
  const rows = !page.items.length ? '<p class="muted">По этим фильтрам записей нет.</p>' :
    tab === "logs" ? adminLogRows(page.items) : page.items.map(render[tab]).join("");
  const next = new URLSearchParams(params);
  next.delete("limit");
  next.set("tab", tab);
  const first = new URLSearchParams(next);
  first.delete("before");
  next.set("before", page.nextBefore);
  main.innerHTML = crumb("Администрирование") +
    '<div class="sectionTop"><h1 class="pageTitle">Администрирование</h1>' + link("/shop/admin", "Товары и заказы") + "</div>" +
    `<div class="adminMetrics">${adminCounts(overview)}</div>
      <nav class="adminTabs" aria-label="Разделы администрирования">${Object.entries(adminSections).map(([key, label]) =>
        `<a href="/admin?tab=${key}" ${key === tab ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>` +
    panel(adminSections[tab], adminFilters(tab) +
      '<p id="admin-notice" class="error" role="alert"></p>' +
      (tab === "events" && page.items.length ? adminBulkForm() : "") + rows +
      `<div class="actions adminPages">${params.has("before") ? link("/admin?" + first, "К первой странице", "light") : ""}
      ${page.nextBefore ? link("/admin?" + next, "Следующая страница", "light") : ""}</div>`) +
    '<dialog id="admin-dialog" class="adminDialog"></dialog>';
  for (const field of $("#admin-filters").elements) {
    if (field.name && params.has(field.name)) field.value = params.get(field.name);
  }
  if ($("#admin-bulk")) {
    const boxes = [...document.querySelectorAll('input[name="ids"]')];
    const selectPage = $("#admin-select-page");
    selectPage.onchange = () => boxes.forEach((box) => { box.checked = selectPage.checked; });
    boxes.forEach((box) => { box.onchange = () => {
      const count = boxes.filter((item) => item.checked).length;
      selectPage.checked = count === boxes.length;
      selectPage.indeterminate = count > 0 && count < boxes.length;
    }; });
    $("#admin-bulk").onsubmit = async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const ids = formData.getAll("ids").map(Number);
      const notice = $("#admin-notice");
      if (!ids.length) { notice.textContent = "Выберите мероприятия."; return; }
      const submit = event.submitter;
      if (!confirm(`Применить действие к ${ids.length} выбранным мероприятиям?`)) return;
      submit.disabled = true;
      try {
        const result = await api("/admin/events/bulk", "POST", { ids, status: formData.get("status"), reason: formData.get("reason") });
        await admin();
        $("#admin-notice").textContent = "Обновлено мероприятий: " + result.updated;
      } catch (error) {
        $("#admin-notice").textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    };
  }
  for (const button of main.querySelectorAll("[data-admin-action]")) {
    button.onclick = () => runAdminAction(button);
  }
}

async function runAdminAction(button) {
  const { adminAction: action, id } = button.dataset;
  const users = "/admin/users/" + id;
  const reason = input("reason", "Причина", "text", 'minlength="3" maxlength="300"');
  if (action === "points") {
    const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    adminDialog("Корректировка баллов", input("delta", "Изменение баланса, например 20 или −10", "number", 'min="-10000" max="10000" step="1"') + reason,
      (fields) => api(users + "/points", "POST", { delta: Number(fields.delta), reason: fields.reason, requestId }));
    return;
  }
  if (action === "hide" || action === "show") {
    adminDialog(action === "hide" ? "Скрыть отзыв" : "Восстановить отзыв", reason,
      (fields) => api("/admin/reviews/" + id, "POST", { hidden: action === "hide", reason: fields.reason }));
    return;
  }
  const confirmations = {
    revoke: "Завершить все сессии пользователя?",
    ban: "Заблокировать пользователя и отменить его записи без отметки о посещении?",
    unban: "Разблокировать пользователя?",
    delete: "Удалить данные аккаунта и снять его мероприятия с публикации?",
    removed: "Снять мероприятие с публикации?",
  };
  if (confirmations[action] && !confirm(confirmations[action])) return;
  button.disabled = true;
  try {
    if (action === "revoke") await api(users + "/sessions/revoke", "POST");
    else if (["ban", "unban", "delete"].includes(action)) await api(users, "POST", { action });
    else await api("/admin/events/" + id, "POST", { status: action });
    await admin();
  } catch (error) {
    $("#admin-notice").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
