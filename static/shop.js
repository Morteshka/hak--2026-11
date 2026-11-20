const shopKinds = { physical: "Товар", badge: "Значок", theme: "Тема профиля" };
const shopThemes = { mint: "Мятная", ocean: "Океан", violet: "Сирень", amber: "Янтарь" };
const orderStates = { reserved: "Зарезервирован", ready: "Готов к выдаче", fulfilled: "Получен", cancelled: "Отменён · баллы возвращены" };
const pointKinds = { attendance: "Участие в мероприятии", organization: "Проведено мероприятие", city_bonus: "Бонус организатора города", purchase: "Покупка в магазине", refund: "Возврат за заказ", admin_adjustment: "Корректировка администратором" };

function profileIdentity(person, style, isOwn) {
  const theme = Object.hasOwn(shopThemes, style.theme) ? style.theme : "default";
  return '<section class="profile-head profile-' + theme + '"><div class="profile-initial">' +
    esc(person.name.trim().slice(0, 1).toUpperCase()) + '</div><div><p class="muted">' +
    (isOwn ? "Личный кабинет" : esc(person.city)) + '</p><h1 class="pageTitle">' + esc(person.name) +
    '</h1><p>Уровень ' + person.level + (style.badge ? ' <span class="badge">' + esc(style.badge) + '</span>' : "") +
    '</p></div></section>';
}

function orderMarkup(order) {
  const instruction = order.kind === "physical" && ["reserved", "ready"].includes(order.status)
    ? "<p>" + esc(order.pickup) + "</p>" : "";
  return '<div class="row order-row"><div><strong>' + esc(order.title) +
    '</strong><span class="muted">Заказ № ' + order.id + ' · ' + shopKinds[order.kind] + '</span>' + instruction +
    '</div><span class="order-state">' + orderStates[order.status] + '</span></div>';
}

async function fillCabinet(node) {
  try {
    const wallet = await api("/wallet");
    const header = $("#profile-identity");
    if (header) header.innerHTML = profileIdentity(me, wallet.decoration, true);
    const rewards = wallet.organizer;
    const orderList = wallet.orders.map(orderMarkup).join("") || "<p>Покупки появятся здесь.</p>";
    const history = wallet.history.map((entry) =>
      '<div class="row order-row"><span>' + pointKinds[entry.kind] + '</span><b class="' +
      (entry.delta > 0 ? "point-plus" : "") + '">' + (entry.delta > 0 ? "+" : "") + entry.delta + '</b></div>').join("");
    node.innerHTML =
      panel("Баллы", '<div class="wallet-line"><strong>' + wallet.balance + '</strong>' + link("/shop", "В магазин") + '</div>' +
        '<p class="muted">Баллы начисляются за подтверждённое участие и проведение мероприятий.</p>') +
      panel("Награды организатора", '<p>' + esc(rewards.city) + ' · засчитано мероприятий: <b>' + rewards.rewardedEvents +
        '</b></p><progress max="5" value="' + rewards.rewardedEvents % 5 + '"></progress><p>Следующий бонус в 40 баллов — за ' +
        rewards.nextMilestone + '-е мероприятие.</p>' + link("/organizers", "Рейтинг города", "light")) +
      panel("Украшения профиля", decorationForm(wallet)) +
      panel("Мои заказы", orderList) +
      panel("История баллов", history || "<p>Начислений и покупок пока нет.</p>");
    if ($("#decoration-form")) handleForm("decoration-form", async (values) => {
      await api("/profile/decoration", "PUT", {
        badge: values.badge ? Number(values.badge) : null,
        theme: values.theme ? Number(values.theme) : null,
      });
      await fillCabinet(node);
      node.querySelector("#decoration-form").insertAdjacentHTML("afterend", '<p class="point-plus" role="status">Оформление сохранено</p>');
    });
  } catch (error) {
    node.textContent = error.message;
  }
}

function decorationForm(wallet) {
  const digital = wallet.orders.filter((o) => o.kind !== "physical" && o.status === "fulfilled");
  if (!digital.length) return "<p>Значки и темы можно купить в магазине.</p>";
  const options = (kind, selected) => '<option value="">По умолчанию</option>' +
    digital.filter((order) => order.kind === kind).map((order) => '<option value="' + order.id + '"' +
      (order.id === selected ? " selected" : "") + '>' + esc(order.title) + '</option>').join("");
  return form("decoration-form", '<div class="cols"><label>Значок<select name="badge">' +
    options("badge", wallet.decoration.badgeOrder) + '</select></label><label>Тема<select name="theme">' +
    options("theme", wallet.decoration.themeOrder) + '</select></label></div>', "Сохранить оформление") +
    '<p>' + link("/people/" + me.id, "Открыть публичный профиль", "light") + '</p>';
}

async function shopPage() {
  const [products, wallet] = await Promise.all([api("/shop/products"), me ? api("/wallet") : null]);
  const owned = new Set(wallet?.orders.filter((order) => order.kind !== "physical").map((order) => order.product));
  const adminLink = me?.role === "admin" ? link("/shop/admin", "Управление магазином", "light") : "";
  main.innerHTML = crumb("Магазин") +
    '<div class="sectionTop"><h1 class="pageTitle">Магазин баллов</h1><div class="actions">' +
    (wallet ? '<span class="wallet-pill" id="shop-balance">' + wallet.balance + ' баллов</span>' : link("/login?next=/shop", "Войти")) +
    adminLink + '</div></div>' +
    '<p class="muted">Украшения доступны сразу. Физические товары можно забрать по инструкции в заказе.</p>' +
    (products.length ? '<div class="grid shop-grid">' + products.map((p) => {
      const title = esc(p.title);
      const media = p.image
        ? '<img src="' + esc(p.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
        : ic(p.kind === "physical" ? "shopping-bag" : p.kind === "badge" ? "award" : "palette");
      const availability = p.kind === "physical" ? (p.stock > 0 ? "В наличии: " + p.stock : "Нет в наличии") : "Цифровая награда";
      const action = owned.has(p.id) ? link("/profile#wallet", "В кабинете", "light") :
        p.stock === 0 ? '<button class="btn light" disabled>Нет в наличии</button>' :
          wallet ? '<button class="btn lime" data-buy="' + p.id + '">Купить · ' + p.price + '</button>' :
            link("/login?next=/shop", "Войти для покупки");
      return '<article class="card product-card"><div class="product-art profile-' + (shopThemes[p.theme] ? p.theme : "default") + '">' + media +
        '</div><div class="cardBody"><span class="tag">' + shopKinds[p.kind] + '</span><h2>' + title +
        '</h2><p>' + esc(p.description) + '</p><p class="muted">' + availability +
        '</p><div class="cardFoot"><strong>' + p.price + ' баллов</strong>' + action + '</div></div></article>';
    }).join("") + '</div>' : panel("Наград пока нет", "<p>Товары появятся после публикации администратором.</p>")) +
    '<dialog id="purchase-dialog" aria-labelledby="purchase-title"></dialog>';
  for (const button of main.querySelectorAll("[data-buy]")) {
    button.onclick = () => confirmPurchase(products.find((item) => item.id === Number(button.dataset.buy)));
  }
}

function confirmPurchase(product) {
  const dialog = $("#purchase-dialog");
  dialog.innerHTML = '<h2 id="purchase-title">Подтвердите покупку</h2><p>' + esc(product.title) +
    ' · ' + product.price + ' баллов</p>' +
    form("purchase-form", "", "Купить за баллы") + '<p><button class="btn light" type="button" id="close-purchase">Назад</button></p>';
  dialog.querySelector("#close-purchase").onclick = () => dialog.close();
  handleForm("purchase-form", async () => {
    const storageKey = "temp.purchase." + me.id + "." + product.id;
    let requestId = sessionStorage.getItem(storageKey);
    if (!requestId) {
      requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem(storageKey, requestId);
    }
    try {
      const result = await api("/shop/orders", "POST", { product: product.id, requestId });
      sessionStorage.removeItem(storageKey);
      $("#shop-balance").textContent = result.balance + " баллов";
      dialog.innerHTML = '<h2 id="purchase-title">Покупка оформлена</h2>' + orderMarkup(result.order) +
        '<div class="actions">' + link("/profile#wallet", "Мои заказы") + link("/shop", "К магазину", "light") + '</div>';
      dialog.addEventListener("close", () => shopPage(), { once: true });
    } catch (error) {
      if ([400, 403, 404, 409].includes(error.status)) sessionStorage.removeItem(storageKey);
      throw error;
    }
  });
  dialog.showModal();
}

async function publicProfile() {
  const person = await api(route);
  main.innerHTML = crumb("Профиль спортсмена") + profileIdentity(person, person, false) +
    panel("Спортивная активность", '<div class="stats"><div><b>' + person.attended + '</b>Посещено</div><div><b>' +
      person.held + '</b>Проведено</div></div>') + link("/organizers", "Рейтинг организаторов", "light");
}

async function shopAdmin() {
  const state = await api("/admin/shop");
  main.innerHTML = crumb("Управление магазином") + '<div class="sectionTop"><h1 class="pageTitle">Управление магазином</h1><div class="actions">' +
    link("/admin", "Админка", "light") + link("/shop", "Витрина", "light") + '</div></div>' +
    panel("Товары", '<button class="btn lime" id="new-product">Добавить товар</button>' + (state.products.length ? state.products.map((p) =>
      '<div class="row order-row"><div><strong>' + esc(p.title) + '</strong><span class="muted">' + shopKinds[p.kind] + ' · ' + p.price +
      ' баллов · ' + (p.active ? "На витрине" : "Скрыт") + (p.kind === "physical" ? " · Остаток: " + p.stock : "") +
      '</span></div><button class="btn light" data-edit-product="' + p.id + '">Редактировать</button></div>').join("") : "<p>Товаров пока нет.</p>")) +
    panel("Заказы на выдачу", '<div id="order-error" class="error" role="alert"></div>' + (state.orders.length ? state.orders.map((o) => {
      const actions = o.status === "reserved" ? [["ready", "Готов к выдаче"], ["cancelled", "Отменить"]] :
        o.status === "ready" ? [["fulfilled", "Выдан"], ["cancelled", "Отменить"]] : [];
      return '<div class="order-admin">' + orderMarkup(o) + '<p class="muted">Получатель: ' + esc(o.buyer) + ' · аккаунт № ' + o.user +
        '</p><div class="actions">' + actions.map(([status, label]) => '<button class="btn light" data-order-id="' + o.id +
          '" data-order-status="' + status + '">' + label + '</button>').join("") + '</div></div>';
    }).join("") : "<p>Заказов пока нет.</p>")) + '<dialog id="product-dialog" aria-labelledby="product-title"></dialog>';
  $("#new-product").onclick = () => editProduct(null);
  for (const button of main.querySelectorAll("[data-edit-product]")) {
    button.onclick = () => editProduct(state.products.find((p) => p.id === Number(button.dataset.editProduct)));
  }
  for (const button of main.querySelectorAll("[data-order-id]")) {
    button.onclick = async () => {
      const status = button.dataset.orderStatus;
      if (status === "cancelled" && !confirm("Отменить заказ и вернуть покупателю баллы?")) return;
      if (status === "fulfilled" && !confirm("Подтвердить, что товар выдан?")) return;
      button.disabled = true;
      try {
        await api("/admin/shop/orders/" + button.dataset.orderId, "POST", { status });
        await shopAdmin();
      } catch (error) {
        $("#order-error").textContent = error.message;
        button.disabled = false;
      }
    };
  }
}

function editProduct(product) {
  const dialog = $("#product-dialog");
  dialog.innerHTML = '<h2 id="product-title">' + (product ? "Редактировать товар" : "Добавить товар") +
    '</h2>' + form("product-form",
      input("title", "Название", "text", "minlength=2 maxlength=90") +
      '<label>Описание<textarea name="description" minlength="4" maxlength="1000" required></textarea></label>' +
      select("kind", "Тип товара", shopKinds) +
      input("price", "Цена в баллах", "number", 'min="1" max="100000"') +
      '<div id="physical-fields" class="form">' + input("stock", "Свободный остаток", "number", 'min="0" max="100000"') +
      '<label>Инструкция по получению<textarea name="pickup" minlength="5" maxlength="500" required></textarea></label></div>' +
      '<div id="theme-field">' + select("theme", "Тема оформления", shopThemes) + '</div>' +
      '<label>HTTPS-ссылка на фото<input name="image" type="url" maxlength="1500"></label>' +
      '<label class="inline-field"><input name="active" type="checkbox"> Показывать в магазине</label>',
      "Сохранить") + '<p><button type="button" class="btn light" id="close-product">Отмена</button></p>';
  const controls = $("#product-form").elements;
  for (const field of ["title", "description", "price", "stock", "pickup", "theme", "image"]) {
    if (product && product[field] != null && product[field] !== "") controls[field].value = product[field];
  }
  controls.kind.value = product?.kind || "physical";
  controls.kind.disabled = !!product;
  controls.active.checked = product ? product.active === 1 : true;
  const sync = () => {
    const physical = controls.kind.value === "physical";
    $("#physical-fields").hidden = !physical;
    controls.stock.disabled = !physical;
    controls.pickup.disabled = !physical;
    $("#theme-field").hidden = controls.kind.value !== "theme";
  };
  controls.kind.onchange = sync;
  sync();
  $("#close-product").onclick = () => dialog.close();
  handleForm("product-form", async (value) => {
    await api("/admin/shop/products" + (product ? "/" + product.id : ""), product ? "PUT" : "POST", {
      ...value, kind: controls.kind.value, active: controls.active.checked,
      price: Number(value.price), stock: value.stock === undefined ? null : Number(value.stock),
      expectedStock: product?.stock ?? null,
    });
    dialog.close();
    await shopAdmin();
  });
  dialog.showModal();
}
