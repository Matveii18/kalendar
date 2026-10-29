// Даты и часовые пояса. Даты храним строками 'YYYY-MM-DD', время 'HH:MM'.
// Переход на летнее/зимнее время считает сам браузер через Intl.

const TZ = { DE: 'Europe/Berlin', UA: pickZone(['Europe/Kyiv', 'Europe/Kiev']) };
const TZ_LABEL = { DE: 'Германия', UA: 'Украина' };
const TZ_SHORT = { DE: 'DE', UA: 'UA' };

function pickZone(names) {
  for (const n of names) {
    try { new Intl.DateTimeFormat('en', { timeZone: n }); return n; } catch (e) { /* нет такого */ }
  }
  return 'Europe/Kiev';
}

const fmtCache = {};
function partsIn(tz, date) {
  if (!fmtCache[tz]) {
    fmtCache[tz] = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }
  const p = {};
  for (const x of fmtCache[tz].formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}

function offsetMin(tz, date) {
  const p = partsIn(tz, date);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

// Время на стене в поясе tz -> момент времени
function zonedToInstant(ymd, hm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMin(tz, new Date(guess));
  let t = guess - off1 * 60000;
  const off2 = offsetMin(tz, new Date(t));
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

// Момент времени -> дата и время на стене в поясе tz
function instantIn(tz, date) {
  const p = partsIn(tz, date);
  return { ymd: `${p.y}-${pad(p.m)}-${pad(p.d)}`, hm: `${pad(p.h)}:${pad(p.mi)}` };
}

// Перевод времени из одного пояса в другой (DE <-> UA)
function convertTime(ymd, hm, fromKey, toKey) {
  return instantIn(TZ[toKey], zonedToInstant(ymd, hm, TZ[fromKey]));
}

function pad(n) { return String(n).padStart(2, '0'); }

function ymdToUtc(ymd) { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function utcToYmd(t) { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function addDays(ymd, n) { return utcToYmd(ymdToUtc(ymd) + n * 86400000); }
function diffDays(a, b) { return Math.round((ymdToUtc(b) - ymdToUtc(a)) / 86400000); }
// 1 = понедельник ... 7 = воскресенье
function weekday(ymd) { const w = new Date(ymdToUtc(ymd)).getUTCDay(); return w === 0 ? 7 : w; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function todayYmd() { return instantIn(TZ.DE, new Date()).ymd; }
function nowHm() { return instantIn(TZ.DE, new Date()).hm; }
function hmToMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
function minToHm(min) { min = ((min % 1440) + 1440) % 1440; return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const WD = ['', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
const WD_LONG = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];

function fmtShort(ymd) { const [, m, d] = ymd.split('-').map(Number); return `${d} ${MONTHS_SHORT[m - 1]}`; }
function fmtLong(ymd) { const [, m, d] = ymd.split('-').map(Number); return `${d} ${MONTHS_GEN[m - 1]}, ${WD_LONG[weekday(ymd)]}`; }
