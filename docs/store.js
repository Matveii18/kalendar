// Хранилище. Данные лежат в браузере (localStorage), а Sync отправляет изменения в облако
// и приносит изменения с других устройств. Остальной код ходит только через Store.

const Store = (() => {
  const KEY = 'kalendar-v1';
  const PENDING_KEY = 'kalendar-pending';
  const COLLECTIONS = ['entries', 'subjects', 'teachers', 'tutors', 'subs', 'school'];

  let data = load();
  // Изменения, ещё не отправленные в облако: id -> { coll, data | null, updatedAt }
  let pending = loadPending();
  const listeners = [];

  function empty() {
    const d = {};
    for (const c of COLLECTIONS) d[c] = [];
    return d;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign(empty(), JSON.parse(raw));
    } catch (e) { /* пустое или недоступное хранилище */ }
    return empty();
  }

  function loadPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || {}; } catch (e) { return {}; }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch (e) { console.warn('Не удалось сохранить', e); }
  }

  function changed(local) {
    save();
    for (const fn of listeners) fn(local);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function findColl(id) {
    return COLLECTIONS.find(c => data[c].some(x => x.id === id));
  }

  return {
    COLLECTIONS,
    all(coll) { return data[coll]; },
    get(coll, id) { return data[coll].find(x => x.id === id); },
    upsert(coll, obj) {
      obj.updatedAt = Date.now();
      if (!obj.id) { obj.id = uid(); data[coll].push(obj); }
      else {
        const i = data[coll].findIndex(x => x.id === obj.id);
        if (i >= 0) data[coll][i] = obj; else data[coll].push(obj);
      }
      pending[obj.id] = { coll, data: obj, updatedAt: obj.updatedAt };
      changed(true);
      return obj;
    },
    remove(coll, id) {
      data[coll] = data[coll].filter(x => x.id !== id);
      pending[id] = { coll, data: null, updatedAt: Date.now() };
      changed(true);
    },
    onChange(fn) { listeners.push(fn); },

    // Для синхронизации
    pendingList() { return Object.entries(pending).map(([id, p]) => ({ id, ...p })); },
    clearPending(sent) {
      for (const p of sent) if (pending[p.id] && pending[p.id].updatedAt === p.updatedAt) delete pending[p.id];
      save();
    },
    markAllPending() {
      for (const c of COLLECTIONS) for (const x of data[c]) pending[x.id] = { coll: c, data: x, updatedAt: x.updatedAt || Date.now() };
      save();
    },
    // Применить записи из облака; локальные неотправленные правки новее — побеждают они
    applyRemote(rows) {
      let any = false;
      for (const r of rows) {
        const p = pending[r.id];
        if (p && p.updatedAt >= r.updated_at) continue;
        const coll = COLLECTIONS.includes(r.coll) ? r.coll : findColl(r.id);
        if (!coll) continue;
        const i = data[coll].findIndex(x => x.id === r.id);
        if (r.deleted) {
          if (i >= 0) { data[coll].splice(i, 1); any = true; }
        } else {
          const cur = i >= 0 ? data[coll][i] : null;
          if (cur && (cur.updatedAt || 0) > r.updated_at) continue;
          if (i >= 0) data[coll][i] = r.data; else data[coll].push(r.data);
          any = true;
        }
        if (p) delete pending[r.id];
      }
      if (any) changed(false); else save();
      return any;
    },

    exportJson() { return JSON.stringify(data, null, 2); },
    importJson(text) {
      const parsed = JSON.parse(text);
      data = Object.assign(empty(), parsed);
      this.markAllPending();
      changed(true);
    },
    name(coll, id) { const x = id && this.get(coll, id); return x ? x.name : ''; },
  };
})();
