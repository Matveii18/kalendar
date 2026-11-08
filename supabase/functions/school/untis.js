// Разбор страницы класса из HTML-экспорта Untis (osp2.stadt-koeln.de/untis/.../c/c00060.htm).
// Без DOM, только строки, чтобы один и тот же код работал и в браузере, и в Supabase Edge Function.
//
// Результат: список уроков { day: 1..6, periods: [3, 4], entries: [{ subject, teacher, room }] }.
// Если в одной клетке несколько записей (группы), entries содержит их все.

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function textOf(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

// Строки и ячейки таблицы верхнего уровня внутри html (вложенные таблицы остаются внутри ячеек)
function tableRows(html) {
  const re = /<(\/?)(table|tr|td|th)\b([^>]*)>/gi;
  const rows = [];
  let depth = 0;          // глубина вложенности таблиц относительно html
  let row = null;
  let cell = null;        // { attrs, start }
  let m;
  const closeCell = end => {
    if (cell && row) row.push({ attrs: cell.attrs, html: html.slice(cell.start, end) });
    cell = null;
  };
  while ((m = re.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'table') {
      if (!closing) depth++;
      else { if (depth === 1) { closeCell(m.index); } depth--; }
      continue;
    }
    if (depth !== 1) continue;
    if (tag === 'tr') {
      closeCell(m.index);
      if (!closing) { row = []; rows.push(row); }
    } else {
      closeCell(m.index);
      if (!closing) cell = { attrs: m[3], start: re.lastIndex };
    }
  }
  return rows;
}

// Первая таблица с рамкой (border=3) — это сетка расписания
function findGrid(html) {
  const m = /<table\b[^>]*\bborder\s*=\s*"?3"?[^>]*>/i.exec(html);
  if (!m) return null;
  return html.slice(m.index);
}

function cellEntries(cellHtml) {
  const out = [];
  for (const r of tableRows(cellHtml)) {
    const parts = r.map(c => textOf(c.html)).filter(Boolean);
    if (!parts.length) continue;
    const [subject, teacher, room, ...rest] = parts;
    out.push({ subject: subject || '', teacher: teacher || '', room: room || '', extra: rest.join(' ') });
  }
  return out;
}

const DAY_NAMES = ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag'];

function parseUntisClass(html) {
  const grid = findGrid(html);
  if (!grid) throw new Error('Не найдена таблица расписания');
  const rows = tableRows(grid);

  // Раскладываем ячейки по сетке с учётом rowspan/colspan
  const occupied = [];   // occupied[r][c] = true
  const cells = [];      // { r, c, rs, cs, html }
  rows.forEach((row, r) => {
    occupied[r] = occupied[r] || [];
    let c = 0;
    for (const cell of row) {
      while (occupied[r][c]) c++;
      const rs = Math.max(1, +(attr(cell.attrs, 'rowspan') || 1));
      const cs = Math.max(1, +(attr(cell.attrs, 'colspan') || 1));
      for (let i = 0; i < rs; i++) {
        occupied[r + i] = occupied[r + i] || [];
        for (let j = 0; j < cs; j++) occupied[r + i][c + j] = true;
      }
      cells.push({ r, c, rs, cs, html: cell.html });
      c += cs;
    }
  });

  // Заголовок: колонки дней по названиям в первой строке
  const days = [];       // { day, c0, c1 }
  for (const cell of cells.filter(x => x.r === 0)) {
    const name = textOf(cell.html).toLowerCase();
    const idx = DAY_NAMES.indexOf(name);
    if (idx >= 0) days.push({ day: idx + 1, c0: cell.c, c1: cell.c + cell.cs });
  }
  if (!days.length) throw new Error('Не найдены дни недели');
  const firstDayCol = Math.min(...days.map(d => d.c0));

  // Номер урока для каждой строки сетки: ячейки слева с числом
  const periodOfRow = [];
  for (const cell of cells) {
    if (cell.r === 0 || cell.c !== 0) continue;
    const t = textOf(cell.html);
    if (/^\d{1,2}$/.test(t)) for (let i = 0; i < cell.rs; i++) periodOfRow[cell.r + i] = +t;
  }

  const lessons = [];
  for (const cell of cells) {
    if (cell.r === 0 || cell.c < firstDayCol) continue;
    const d = days.find(x => cell.c >= x.c0 && cell.c < x.c1);
    if (!d) continue;
    const entries = cellEntries(cell.html);
    if (!entries.length) continue;
    const periods = [];
    for (let i = 0; i < cell.rs; i++) {
      const p = periodOfRow[cell.r + i];
      if (p && !periods.includes(p)) periods.push(p);
    }
    if (!periods.length) continue;
    lessons.push({
      day: d.day, periods, entries,
      // Клетка занимает часть дня — параллельная группа (половина класса и т. п.)
      part: cell.cs < d.c1 - d.c0 ? `${cell.c - d.c0}/${d.c1 - d.c0}` : null,
    });
  }
  lessons.sort((a, b) => a.day - b.day || a.periods[0] - b.periods[0]);
  return lessons;
}

// Список недель из navbar.htm: [{ week: '46', monday: '2026-11-09' }]
function parseUntisWeeks(navHtml) {
  const sel = /<select[^>]*name\s*=\s*"?week"?[^>]*>([\s\S]*?)<\/select>/i.exec(navHtml);
  if (!sel) return [];
  const out = [];
  const re = /<option[^>]*value\s*=\s*"?(\d+)"?[^>]*>\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/gi;
  let m;
  while ((m = re.exec(sel[1]))) {
    out.push({ week: m[1], monday: `${m[4]}-${String(m[3]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` });
  }
  return out;
}

// Номер класса в списке navbar.htm (для имени файла c00060.htm)
function untisClassIndex(navHtml, className) {
  const m = /var\s+classes\s*=\s*\[([^\]]*)\]/.exec(navHtml);
  if (!m) return -1;
  const list = m[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  return list.indexOf(className) + 1;
}

// «Stand: 06.11.2026 12:16» — когда школа последний раз обновляла расписание
function untisStand(navHtml) {
  const m = /Stand:\s*([\d.]+\s+[\d:]+)/.exec(navHtml);
  return m ? m[1] : null;
}

globalThis.Untis = { parseUntisClass, parseUntisWeeks, untisClassIndex, untisStand, textOf };
