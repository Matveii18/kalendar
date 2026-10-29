// Интерфейс: месяц, день, «Сегодня / Завтра», формы записей, справочники.

const ui = {
  view: 'month',
  selected: todayYmd(),
  cursor: (() => { const [y, m] = todayYmd().split('-').map(Number); return { y, m }; })(),
};

const $ = sel => document.querySelector(sel);
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- Навигация ---------- */

function go(v) {
  ui.view = v;
  closeDrawer();
  render();
}

function render() {
  document.body.dataset.view = ui.view.split(':')[0];
  $('#todayBtn').textContent = Number(todayYmd().slice(8));
  const monthNav = ui.view === 'month';
  $('#prevBtn').hidden = !monthNav;
  $('#nextBtn').hidden = !monthNav;
  $('#addBar').hidden = !(ui.view === 'month' || ui.view === 'today');

  if (ui.view === 'month') renderMonth();
  else if (ui.view === 'today') renderToday();
  else if (ui.view.startsWith('dir:')) renderDirectory(ui.view.slice(4));
  else if (ui.view === 'school') renderSchool();
  else if (ui.view === 'data') renderData();

  const addFor = ui.view === 'today' ? todayYmd() : ui.selected;
  $('#addLabel').textContent = `Добавить на ${fmtShort(addFor)}`;
}

/* ---------- Месяц ---------- */

function renderMonth() {
  const { y, m } = ui.cursor;
  $('#title').textContent = MONTHS[m - 1] + (y !== Number(todayYmd().slice(0, 4)) ? ` ${y}` : '');

  const first = `${y}-${pad(m)}-01`;
  const start = addDays(first, 1 - weekday(first));
  const last = `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
  const rows = Math.ceil((diffDays(start, last) + 1) / 7);
  const today = todayYmd();

  let cells = '';
  for (let i = 0; i < rows * 7; i++) {
    const d = addDays(start, i);
    const items = itemsForDay(d);
    const inMonth = d.slice(0, 7) === first.slice(0, 7);
    const cls = ['cell'];
    if (!inMonth) cls.push('out');
    if (d === today) cls.push('today');
    if (d === ui.selected) cls.push('sel');
    if (weekday(d) === 7) cls.push('sun');
    if (items.length) cls.push('has');
    cells += `<button class="${cls.join(' ')}" data-day="${d}">
      <span class="num">${Number(d.slice(8))}</span>
      <span class="bars">${cellBars(items)}</span>
    </button>`;
  }

  view.innerHTML = `
    <div class="month-layout">
      <section class="grid-wrap">
        <div class="wd-row">${[1, 2, 3, 4, 5, 6, 7].map(i => `<span class="${i === 7 ? 'sun' : ''}">${WD[i]}</span>`).join('')}</div>
        <div class="grid" style="grid-template-rows:repeat(${rows},1fr)">${cells}</div>
      </section>
      <section class="day-panel">
        <div class="day-head"><span class="big">${Number(ui.selected.slice(8))}</span><span class="wd">${WD[weekday(ui.selected)]}</span>
          <span class="day-sub">${fmtLong(ui.selected)}</span></div>
        ${dayList(itemsForDay(ui.selected), true)}
      </section>
    </div>`;

  view.querySelectorAll('.cell').forEach(c => c.addEventListener('click', () => {
    const d = c.dataset.day;
    if (d === ui.selected && window.matchMedia('(max-width: 899px)').matches) { openTypePicker(d); return; }
    ui.selected = d;
    const [cy, cm] = d.split('-').map(Number);
    if (cy !== ui.cursor.y || cm !== ui.cursor.m) ui.cursor = { y: cy, m: cm };
    render();
  }));
  bindList(view);
  bindSwipe(view.querySelector('.grid'));
}

function cellBars(items) {
  const bars = [];
  const lessons = items.filter(i => i.type === 'school');
  for (const it of items) {
    if (it.type === 'school') continue;
    const cls = ['bar'];
    if (it.period) { cls.push('period'); if (it.isStart) cls.push('ps'); if (it.isEnd) cls.push('pe'); }
    if (it.done) cls.push('done');
    if (it.overdue) cls.push('late');
    bars.push(`<span class="${cls.join(' ')}" style="--c:${TYPES[it.type].color}">${esc(it.start ? `${it.start} ${it.title}` : it.title)}</span>`);
  }
  if (lessons.length) {
    const a = lessons[0].entry.lesson, b = lessons[lessons.length - 1].entry.lesson;
    bars.push(`<span class="bar" style="--c:${TYPES.school.color}">Уроки ${a === b ? a : `${a}–${b}`}</span>`);
  }
  const max = 3;
  if (bars.length > max) return bars.slice(0, max - 1).join('') + `<span class="more">+${bars.length - max + 1}</span>`;
  return bars.join('');
}

function bindSwipe(el) {
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
  });
}

function shiftMonth(delta) {
  let { y, m } = ui.cursor;
  m += delta;
  if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
  ui.cursor = { y, m };
  const day = Math.min(Number(ui.selected.slice(8)), daysInMonth(y, m));
  ui.selected = `${y}-${pad(m)}-${pad(day)}`;
  render();
}

/* ---------- Список записей дня ---------- */

const itemIndex = new Map();

function dayList(items, showEmpty) {
  if (!items.length) {
    return showEmpty ? `<div class="empty">Записей нет. Нажми «+», чтобы добавить.</div>` : '';
  }
  return `<div class="list">${items.map(itemRow).join('')}</div>`;
}

function itemRow(it) {
  itemIndex.set(it.key, it);
  const cls = ['item'];
  if (it.done) cls.push('done');
  if (it.overdue) cls.push('late');
  const check = it.checkable
    ? `<span class="check ${it.done ? 'on' : ''}" data-check="${esc(it.key)}" role="checkbox" aria-checked="${!!it.done}"></span>` : '';
  const time = it.allDay
    ? `<div class="time"><span class="tag">${it.type === 'hw' ? 'сдать' : TYPES[it.type].label.toLowerCase()}</span></div>`
    : `<div class="time"><b>${it.start}${it.end ? `<span class="to">–${it.end}</span>` : ''}</b>${it.alt ? `<small>${esc(it.alt)}</small>` : ''}</div>`;
  const warn = it.conflicts && it.conflicts.length
    ? `<div class="warn">⚠ Накладка с уроками: ${it.conflicts.map(c => esc(c.title)).join(', ')}</div>` : '';
  const late = it.overdue ? `<div class="warn">Просрочено</div>` : '';
  return `<div class="${cls.join(' ')}" data-key="${esc(it.key)}">
    <span class="strip" style="background:${TYPES[it.type].color}"></span>
    ${check}
    <div class="body"><div class="t">${esc(it.title)}</div>${it.sub ? `<div class="s">${esc(it.sub)}</div>` : ''}${warn}${late}</div>
    ${time}
  </div>`;
}

function bindList(root) {
  root.querySelectorAll('[data-check]').forEach(el => el.addEventListener('click', ev => {
    ev.stopPropagation();
    toggleDone(itemIndex.get(el.dataset.check));
    render();
  }));
  root.querySelectorAll('.item').forEach(el => el.addEventListener('click', () => {
    const it = itemIndex.get(el.dataset.key);
    if (!it) return;
    if (it.type === 'sub') openDirForm('subs', it.entry);
    else if (it.type === 'school') openSchoolCell(it.entry.weekday, it.entry.lesson);
    else openEntryForm(it.entry.type, it.entry, it);
  }));
}

/* ---------- Сегодня / Завтра ---------- */

function renderToday() {
  $('#title').textContent = 'сегодня';
  const today = todayYmd(), tomorrow = addDays(today, 1);
  const hwTomorrow = Store.all('entries').filter(e => e.type === 'hw' && e.date === tomorrow && !e.done);
  const late = overdueHomework();

  let alert = '';
  if (hwTomorrow.length) alert += `<div class="callout hw">📚 На завтра ДЗ: ${hwTomorrow.length}. ${hwTomorrow.map(e => esc(Store.name('subjects', e.subjectId) || 'ДЗ')).join(', ')}</div>`;
  if (late.length) alert += `<div class="callout late">Просроченных ДЗ: ${late.length}. ${late.map(e => `${esc(Store.name('subjects', e.subjectId) || 'ДЗ')} (${fmtShort(e.date)})`).join(', ')}</div>`;

  view.innerHTML = `
    <div class="today-layout">
      ${alert}
      <section class="day-block">
        <h2>Сегодня <span>${fmtLong(today)}</span></h2>
        ${dayList(itemsForDay(today), true)}
      </section>
      <section class="day-block">
        <h2>Завтра <span>${fmtLong(tomorrow)}</span></h2>
        ${dayList(itemsForDay(tomorrow), true)}
      </section>
    </div>`;
  bindList(view);
}

/* ---------- Нижняя панель (sheet) ---------- */

function openSheet(html, onMount) {
  $('#sheet').innerHTML = html;
  $('#sheetWrap').classList.add('open');
  $('#sheetWrap').setAttribute('aria-hidden', 'false');
  if (onMount) onMount($('#sheet'));
}

function closeSheet() {
  $('#sheetWrap').classList.remove('open');
  $('#sheetWrap').setAttribute('aria-hidden', 'true');
}

$('#sheetWrap').addEventListener('click', e => { if (e.target.id === 'sheetWrap') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeDrawer(); } });

function openTypePicker(ymd) {
  const types = ['hw', 'tutor', 'task', 'period', 'other'];
  openSheet(`
    <div class="sheet-head"><h3>Добавить на ${fmtShort(ymd)}</h3></div>
    <div class="type-grid">
      ${types.map(t => `<button data-type="${t}"><span class="dot" style="background:${TYPES[t].color}"></span>${TYPES[t].label}</button>`).join('')}
    </div>`, s => {
    s.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => openEntryForm(b.dataset.type, null, null, ymd)));
  });
}

$('#addBar').addEventListener('click', () => openTypePicker(ui.view === 'today' ? todayYmd() : ui.selected));

/* ---------- Поля форм ---------- */

function options(coll, selected, emptyLabel) {
  const list = [...Store.all(coll)].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return `<option value="">${emptyLabel || '—'}</option>` +
    list.map(x => `<option value="${x.id}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

function dirSelect(name, coll, selected, emptyLabel) {
  return `<div class="row-input"><select name="${name}" data-coll="${coll}">${options(coll, selected, emptyLabel)}</select>
    <button type="button" class="mini" data-quick="${coll}" data-for="${name}" title="Добавить в список">＋</button></div>`;
}

function seg(name, values, current) {
  return `<div class="seg">${values.map(([v, l]) =>
    `<label><input type="radio" name="${name}" value="${v}" ${v === current ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
}

function field(label, html, extra = '') {
  return `<label class="field ${extra}"><span class="lbl">${label}</span>${html}</label>`;
}

function bindQuickAdd(form) {
  form.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => {
    const coll = b.dataset.quick;
    const name = (prompt(`Новая запись в «${DIRS[coll].title}»:`) || '').trim();
    if (!name) return;
    const obj = Store.upsert(coll, { name });
    form.querySelectorAll(`select[data-coll="${coll}"]`).forEach(sel => {
      const keep = sel.value;
      const emptyLabel = sel.options[0] ? sel.options[0].textContent : '—';
      sel.innerHTML = options(coll, keep, emptyLabel);
    });
    form.querySelector(`select[name="${b.dataset.for}"]`).value = obj.id;
  }));
}

function formValues(form) {
  const fd = new FormData(form), o = {};
  for (const [k, v] of fd.entries()) o[k] = typeof v === 'string' ? v.trim() : v;
  return o;
}

/* ---------- Формы записей ---------- */

function openEntryForm(type, entry, item, ymd) {
  const e = entry ? { ...entry } : { type };
  const date = ymd || ui.selected;
  const isNew = !entry;
  let body = '';

  if (type === 'hw') {
    body = `
      ${field('Предмет', dirSelect('subjectId', 'subjects', e.subjectId, 'Выбери предмет'))}
      ${field('Учитель', dirSelect('teacher1', 'teachers', (e.teacherIds || [])[0], 'Выбери учителя'))}
      ${field('Второй учитель', dirSelect('teacher2', 'teachers', (e.teacherIds || [])[1], 'Нет'))}
      ${field('Что сделать', `<textarea name="text" rows="3" placeholder="Задание">${esc(e.text)}</textarea>`)}
      ${field('Сдать до', `<input type="date" name="date" value="${e.date || date}" required>`)}
      <label class="check-line"><input type="checkbox" name="done" ${e.done ? 'checked' : ''}> Сделано</label>`;
  } else if (type === 'tutor') {
    body = `
      ${field('Репетитор', dirSelect('tutorId', 'tutors', e.tutorId, 'Выбери репетитора'))}
      ${field('Время указано', seg('tz', [['UA', 'по Украине'], ['DE', 'по Германии']], e.tz || defaultTutorTz(e.tutorId)))}
      <div class="two">
        ${field('Дата', `<input type="date" name="date" value="${e.date || date}" required>`)}
        ${field('Время', `<input type="time" name="time" value="${e.time || '18:00'}" required>`)}
      </div>
      <div class="convert" id="convert"></div>
      ${field('Длительность, мин', `<input type="number" name="duration" min="5" step="5" value="${e.duration || 60}">`)}
      ${field('Повтор', seg('repeat', [['none', 'нет'], ['weekly', 'каждую неделю']], e.repeat || 'none'))}
      ${field('Повторять до (необязательно)', `<input type="date" name="until" value="${e.until || ''}">`, 'repeat-only')}
      ${field('Заметка', `<input name="note" value="${esc(e.note)}" placeholder="Например, тема занятия">`)}
      <div class="warn" id="conflictBox"></div>`;
  } else if (type === 'task') {
    const hasDate = isNew ? true : !!e.date;
    body = `
      ${field('Задача', `<textarea name="text" rows="2" placeholder="Что сделать" required>${esc(e.text)}</textarea>`)}
      ${field('Срок', seg('when', [['date', 'на день'], ['none', 'без срока']], hasDate ? 'date' : 'none'))}
      ${field('День', `<input type="date" name="date" value="${e.date || date}">`, 'date-only')}
      ${field('Повтор', seg('repeat', [['none', 'нет'], ['daily', 'каждый день'], ['everyN', 'каждые N дней']], e.repeat || 'none'), 'date-only')}
      ${field('Каждые сколько дней', `<input type="number" name="n" min="2" value="${e.n || 2}">`, 'n-only')}
      ${field('Повторять до (необязательно)', `<input type="date" name="until" value="${e.until || ''}">`, 'rep-only')}`;
  } else if (type === 'period') {
    const kind = e.kind || 'каникулы';
    body = `
      ${field('Вид', seg('kind', PERIOD_KINDS.map(k => [k, k]), kind))}
      ${field('Название', `<input name="title" value="${esc(e.title)}" placeholder="Например, осенние каникулы">`)}
      <div class="two">
        ${field('С', `<input type="date" name="start" value="${e.start || date}" required>`)}
        ${field('По', `<input type="date" name="end" value="${e.end || date}" required>`)}
      </div>
      <label class="check-line"><input type="checkbox" name="noSchool" ${(isNew ? kind === 'каникулы' : e.noSchool) ? 'checked' : ''}> В эти дни нет уроков</label>`;
  } else if (type === 'other') {
    body = `
      ${field('Название', `<input name="title" value="${esc(e.title)}" placeholder="Что за событие" required>`)}
      ${field('Дата', `<input type="date" name="date" value="${e.date || date}" required>`)}
      ${field('Время указано', seg('tz', [['DE', 'по Германии'], ['UA', 'по Украине']], e.tz || 'DE'))}
      <div class="two">
        ${field('Начало (необязательно)', `<input type="time" name="time" value="${e.time || ''}">`)}
        ${field('Конец', `<input type="time" name="endTime" value="${e.endTime || ''}">`)}
      </div>
      <div class="convert" id="convert"></div>
      ${field('Место', `<input name="place" value="${esc(e.place)}">`)}
      ${field('Что взять', `<input name="bring" value="${esc(e.bring)}">`)}
      ${field('Что сделать до', `<input name="todo" value="${esc(e.todo)}">`)}`;
  }

  const repeating = item && ((type === 'tutor' && e.repeat === 'weekly') || (type === 'task' && e.date && e.repeat && e.repeat !== 'none'));

  openSheet(`
    <form class="entry-form" novalidate>
      <div class="sheet-head">
        <span class="dot" style="background:${TYPES[type].color}"></span>
        <h3>${isNew ? 'Новая запись' : 'Изменить'}: ${TYPES[type].label}</h3>
      </div>
      ${body}
      <div class="actions">
        ${isNew ? '' : `<button type="button" class="danger" id="delBtn">Удалить</button>`}
        <span class="grow"></span>
        <button type="button" class="ghost" id="cancelBtn">Отмена</button>
        <button type="submit" class="primary">Сохранить</button>
      </div>
    </form>`, s => {
    const form = s.querySelector('form');
    bindQuickAdd(form);
    s.querySelector('#cancelBtn').addEventListener('click', closeSheet);

    const sync = () => syncFormVisibility(type, form);
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    if (type === 'tutor') {
      form.tutorId.addEventListener('change', () => {
        const tz = defaultTutorTz(form.tutorId.value);
        form.querySelector(`input[name="tz"][value="${tz}"]`).checked = true;
        sync();
      });
    }
    sync();

    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const v = formValues(form);
      const out = buildEntry(type, e, v, form);
      if (!out) return;
      if (type === 'tutor') {
        const clash = upcomingConflicts(out);
        if (clash.length && !confirm(`Занятие накладывается на уроки:\n${clash.slice(0, 5).join('\n')}\n\nВсё равно сохранить?`)) return;
      }
      Store.upsert('entries', out);
      closeSheet();
      toast('Сохранено');
      render();
    });

    const del = s.querySelector('#delBtn');
    if (del) del.addEventListener('click', () => askDelete(e, item, repeating));
  });
}

function defaultTutorTz(tutorId) {
  const t = tutorId && Store.get('tutors', tutorId);
  return (t && t.tz) || 'UA';
}

function syncFormVisibility(type, form) {
  const v = formValues(form);
  const toggle = (cls, on) => form.querySelectorAll('.' + cls).forEach(el => { el.hidden = !on; });

  if (type === 'tutor' || type === 'other') {
    const box = form.querySelector('#convert');
    if (v.date && v.time) {
      const other = v.tz === 'UA' ? 'DE' : 'UA';
      const t = convertTime(v.date, v.time, v.tz, other);
      const dayNote = t.ymd !== v.date ? ` (${fmtShort(t.ymd)})` : '';
      box.innerHTML = `${v.time} ${v.tz === 'UA' ? 'по Украине' : 'по Германии'} = <b>${t.hm}</b> ${other === 'DE' ? 'по Германии' : 'по Украине'}${dayNote}`;
    } else box.textContent = '';
  }
  if (type === 'tutor') {
    toggle('repeat-only', v.repeat === 'weekly');
    const box = form.querySelector('#conflictBox');
    if (v.date && v.time && v.tz) {
      const it = tutorItem({ id: 'preview', date: v.date, time: v.time, tz: v.tz, duration: v.duration }, v.date);
      box.textContent = it.conflicts.length ? `⚠ Накладка с уроками: ${it.conflicts.map(c => `${c.title} (${c.start}–${c.end})`).join(', ')}` : '';
    }
  }
  if (type === 'task') {
    toggle('date-only', v.when === 'date');
    toggle('n-only', v.when === 'date' && v.repeat === 'everyN');
    toggle('rep-only', v.when === 'date' && v.repeat !== 'none');
  }
}

function buildEntry(type, base, v, form) {
  const e = { ...base, type };
  const need = (cond, msg) => { if (!cond) { toast(msg); return false; } return true; };

  if (type === 'hw') {
    if (!need(v.date, 'Укажи дату сдачи')) return null;
    if (!need(v.subjectId || v.text, 'Выбери предмет или напиши задание')) return null;
    Object.assign(e, {
      subjectId: v.subjectId || null, text: v.text, date: v.date, done: !!form.done.checked,
      teacherIds: [v.teacher1, v.teacher2].filter((x, i, a) => x && a.indexOf(x) === i),
    });
  } else if (type === 'tutor') {
    if (!need(v.date && v.time, 'Укажи дату и время')) return null;
    Object.assign(e, {
      tutorId: v.tutorId || null, tz: v.tz, date: v.date, time: v.time,
      duration: Math.max(5, +v.duration || 60), repeat: v.repeat,
      until: v.repeat === 'weekly' ? (v.until || null) : null, note: v.note,
      skip: (base.skip || []).filter(d => d >= v.date),
    });
  } else if (type === 'task') {
    if (!need(v.text, 'Напиши задачу')) return null;
    const dated = v.when === 'date';
    if (dated && !need(v.date, 'Укажи день')) return null;
    Object.assign(e, {
      text: v.text, date: dated ? v.date : null,
      repeat: dated ? v.repeat : 'none', n: Math.max(2, +v.n || 2),
      until: dated && v.repeat !== 'none' ? (v.until || null) : null,
    });
  } else if (type === 'period') {
    if (!need(v.start && v.end, 'Укажи даты')) return null;
    const [s, en] = v.start <= v.end ? [v.start, v.end] : [v.end, v.start];
    Object.assign(e, { kind: v.kind, title: v.title, start: s, end: en, noSchool: !!form.noSchool.checked });
  } else if (type === 'other') {
    if (!need(v.title, 'Напиши название')) return null;
    Object.assign(e, {
      title: v.title, date: v.date, tz: v.tz, time: v.time || null, endTime: v.time ? (v.endTime || null) : null,
      place: v.place, bring: v.bring, todo: v.todo,
    });
  }
  return e;
}

// Накладки занятия на уроки в ближайшие 8 недель (для повторяющихся) или в день занятия
function upcomingConflicts(e) {
  const out = [];
  const count = e.repeat === 'weekly' ? 8 : 1;
  let d = e.date;
  const today = todayYmd();
  if (e.repeat === 'weekly') while (d < addDays(today, -1)) d = addDays(d, 7);
  for (let i = 0; i < count; i++, d = addDays(d, 7)) {
    if (e.until && d > e.until) break;
    if ((e.skip || []).includes(d)) continue;
    const it = tutorItem(e, d);
    for (const c of it.conflicts) out.push(`${fmtShort(it.ymd)}: ${c.title} (${c.start}–${c.end})`);
  }
  return out;
}

function askDelete(e, item, repeating) {
  if (!repeating) {
    if (!confirm('Удалить запись?')) return;
    Store.remove('entries', e.id);
    closeSheet(); toast('Удалено'); render();
    return;
  }
  openSheet(`
    <div class="sheet-head"><h3>Удалить повторяющуюся запись</h3></div>
    <div class="stack">
      <button class="ghost" id="delOne">Только ${fmtShort(item.occ)}</button>
      <button class="ghost" id="delNext">Этот и все следующие</button>
      <button class="danger" id="delAll">Всю серию</button>
      <button class="ghost" id="delCancel">Отмена</button>
    </div>`, s => {
    const done = () => { closeSheet(); toast('Удалено'); render(); };
    s.querySelector('#delOne').addEventListener('click', () => {
      const cur = Store.get('entries', e.id);
      cur.skip = [...new Set([...(cur.skip || []), item.occ])];
      Store.upsert('entries', cur); done();
    });
    s.querySelector('#delNext').addEventListener('click', () => {
      const cur = Store.get('entries', e.id);
      const prev = addDays(item.occ, -1);
      if (prev < cur.date) Store.remove('entries', e.id);
      else { cur.until = prev; Store.upsert('entries', cur); }
      done();
    });
    s.querySelector('#delAll').addEventListener('click', () => { Store.remove('entries', e.id); done(); });
    s.querySelector('#delCancel').addEventListener('click', closeSheet);
  });
}

/* ---------- Справочники ---------- */

const DIRS = {
  subjects: { title: 'Предметы', fields: [['name', 'Название', 'text']] },
  teachers: { title: 'Учителя', fields: [['name', 'Имя', 'text']] },
  tutors: { title: 'Репетиторы', fields: [['name', 'Имя', 'text'], ['tz', 'Обычно называет время', 'tz'], ['note', 'Заметка', 'text']] },
  subs: { title: 'Подписки', fields: [['name', 'Сервис', 'text'], ['price', 'Цена', 'text'], ['day', 'День списания (1–31)', 'day']] },
};

function dirLine(coll, x) {
  if (coll === 'subs') return [x.price, x.day ? `${x.day}-го числа` : ''].filter(Boolean).join(' · ');
  if (coll === 'tutors') return [x.tz === 'DE' ? 'время по Германии' : 'время по Украине', x.note].filter(Boolean).join(' · ');
  return '';
}

function renderDirectory(coll) {
  const d = DIRS[coll];
  $('#title').textContent = d.title.toLowerCase();
  const list = [...Store.all(coll)].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  view.innerHTML = `
    <div class="page">
      ${coll === 'subs' ? `<p class="hint">Каждая подписка появляется в календаре каждый месяц в день списания.</p>` : ''}
      <div class="list">
        ${list.map(x => `<div class="item" data-id="${x.id}">
          <span class="strip" style="background:${coll === 'subs' ? TYPES.sub.color : coll === 'tutors' ? TYPES.tutor.color : '#555'}"></span>
          <div class="body"><div class="t">${esc(x.name)}</div>${dirLine(coll, x) ? `<div class="s">${esc(dirLine(coll, x))}</div>` : ''}</div>
        </div>`).join('') || `<div class="empty">Пока пусто.</div>`}
      </div>
      <button class="primary wide" id="dirAdd">Добавить</button>
    </div>`;
  view.querySelectorAll('.item').forEach(el => el.addEventListener('click', () => openDirForm(coll, Store.get(coll, el.dataset.id))));
  $('#dirAdd').addEventListener('click', () => openDirForm(coll, null));
}

function openDirForm(coll, obj) {
  const d = DIRS[coll];
  const x = obj ? { ...obj } : {};
  const inputs = d.fields.map(([k, label, kind]) => {
    if (kind === 'tz') return field(label, seg(k, [['UA', 'по Украине'], ['DE', 'по Германии']], x[k] || 'UA'));
    if (kind === 'day') return field(label, `<input type="number" name="${k}" min="1" max="31" value="${x[k] || ''}" required>`);
    return field(label, `<input name="${k}" value="${esc(x[k])}" ${k === 'name' ? 'required' : ''}>`);
  }).join('');

  openSheet(`
    <form class="entry-form">
      <div class="sheet-head"><h3>${d.title}: ${obj ? 'изменить' : 'добавить'}</h3></div>
      ${inputs}
      <div class="actions">
        ${obj ? `<button type="button" class="danger" id="delBtn">Удалить</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="ghost" id="cancelBtn">Отмена</button>
        <button type="submit" class="primary">Сохранить</button>
      </div>
    </form>`, s => {
    const form = s.querySelector('form');
    s.querySelector('#cancelBtn').addEventListener('click', closeSheet);
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const v = formValues(form);
      if (!v.name) { toast('Заполни название'); return; }
      if (coll === 'subs') v.day = Math.min(31, Math.max(1, +v.day || 1));
      Store.upsert(coll, Object.assign(x, v));
      closeSheet(); render();
    });
    const del = s.querySelector('#delBtn');
    if (del) del.addEventListener('click', () => {
      if (!confirm(`Удалить «${x.name}»?`)) return;
      Store.remove(coll, x.id);
      closeSheet(); render();
    });
  });
}

/* ---------- Расписание школы ---------- */

function renderSchool() {
  $('#title').textContent = 'расписание';
  const lessons = Object.keys(BELLS).map(Number);
  const head = `<div class="tt-cell tt-head"></div>` + [1, 2, 3, 4, 5].map(w => `<div class="tt-cell tt-head">${WD[w]}</div>`).join('');
  let rows = '';
  for (const l of lessons) {
    rows += `<div class="tt-cell tt-num"><b>${l}</b><small>${BELLS[l][0]}</small></div>`;
    for (let w = 1; w <= 5; w++) {
      const s = Store.all('school').find(x => x.weekday === w && x.lesson === l);
      rows += `<button class="tt-cell tt-slot ${s ? 'filled' : ''}" data-w="${w}" data-l="${l}">
        ${s ? `<span class="tt-subj">${esc(Store.name('subjects', s.subjectId) || '?')}</span><span class="tt-t">${esc([teacherNames(s.teacherIds), s.room].filter(Boolean).join(' · '))}</span>` : ''}
      </button>`;
    }
  }
  view.innerHTML = `
    <div class="page">
      <p class="hint">Уроки отсюда сами появляются в календаре каждую неделю по расписанию звонков. Позже расписание будет подтягиваться с сайта колледжа автоматически, а пока его можно заполнить вручную.</p>
      <div class="tt">${head}${rows}</div>
    </div>`;
  view.querySelectorAll('.tt-slot').forEach(b => b.addEventListener('click', () => openSchoolCell(+b.dataset.w, +b.dataset.l)));
}

function openSchoolCell(w, l) {
  const s = Store.all('school').find(x => x.weekday === w && x.lesson === l) || { weekday: w, lesson: l };
  openSheet(`
    <form class="entry-form">
      <div class="sheet-head"><span class="dot" style="background:${TYPES.school.color}"></span>
        <h3>${WD_LONG[w]}, ${l} урок (${BELLS[l][0]}–${BELLS[l][1]})</h3></div>
      ${field('Предмет', dirSelect('subjectId', 'subjects', s.subjectId, 'Выбери предмет'))}
      ${field('Учитель', dirSelect('teacher1', 'teachers', (s.teacherIds || [])[0], 'Выбери учителя'))}
      ${field('Второй учитель', dirSelect('teacher2', 'teachers', (s.teacherIds || [])[1], 'Нет'))}
      ${field('Кабинет', `<input name="room" value="${esc(s.room)}">`)}
      <div class="actions">
        ${s.id ? `<button type="button" class="danger" id="delBtn">Очистить</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="ghost" id="cancelBtn">Отмена</button>
        <button type="submit" class="primary">Сохранить</button>
      </div>
    </form>`, sh => {
    const form = sh.querySelector('form');
    bindQuickAdd(form);
    sh.querySelector('#cancelBtn').addEventListener('click', closeSheet);
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const v = formValues(form);
      if (!v.subjectId) { toast('Выбери предмет'); return; }
      Store.upsert('school', Object.assign(s, {
        subjectId: v.subjectId, room: v.room,
        teacherIds: [v.teacher1, v.teacher2].filter((x, i, a) => x && a.indexOf(x) === i),
      }));
      closeSheet(); render();
    });
    const del = sh.querySelector('#delBtn');
    if (del) del.addEventListener('click', () => { Store.remove('school', s.id); closeSheet(); render(); });
  });
}

/* ---------- Резервная копия ---------- */

function renderData() {
  $('#title').textContent = 'синхронизация';
  const u = Sync.user;
  const st = Sync.status;
  const account = u
    ? `<div class="card">
        <div class="sync-line"><span class="sync-dot ${st.state}"></span>${esc(st.text)}</div>
        <p class="hint">Вход выполнен: ${esc(u.email)}. Записи сами появляются на телефоне и ноутбуке.</p>
        <div class="actions"><button class="ghost" id="syncNow">Синхронизировать сейчас</button><span class="grow"></span><button class="danger" id="signOut">Выйти</button></div>
      </div>`
    : `<form class="card entry-form" id="loginForm">
        <p class="hint">Войди, чтобы записи были общими на телефоне и ноутбуке. Почта и пароль — те, что заданы в Supabase.</p>
        ${field('Почта', `<input type="email" name="email" autocomplete="username" required>`)}
        ${field('Пароль', `<input type="password" name="password" autocomplete="current-password" required>`)}
        <div class="actions"><span class="grow"></span><button type="submit" class="primary">Войти</button></div>
        <div class="warn" id="loginErr"></div>
      </form>`;

  view.innerHTML = `
    <div class="page">
      ${account}
      <h3 class="sub-h">Резервная копия</h3>
      <p class="hint">Можно сохранить все записи в файл или загрузить их из файла.</p>
      <button class="primary wide" id="exportBtn">Сохранить в файл</button>
      <label class="ghost wide file-btn">Загрузить из файла<input type="file" id="importInput" accept="application/json,.json" hidden></label>
    </div>`;

  const lf = $('#loginForm');
  if (lf) lf.addEventListener('submit', async ev => {
    ev.preventDefault();
    const v = formValues(lf);
    $('#loginErr').textContent = '';
    try { await Sync.signIn(v.email, lf.password.value); toast('Вход выполнен'); }
    catch (e) { $('#loginErr').textContent = 'Не получилось войти: проверь почту и пароль'; }
  });
  if ($('#syncNow')) $('#syncNow').addEventListener('click', () => Sync.now());
  if ($('#signOut')) $('#signOut').addEventListener('click', async () => {
    if (!confirm('Выйти? Записи на этом устройстве останутся, но перестанут синхронизироваться.')) return;
    await Sync.signOut(); render();
  });
  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([Store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kalendar-${todayYmd()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importInput').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    if (!f) return;
    if (!confirm('Заменить все текущие данные данными из файла?')) return;
    try { Store.importJson(await f.text()); toast('Загружено'); render(); }
    catch (e) { toast('Не получилось прочитать файл'); }
  });
}

/* ---------- Меню ---------- */

function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }

$('#menuBtn').addEventListener('click', openDrawer);
$('#drawer').addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
  else if (e.target.id === 'drawer') closeDrawer();
});
$('#prevBtn').addEventListener('click', () => shiftMonth(-1));
$('#nextBtn').addEventListener('click', () => shiftMonth(1));
$('#todayBtn').addEventListener('click', () => {
  const t = todayYmd();
  const [y, m] = t.split('-').map(Number);
  ui.selected = t; ui.cursor = { y, m };
  if (ui.view !== 'month' && ui.view !== 'today') ui.view = 'month';
  render();
});

// Раз в минуту обновляем экран, чтобы «сегодня» и просрочки были актуальны
setInterval(() => { if (!$('#sheetWrap').classList.contains('open')) render(); }, 60000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

Sync.onStatus(st => {
  $('#syncDot').className = 'sync-dot ' + st.state;
  if (ui.view === 'data' && !$('#sheetWrap').classList.contains('open') && !document.activeElement.closest('#loginForm')) render();
});

render();
Sync.init();
