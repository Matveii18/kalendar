// @ts-nocheck
// Файл собран из untis.js и main.ts скриптом supabase/build-school.sh. Править исходники, не этот файл.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

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

// Расписание колледжа (OSP Köln, экспорт Untis): разбор, сохранение и уведомление об изменениях.
// Сайт колледжа не пускает серверы Supabase, поэтому заходит на него GitHub Actions
// (.github/workflows/school.yml + scripts/school_fetch.py) и присылает сюда скачанные страницы.
//
//   GET  ?due   — пора ли проверять по графику из ТЗ (по времени последней проверки)
//   POST        — { nav, pages: [{ week, html }] }: разобрать, сохранить, сообщить об изменениях
// Оба запроса требуют заголовок x-school-token, равный секрету SCHOOL_PUSH_TOKEN.
// Уроки текущей и следующей недели записываются в items как коллекция schoolWeeks,
// поэтому приложение получает их обычной синхронизацией.


declare const Untis: {
  parseUntisClass(html: string): Lesson[];
  parseUntisWeeks(html: string): { week: string; monday: string }[];
  untisStand(html: string): string | null;
};

type Entry = { subject: string; teacher: string; room: string; extra?: string };
type Lesson = { day: number; periods: number[]; entries: Entry[]; part: string | null };

const APP_URL = 'https://matveii18.github.io/kalendar/';
const VAPID_PUBLIC = 'BGAS-MTzjvhDHpM9rt7jXBSVvsdqPkUheiZEAASNQMJu3yRose75B7OKh3owVGE0jAaNJJD9rEiSF5t4X3fD01Y';
const WD = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const SLACK_MIN = 2; // запуски GitHub по расписанию приходят с опозданием, даём запас

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails(APP_URL, VAPID_PUBLIC, Deno.env.get('VAPID_PRIVATE_KEY')!);

/* ---- Когда проверять (время по Германии) ---- */

const berlinFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
});

function berlin(t: number) {
  const p: Record<string, string> = {};
  for (const x of berlinFmt.formatToParts(new Date(t))) p[x.type] = x.value;
  return { weekend: p.weekday === 'Sat' || p.weekday === 'Sun', h: +p.hour % 24, ymd: `${p.year}-${p.month}-${p.day}` };
}

function berlinYmd(t: number) { return berlin(t).ymd; }

// График из ТЗ: будни 00–06 раз в час, 06–09 каждые 5 мин, 09–15 каждые 15, 15–24 каждые 30;
// выходные один раз в 19:00
function isDue(lastCheck: number) {
  const now = Date.now();
  const cur = berlin(now);
  if (cur.weekend) {
    if (cur.h < 19) return false;
    const last = berlin(lastCheck);
    return !(lastCheck && last.ymd === cur.ymd && last.h >= 19);
  }
  const every = cur.h < 6 ? 60 : cur.h < 9 ? 5 : cur.h < 15 ? 15 : 30;
  return now - lastCheck >= (every - SLACK_MIN) * 60000;
}

/* ---- Сохранение и сравнение ---- */

function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

const lessonKey = (l: Lesson) => `${l.periods.join(',')}:${l.entries.map(e => `${e.subject}/${e.teacher}/${e.room}`).join('|')}`;

function dayKey(lessons: Lesson[], day: number) {
  return lessons.filter(l => l.day === day).map(lessonKey).sort().join(';');
}

// Какие ещё не прошедшие дни изменились: ['Чт 12.11', ...]
function changedDays(oldL: Lesson[], newL: Lesson[], monday: string, today: string) {
  const out: string[] = [];
  for (let d = 1; d <= 6; d++) {
    const date = addDays(monday, d - 1);
    if (date < today) continue;
    if (dayKey(oldL, d) !== dayKey(newL, d)) out.push(`${WD[d]} ${+date.slice(8)}.${+date.slice(5, 7)}`);
  }
  return out;
}

async function ownerId() {
  const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error || !data.users.length) throw new Error('Нет пользователя приложения');
  return data.users[0].id;
}

async function lastCheck(userId: string) {
  const { data } = await sb.from('items').select('data').eq('user_id', userId).eq('coll', 'schoolWeeks');
  return Math.max(0, ...(data || []).map(r => r.data?.checkedAt || 0));
}

async function notify(userId: string, title: string, body: string) {
  const { data: subs } = await sb.from('push_subs').select('endpoint,sub').eq('user_id', userId);
  for (const s of subs || []) {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title, body, tag: 'school', url: APP_URL }), { TTL: 6 * 3600 });
    } catch (err) {
      // deno-lint-ignore no-explicit-any
      const code = (err as any)?.statusCode;
      if (code === 404 || code === 410) await sb.from('push_subs').delete().eq('endpoint', s.endpoint);
    }
  }
}

async function save(userId: string, nav: string, pages: { week: string; html: string }[]) {
  const weeks = Untis.parseUntisWeeks(nav);
  const stand = Untis.untisStand(nav);
  const today = berlinYmd(Date.now());
  const changes: string[] = [];
  const result = [];

  for (const p of pages) {
    const w = weeks.find(x => x.week === String(p.week));
    if (!w) continue;
    const lessons = Untis.parseUntisClass(p.html);
    const id = `schoolweek-${w.monday}`;
    const { data: prev } = await sb.from('items').select('data').eq('user_id', userId).eq('id', id).maybeSingle();
    const oldLessons: Lesson[] | null = prev?.data?.lessons ?? null;
    const same = !!oldLessons && JSON.stringify(oldLessons.map(lessonKey)) === JSON.stringify(lessons.map(lessonKey));
    if (oldLessons && !same) changes.push(...changedDays(oldLessons, lessons, w.monday, today));

    const now = Date.now();
    const updatedAt = same ? (prev!.data.updatedAt ?? now) : now;
    const data = { id, monday: w.monday, week: w.week, lessons, stand, checkedAt: now, updatedAt };
    const { error } = await sb.from('items').upsert(
      { user_id: userId, id, coll: 'schoolWeeks', data, deleted: false, updated_at: updatedAt },
      { onConflict: 'user_id,id' });
    if (error) throw error;
    result.push({ monday: w.monday, lessons: lessons.length, changed: !!oldLessons && !same });
  }

  if (changes.length) await notify(userId, 'Расписание изменилось', `Посмотри уроки: ${changes.join(', ')}`);
  return { weeks: result, stand, changes };
}

Deno.serve(async req => {
  const token = Deno.env.get('SCHOOL_PUSH_TOKEN');
  if (!token || req.headers.get('x-school-token') !== token) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  try {
    const userId = await ownerId();
    if (req.method === 'GET') {
      return Response.json({ ok: true, due: isDue(await lastCheck(userId)) });
    }
    const body = await req.json();
    if (!body?.nav || !Array.isArray(body.pages)) return Response.json({ ok: false, error: 'bad request' }, { status: 400 });
    return Response.json({ ok: true, ...(await save(userId, body.nav, body.pages)) });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
});
