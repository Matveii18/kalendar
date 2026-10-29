// Рассылка напоминаний. Вызывается каждую минуту из pg_cron (см. supabase/push.sql).
// Повторный вызов безопасен: каждое напоминание записывается в push_log и уходит один раз.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const VAPID_PUBLIC = 'BGAS-MTzjvhDHpM9rt7jXBSVvsdqPkUheiZEAASNQMJu3yRose75B7OKh3owVGE0jAaNJJD9rEiSF5t4X3fD01Y';
const APP_URL = 'https://matveii18.github.io/kalendar/';
const HW_REMINDER_AT = '19:00'; // вечером накануне сдачи ДЗ, по Германии
const LEAD_MIN = 15;            // за сколько минут до занятия

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails(APP_URL, VAPID_PUBLIC, Deno.env.get('VAPID_PRIVATE_KEY')!);

/* ---- Часовые пояса (как в docs/tz.js) ---- */

const TZ: Record<string, string> = { DE: 'Europe/Berlin', UA: 'Europe/Kyiv' };
const fmt: Record<string, Intl.DateTimeFormat> = {};

function partsIn(tz: string, date: Date) {
  fmt[tz] ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const x of fmt[tz].formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
function offsetMin(tz: string, date: Date) {
  const p = partsIn(tz, date);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}
function zonedToInstant(ymd: string, hm: string, tz: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMin(tz, new Date(guess));
  let t = guess - off1 * 60000;
  const off2 = offsetMin(tz, new Date(t));
  if (off2 !== off1) t = guess - off2 * 60000;
  return t;
}
const pad = (n: number) => String(n).padStart(2, '0');
function instantIn(tz: string, t: number) {
  const p = partsIn(tz, new Date(t));
  return { ymd: `${p.y}-${pad(p.m)}-${pad(p.d)}`, hm: `${pad(p.h)}:${pad(p.mi)}` };
}
function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}
function diffDays(a: string, b: string) {
  const u = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((u(b) - u(a)) / 86400000);
}

/* ---- Какие напоминания пора отправить ---- */

// deno-lint-ignore no-explicit-any
type Entry = any;
type Msg = { key: string; title: string; body: string; tag: string };

function occurrencesNear(e: Entry, ymd: string): string[] {
  const out: string[] = [];
  for (const d of [addDays(ymd, -1), ymd, addDays(ymd, 1)]) {
    const k = diffDays(e.date, d);
    if (k < 0) continue;
    if (e.type === 'tutor' && e.repeat === 'weekly') { if (k % 7) continue; } else if (k) continue;
    if (e.until && d > e.until) continue;
    if ((e.skip || []).includes(d)) continue;
    out.push(d);
  }
  return out;
}

function dueMessages(entries: Entry[], names: Record<string, Record<string, string>>, now: number): { msgs: Msg[]; hw: Entry[] } {
  const msgs: Msg[] = [];
  const today = instantIn(TZ.DE, now).ymd;

  for (const e of entries) {
    const timed = e.type === 'tutor' || (e.type === 'other' && e.time);
    if (!timed || !e.date || !e.time) continue;
    const tzKey = e.tz === 'UA' ? 'UA' : 'DE';
    for (const occ of occurrencesNear(e, today)) {
      const start = zonedToInstant(occ, e.time, TZ[tzKey]);
      if (now < start - LEAD_MIN * 60000 || now >= start) continue;
      const de = instantIn(TZ.DE, start).hm, ua = instantIn(TZ.UA, start).hm;
      const who = e.type === 'tutor' ? (names.tutors[e.tutorId] || 'Занятие') : (e.title || 'Событие');
      const mins = Math.max(1, Math.round((start - now) / 60000));
      msgs.push({
        key: `soon:${e.id}:${occ}`,
        tag: `soon:${e.id}`,
        title: `Через ${mins} мин: ${who}`,
        body: `${de} по Германии · ${ua} по Украине${e.type === 'other' && e.place ? ` · ${e.place}` : ''}`,
      });
    }
  }

  const nowDe = instantIn(TZ.DE, now);
  const hw = nowDe.hm >= HW_REMINDER_AT
    ? entries.filter(e => e.type === 'hw' && !e.done && e.date === addDays(nowDe.ymd, 1))
    : [];
  return { msgs, hw };
}

/* ---- Отправка ---- */

// Возвращает только те ключи, которые ещё не отправлялись (и сразу их помечает)
async function claim(userId: string, keys: string[]) {
  if (!keys.length) return new Set<string>();
  const { data, error } = await sb.from('push_log')
    .upsert(keys.map(key => ({ user_id: userId, key })), { onConflict: 'user_id,key', ignoreDuplicates: true })
    .select('key');
  if (error) throw error;
  return new Set((data || []).map(r => r.key as string));
}

// deno-lint-ignore no-explicit-any
async function sendTo(subs: any[], payload: object) {
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (err) {
      // deno-lint-ignore no-explicit-any
      const code = (err as any)?.statusCode;
      if (code === 404 || code === 410) await sb.from('push_subs').delete().eq('endpoint', s.endpoint);
      else console.error('push failed', code, String(err));
    }
  }
  return sent;
}

Deno.serve(async () => {
  const now = Date.now();
  const { data: subs, error } = await sb.from('push_subs').select('user_id,endpoint,sub');
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let sent = 0;
  const byUser = new Map<string, typeof subs>();
  for (const s of subs || []) byUser.set(s.user_id, [...(byUser.get(s.user_id) || []), s]);

  for (const [userId, userSubs] of byUser) {
    const { data: rows, error: e2 } = await sb.from('items').select('id,coll,data').eq('user_id', userId).eq('deleted', false);
    if (e2) { console.error(e2); continue; }
    const entries = rows.filter(r => r.coll === 'entries').map(r => r.data);
    const names: Record<string, Record<string, string>> = {};
    for (const c of ['tutors', 'subjects']) names[c] = Object.fromEntries(rows.filter(r => r.coll === c).map(r => [r.id, r.data?.name]));

    const { msgs, hw } = dueMessages(entries, names, now);

    const fresh = await claim(userId, msgs.map(m => m.key));
    for (const m of msgs) if (fresh.has(m.key)) sent += await sendTo(userSubs, { title: m.title, body: m.body, tag: m.tag, url: APP_URL });

    const hwFresh = await claim(userId, hw.map(e => `hw:${e.id}:${e.date}`));
    const hwNew = hw.filter(e => hwFresh.has(`hw:${e.id}:${e.date}`));
    if (hwNew.length) {
      const list = hwNew.map(e => names.subjects[e.subjectId] || e.text || 'ДЗ');
      sent += await sendTo(userSubs, {
        title: hwNew.length === 1 ? `Завтра сдать ДЗ: ${list[0]}` : `Завтра сдать ДЗ: ${hwNew.length}`,
        body: hwNew.length === 1 ? (hwNew[0].text || '') : list.join(', '),
        tag: `hw:${hwNew[0].date}`, url: APP_URL,
      });
    }
  }

  return Response.json({ ok: true, sent });
});
