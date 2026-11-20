function seriesFields(sport, items, single, selected) {
  return '<label>Серия мероприятий<select name="seriesChoice">' +
    (single ? '<option value="">Разовое мероприятие</option>' : '<option value="">Выберите вариант</option>') +
    '<option value="new">Начать новую серию</option>' +
    items.filter((item) => sportKey(item.sport) === sportKey(sport)).map((item) =>
      '<option value="' + item.id + '"' + (item.id === selected ? ' selected' : '') + '>' + esc(item.title) + '</option>'
    ).join('') +
    '</select></label><label data-series-title hidden>Название серии<input name="seriesTitle" type="text" minlength="3" maxlength="100" disabled></label>';
}

function bindSeriesFields(region) {
  const choice = region.querySelector('[name=seriesChoice]');
  const title = region.querySelector('[data-series-title]');
  const field = title.querySelector('input');
  const sync = () => {
    title.hidden = choice.value !== 'new';
    field.disabled = title.hidden;
    field.required = !title.hidden;
  };
  choice.addEventListener('change', sync);
  sync();
}

function seriesPayload(values) {
  if (values.seriesChoice === 'new') return { seriesTitle: values.seriesTitle };
  if (values.seriesChoice) return { seriesId: Number(values.seriesChoice) };
  return {};
}

async function buildCreateSeries() {
  const items = await api('/series/mine');
  const region = $('#create-series');
  const sport = $('#create [name=sport]');
  const id = Number(new URLSearchParams(location.search).get('series'));
  const chosen = items.find((s) => s.id === id);
  if (chosen) sport.value = chosen.sport;
  const draw = (selected) => {
    region.innerHTML = seriesFields(sport.value, items, true, selected);
    bindSeriesFields(region);
  };
  draw(chosen?.id);
  sport.addEventListener('change', () => draw(undefined));
}

async function fillEventSeries(event) {
  const region = $('#event-series');
  if (event.seriesId) {
    // Keep the historical link visible even while the edition's history loads.
    region.innerHTML = panel('Серия мероприятий', link('/series/' + event.seriesId, 'История выпусков', 'light'));
    const info = await api('/series/' + event.seriesId).catch(() => null);
    if (!info) return;
    const edition = info.editions.find((item) => item.id === event.id);
    const number = edition ? '<p>' + edition.edition + '-й выпуск · ' + edition.year + ' · ' + edition.seriesYear + '-й год серии</p>' : '';
    region.innerHTML = panel(esc(info.title), number + link('/series/' + info.id, 'История выпусков', 'light'));
    return;
  }
  if (me?.id !== event.owner || event.status !== 'approved') return;
  const items = await api('/series/mine');
  region.innerHTML = panel('Серия мероприятий', '<details><summary>Добавить событие в историю серии</summary><p>Свяжите этот выпуск с другими мероприятиями того же вида спорта.</p>' +
    form('link-series', seriesFields(event.sport, items, false), 'Связать с серией') + '</details>');
  bindSeriesFields(region);
  region.querySelector('[name=seriesChoice]').required = true;
  handleForm('link-series', async (values) => {
    await api('/events/' + event.id + '/series', 'PUT', seriesPayload(values));
    location.reload();
  });
}

async function seriesPage() {
  const series = await api(route);
  const completed = series.editions.filter((e) => e.completed).reverse();
  const upcoming = series.editions.filter((e) => !e.completed);
  function editions(entries) {
    return entries.map((e) => '<article class="row edition-row"><span class="edition-year">' + e.year +
      '</span><div><a class="link" href="/events/' + e.id + '"><strong>' + esc(e.title) + '</strong></a><p>' +
      e.edition + '-й выпуск · ' + e.seriesYear + '-й год серии</p><span class="muted">' + date(e.start) +
      ' МСК · ' + esc(e.place) + (e.completed ? ' · Посещений: ' + e.attended : '') + '</span></div></article>').join('');
  }
  main.innerHTML = crumb("История серии") + '<div class="sectionTop"><div><p class="muted">' +
    esc(series.city) + ' · ' + esc(series.sport) + '</p><h1 class="pageTitle">' + esc(series.title) + '</h1></div>' +
    (me?.id === series.owner ? link('/create?series=' + series.id, 'Добавить выпуск') : '') + '</div>' +
    panel('О серии', '<p>Организатор · <a class="link" href="/people/' + series.owner + '">' + esc(series.organizer) +
      '</a></p><div class="stats"><div><b>' + completed.length + '</b>Завершённые выпуски</div><div><b>' +
      series.yearsHeld + '</b>Годы проведения</div></div>') +
    (upcoming.length ? panel('Ближайшие выпуски', editions(upcoming)) : '') +
    panel('История проведений', editions(completed) || '<p>Первый завершённый выпуск появится здесь.</p>') +
    link('/organizers', 'К рейтингу', 'light');
}

async function rankingPage() {
  const query = new URLSearchParams(location.search);
  const year = query.get('year') || '';
  const period = year ? '?' + new URLSearchParams({ year }) : '';
  const [data, series] = await Promise.all([api('/organizers/leaderboard' + period), api('/series/leaderboard' + period)]);
  const options = '<option value="">За всё время</option>' + data.years.map((item) =>
    '<option value="' + item.year + '"' + (String(item.year) === year ? ' selected' : '') + '>' + item.year + '</option>').join('');
  main.innerHTML = crumb('Рейтинг') +
    '<div class="sectionTop"><div><p class="eyebrow">' + esc(data.city) + '</p><h1 class="pageTitle">Рейтинг</h1></div>' +
    '<label>Период<select id="ranking-period">' + options + '</select></label></div>' +
    '<p class="muted">Места определяются по числу завершённых одобренных мероприятий, на которых подтвердили хотя бы одного участника.</p>' +
    '<div class="cabinet-grid">' +
    panel('Организаторы', '<p>Мероприятий за период: <b>' + data.totalEvents + '</b></p>' +
      (data.organizers.length ? '<ol class="leaderboard">' + data.organizers.map((o) =>
        '<li><div><a href="/people/' + o.id + '" class="link">' + esc(o.name) + '</a><strong aria-label="Событий: ' + o.events + '">' + o.events + '</strong></div></li>').join('') +
        '</ol>' : '<p>За этот период пока нет подтверждённых мероприятий.</p>')) +
    panel('Серии мероприятий', series.length ? '<ol class="leaderboard">' + series.map((s) =>
      '<li><div><a href="/series/' + s.id + '" class="link">' + esc(s.title) +
      '</a><strong aria-label="Выпусков: ' + s.events + '">' + s.events + '</strong></div><p class="muted">' +
      esc(s.organizer) + ' · ' + esc(s.sport) + ' · Сезонов в периоде: ' + s.years + '</p></li>').join('') +
      '</ol>' : '<p>Организаторы могут связать свои события в серию.</p>') + '</div>';
  $('#ranking-period').onchange = ({ target }) => {
    location.assign('/organizers' + (target.value ? '?year=' + encodeURIComponent(target.value) : ''));
  };
}
