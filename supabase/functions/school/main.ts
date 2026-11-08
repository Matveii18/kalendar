// Расписание колледжа (OSP Köln, экспорт Untis): разбор, сохранение и уведомление об изменениях.
// Сайт колледжа не пускает серверы Supabase, поэтому заходит на него GitHub Actions
// (.github/workflows/school.yml + scripts/school_fetch.py) и присылает сюда скачанные страницы.
//
//   GET  ?due   — пора ли проверять по графику из ТЗ (по времени последней проверки)
//   POST        — { nav, pages: [{ week, html }] }: разобрать, сохранить, сообщить об изменениях
// Оба запроса требуют заголовок x-school-token, равный секрету SCHOOL_PUSH_TOKEN.
// Уроки текущей и следующей недели записываются в items как коллекция schoolWeeks,
// поэтому приложение получает их обычной синхронизацией.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'jsr:@supabase/supabase-js@2';

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
