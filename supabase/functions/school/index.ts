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

// Проверка расписания на сайте колледжа (OSP Köln, экспорт Untis).
// pg_cron вызывает функцию каждые 5 минут, а она сама решает по немецкому времени, пора ли проверять
// (график из ТЗ). Уроки текущей и следующей недели записываются в таблицу items как записи
// коллекции schoolWeeks, поэтому приложение получает их обычной синхронизацией.
// Логин и пароль берутся только из секретов Supabase: COLLEGE_USER, COLLEGE_PASSWORD, COLLEGE_SCHOOL.


declare const Untis: {
  parseUntisClass(html: string): Lesson[];
  parseUntisWeeks(html: string): { week: string; monday: string }[];
  untisClassIndex(html: string, name: string): number;
  untisStand(html: string): string | null;
};

type Entry = { subject: string; teacher: string; room: string; extra?: string };
type Lesson = { day: number; periods: number[]; entries: Entry[]; part: string | null };

const BASE = 'https://osp2.stadt-koeln.de';
const CLASS_NAME = Deno.env.get('COLLEGE_CLASS') || '2659';
const APP_URL = 'https://matveii18.github.io/kalendar/';
const VAPID_PUBLIC = 'BGAS-MTzjvhDHpM9rt7jXBSVvsdqPkUheiZEAASNQMJu3yRose75B7OKh3owVGE0jAaNJJD9rEiSF5t4X3fD01Y';
const WD = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails(APP_URL, VAPID_PUBLIC, Deno.env.get('VAPID_PRIVATE_KEY')!);

/* ---- Когда проверять (время по Германии) ---- */

function berlinNow() {
  const p: Record<string, string> = {};
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  return { weekend: p.weekday === 'Sat' || p.weekday === 'Sun', h: +p.hour % 24, m: +p.minute };
}

// Вызов идёт каждые 5 минут: в каждом окне графика срабатывает ровно один из них
function isDue() {
  const { weekend, h, m } = berlinNow();
  if (weekend) return h === 19 && m < 5;
  if (h < 6) return m < 5;            // раз в час
  if (h < 9) return true;             // каждые 5 минут
  if (h < 15) return m % 15 < 5;      // каждые 15 минут
  return m % 30 < 5;                  // каждые 30 минут
}

/* ---- Сайт колледжа ---- */

class Session {
  cookies = new Map<string, string>();

  private store(res: Response) {
    // Deno отдаёт все Set-Cookie через getSetCookie
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}, hops = 0): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    headers.set('User-Agent', 'Mozilla/5.0 (Kalendar schedule check)');
    const res = await fetch(new URL(path, BASE), { ...init, headers, redirect: 'manual' });
    this.store(res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc && hops < 5) {
      await res.body?.cancel();
      return this.fetch(new URL(loc, new URL(path, BASE)).href, {}, hops + 1);
    }
    return res;
  }

  async text(path: string) {
    const res = await this.fetch(path);
    const buf = await res.arrayBuffer();
    if (res.url.includes('login.php') || !res.ok) throw new Error(`Нет доступа к ${path} (${res.status})`);
    return new TextDecoder('windows-1252').decode(buf);
  }
}

async function loadSchedule() {
  const user = Deno.env.get('COLLEGE_USER'), pass = Deno.env.get('COLLEGE_PASSWORD');
  const school = Deno.env.get('COLLEGE_SCHOOL') || '175031';
  if (!user || !pass) throw new Error('Не заданы секреты COLLEGE_USER и COLLEGE_PASSWORD');

  const s = new Session();
  await s.fetch('/login.php');
  const body = new URLSearchParams({ schulnummer: school, benutzername: user, passwort: pass });
  await s.fetch('/process.php', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  await s.text('/schueler.php'); // кнопка Schülerplan

  const dir = `/untis/${school}/schueler`;
  const nav = await s.text(`${dir}/frames/navbar.htm`);
  const idx = Untis.untisClassIndex(nav, CLASS_NAME);
  if (idx < 1) throw new Error(`Класс ${CLASS_NAME} не найден на сайте`);
  const file = `c${String(idx).padStart(5, '0')}.htm`;

  const weeks = [];
  for (const w of Untis.parseUntisWeeks(nav)) {
    const html = await s.text(`${dir}/${w.week}/c/${file}`);
    weeks.push({ ...w, lessons: Untis.parseUntisClass(html) });
  }
  return { weeks, stand: Untis.untisStand(nav) };
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

// Какие будущие дни изменились: ['Чт 12.11', ...]
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

async function run() {
  const userId = await ownerId();
  const { weeks, stand } = await loadSchedule();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());

  const changes: string[] = [];
  for (const w of weeks) {
    const id = `schoolweek-${w.monday}`;
    const { data: prev } = await sb.from('items').select('data').eq('user_id', userId).eq('id', id).maybeSingle();
    const oldLessons: Lesson[] | null = prev?.data?.lessons ?? null;
    const same = oldLessons && JSON.stringify(oldLessons.map(lessonKey)) === JSON.stringify(w.lessons.map(lessonKey));
    if (oldLessons && !same) changes.push(...changedDays(oldLessons, w.lessons, w.monday, today));

    const data = { id, monday: w.monday, week: w.week, lessons: w.lessons, stand, checkedAt: Date.now(), updatedAt: Date.now() };
    // Если ничего не поменялось, обновляем только время проверки — без лишней синхронизации
    if (same) data.updatedAt = prev!.data.updatedAt ?? Date.now();
    const { error } = await sb.from('items').upsert(
      { user_id: userId, id, coll: 'schoolWeeks', data, deleted: false, updated_at: data.updatedAt },
      { onConflict: 'user_id,id' });
    if (error) throw error;
  }

  if (changes.length) {
    await notify(userId, 'Расписание изменилось', `Посмотри уроки: ${changes.join(', ')}`);
  }
  return { weeks: weeks.map(w => ({ monday: w.monday, lessons: w.lessons.length })), stand, changes };
}

Deno.serve(async req => {
  const force = new URL(req.url).searchParams.has('force');
  if (!force && !isDue()) return Response.json({ ok: true, skipped: true });
  try {
    return Response.json({ ok: true, ...(await run()) });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
});
