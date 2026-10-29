// Превращает записи из Store в конкретные события на конкретные дни:
// раскрывает повторы, переводит время в немецкое, добавляет уроки и подписки.

const TYPES = {
  hw:     { label: 'ДЗ',          color: '#f5a524' },
  tutor:  { label: 'Репетитор',   color: '#a78bfa' },
  task:   { label: 'Задача',      color: '#3ecf8e' },
  period: { label: 'Период',      color: '#22c3c3' },
  other:  { label: 'Другое',      color: '#5aa9ff' },
  sub:    { label: 'Подписка',    color: '#f472b6' },
  school: { label: 'Урок',        color: '#8b95a7' },
};

const PERIOD_KINDS = ['каникулы', 'отпуск', 'поездка', 'другое'];

// Расписание звонков колледжа (время немецкое)
const BELLS = {
  1: ['08:00', '08:45'], 2: ['08:45', '09:30'],
  3: ['09:50', '10:35'], 4: ['10:35', '11:20'],
  5: ['11:40', '12:25'], 6: ['12:25', '13:10'],
  7: ['13:30', '14:15'], 8: ['14:15', '15:00'],
  9: ['15:20', '16:05'], 10: ['16:05', '16:50'],
};

function teacherNames(ids) {
  return (ids || []).map(id => Store.name('teachers', id)).filter(Boolean).join(', ');
}

// Время записи, у которой есть пояс ввода: возвращает время по Германии и подпись во втором поясе
function dualTime(ymdInput, hm, tzKey) {
  const de = convertTime(ymdInput, hm, tzKey, 'DE');
  const ua = convertTime(ymdInput, hm, tzKey, 'UA');
  return { ymd: de.ymd, de: de.hm, ua: ua.hm, inputTz: tzKey };
}

function noSchoolOn(ymd) {
  return Store.all('entries').some(e => e.type === 'period' && e.noSchool && e.start <= ymd && ymd <= e.end);
}

function schoolLessons(ymd) {
  if (noSchoolOn(ymd)) return [];
  const wd = weekday(ymd);
  return Store.all('school')
    .filter(s => s.weekday === wd && BELLS[s.lesson])
    .sort((a, b) => a.lesson - b.lesson)
    .map(s => ({
      key: `school:${s.id}:${ymd}`, type: 'school', entry: s, ymd,
      start: BELLS[s.lesson][0], end: BELLS[s.lesson][1],
      title: `${s.lesson}. ${Store.name('subjects', s.subjectId) || 'Урок'}`,
      sub: [teacherNames(s.teacherIds), s.room].filter(Boolean).join(' · '),
    }));
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return hmToMin(aStart) < hmToMin(bEnd) && hmToMin(bStart) < hmToMin(aEnd);
}

// Уроки, с которыми пересекается интервал (время по Германии)
function schoolConflicts(ymd, start, end) {
  return schoolLessons(ymd).filter(l => overlaps(start, end, l.start, l.end));
}

// Даты повторов занятия (в поясе ввода), которые могут попасть на день ymd по Германии
function tutorDatesNear(e, ymd) {
  const out = [];
  for (const d of [addDays(ymd, -1), ymd, addDays(ymd, 1)]) {
    const k = diffDays(e.date, d);
    if (k < 0) continue;
    if (e.repeat === 'weekly') { if (k % 7 !== 0) continue; }
    else if (k !== 0) continue;
    if (e.until && d > e.until) continue;
    if ((e.skip || []).includes(d)) continue;
    out.push(d);
  }
  return out;
}

function tutorItem(e, occ) {
  const t = dualTime(occ, e.time, e.tz);
  const endDe = minToHm(hmToMin(t.de) + (+e.duration || 60));
  const name = Store.name('tutors', e.tutorId) || 'Занятие';
  const alt = e.tz === 'UA' ? `${e.time} по Украине` : `${t.ua} по Украине`;
  const item = {
    key: `tutor:${e.id}:${occ}`, type: 'tutor', entry: e, occ, ymd: t.ymd,
    start: t.de, end: endDe, title: name, sub: e.note || '', alt,
  };
  item.conflicts = schoolConflicts(t.ymd, item.start, item.end);
  return item;
}

function taskOnDay(e, ymd) {
  if (!e.date) return false;
  const k = diffDays(e.date, ymd);
  if (k < 0) return false;
  if (e.until && ymd > e.until) return false;
  if (e.repeat === 'daily') return true;
  if (e.repeat === 'everyN') return k % Math.max(1, +e.n || 1) === 0;
  return k === 0;
}

function itemsForDay(ymd) {
  const today = todayYmd();
  const items = [];

  for (const e of Store.all('entries')) {
    switch (e.type) {
      case 'hw':
        if (e.date === ymd) {
          items.push({
            key: `hw:${e.id}`, type: 'hw', entry: e, ymd, allDay: true,
            title: Store.name('subjects', e.subjectId) || 'ДЗ',
            sub: [e.text, teacherNames(e.teacherIds)].filter(Boolean).join(' · '),
            done: !!e.done, overdue: !e.done && e.date < today, checkable: true,
          });
        }
        break;

      case 'tutor':
        for (const occ of tutorDatesNear(e, ymd)) {
          const it = tutorItem(e, occ);
          if (it.ymd === ymd) items.push(it);
        }
        break;

      case 'task': {
        let show = false, done = false;
        if (!e.date) {
          // Бессрочная: висит на сегодняшнем дне, пока не отмечена; отмеченная остаётся на дне отметки
          if (!e.done) show = ymd === today;
          else { show = e.doneDate === ymd; done = true; }
        } else if (taskOnDay(e, ymd)) {
          show = true;
          done = e.repeat && e.repeat !== 'none' ? (e.doneDates || []).includes(ymd) : !!e.done;
        }
        if (show) {
          const rep = e.repeat === 'daily' ? 'каждый день' : e.repeat === 'everyN' ? `каждые ${e.n} дн.` : (!e.date ? 'без срока' : '');
          items.push({
            key: `task:${e.id}:${ymd}`, type: 'task', entry: e, ymd, occ: ymd, allDay: true,
            title: e.text, sub: rep, done, checkable: true,
            overdue: !done && !!e.date && (!e.repeat || e.repeat === 'none') && ymd < today,
          });
        }
        break;
      }

      case 'period':
        if (e.start <= ymd && ymd <= e.end) {
          items.push({
            key: `period:${e.id}`, type: 'period', entry: e, ymd, allDay: true, period: true,
            title: e.title || e.kind, sub: `${e.kind} · ${fmtShort(e.start)} – ${fmtShort(e.end)}`,
            isStart: ymd === e.start, isEnd: ymd === e.end,
          });
        }
        break;

      case 'other': {
        if (e.time) {
          for (const d of [addDays(ymd, -1), ymd, addDays(ymd, 1)]) {
            if (d !== e.date) continue;
            const t = dualTime(d, e.time, e.tz || 'DE');
            if (t.ymd !== ymd) continue;
            const end = e.endTime ? convertTime(d, e.endTime, e.tz || 'DE', 'DE').hm : null;
            items.push({
              key: `other:${e.id}`, type: 'other', entry: e, ymd, start: t.de, end,
              title: e.title || 'Событие', sub: otherSub(e),
              alt: (e.tz || 'DE') === 'UA' ? `${e.time} по Украине` : `${t.ua} по Украине`,
            });
          }
        } else if (e.date === ymd) {
          items.push({ key: `other:${e.id}`, type: 'other', entry: e, ymd, allDay: true, title: e.title || 'Событие', sub: otherSub(e) });
        }
        break;
      }
    }
  }

  // Подписки: каждый месяц в день списания (если в месяце меньше дней — в последний день)
  const [y, m, d] = ymd.split('-').map(Number);
  for (const s of Store.all('subs')) {
    const day = Math.min(+s.day || 1, daysInMonth(y, m));
    if (day === d) {
      items.push({ key: `sub:${s.id}:${ymd}`, type: 'sub', entry: s, ymd, allDay: true, title: s.name, sub: s.price ? `${s.price} · списание` : 'списание' });
    }
  }

  items.push(...schoolLessons(ymd));

  const order = { period: 0, hw: 1, task: 2, sub: 3, other: 4 };
  items.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay) return (order[a.type] ?? 9) - (order[b.type] ?? 9);
    return hmToMin(a.start) - hmToMin(b.start);
  });
  return items;
}

function otherSub(e) {
  const parts = [];
  if (e.place) parts.push(`📍 ${e.place}`);
  if (e.bring) parts.push(`взять: ${e.bring}`);
  if (e.todo) parts.push(`до: ${e.todo}`);
  return parts.join(' · ');
}

// Отметка «сделано» для ДЗ и задач
function toggleDone(item) {
  const e = item.entry;
  if (e.type === 'task' && e.date && e.repeat && e.repeat !== 'none') {
    const set = new Set(e.doneDates || []);
    set.has(item.occ) ? set.delete(item.occ) : set.add(item.occ);
    e.doneDates = [...set];
  } else {
    e.done = !e.done;
    if (e.type === 'task' && !e.date) e.doneDate = e.done ? todayYmd() : null;
  }
  Store.upsert('entries', e);
}

// Все просроченные несделанные ДЗ
function overdueHomework() {
  const today = todayYmd();
  return Store.all('entries').filter(e => e.type === 'hw' && !e.done && e.date < today)
    .sort((a, b) => a.date.localeCompare(b.date));
}
