// Синхронизация с Supabase: вход по почте и паролю, отправка своих правок, приём чужих.

const Sync = (() => {
  const LAST_KEY = 'kalendar-last-pull';
  const USER_KEY = 'kalendar-sync-user';
  let sb = null;
  let user = null;
  let busy = false;
  let again = false;
  let timer = null;
  let status = { state: 'off', text: 'Не подключено' };
  const listeners = [];

  function setStatus(state, text) {
    status = { state, text, at: Date.now() };
    for (const fn of listeners) fn(status);
  }

  async function init() {
    if (!window.supabase || !CONFIG.supabaseUrl) { setStatus('off', 'Облако недоступно (нет интернета?)'); return; }
    sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kalendar-auth' },
    });
    const { data } = await sb.auth.getSession();
    await onSession(data.session);
    sb.auth.onAuthStateChange((_ev, session) => {
      if ((session && session.user && session.user.id) !== (user && user.id)) onSession(session);
    });

    Store.onChange(local => { if (local) schedule(800); });
    setInterval(() => schedule(0), 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
    window.addEventListener('online', () => schedule(0));
  }

  async function onSession(session) {
    user = session ? session.user : null;
    if (!user) { setStatus('off', 'Вход не выполнен'); return; }
    // Первый вход на этом устройстве: отправить в облако всё, что уже было записано локально
    if (localStorage.getItem(USER_KEY) !== user.id) {
      localStorage.setItem(USER_KEY, user.id);
      localStorage.removeItem(LAST_KEY);
      Store.markAllPending();
    }
    subscribe();
    schedule(0);
  }

  function subscribe() {
    sb.channel('items-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `user_id=eq.${user.id}` }, () => schedule(300))
      .subscribe();
  }

  function schedule(ms) {
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  async function run() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      setStatus('busy', 'Синхронизация…');
      await push();
      await pull();
      setStatus('ok', 'Синхронизировано');
    } catch (e) {
      console.warn('sync', e);
      setStatus('error', navigator.onLine ? 'Ошибка синхронизации' : 'Нет интернета, изменения отправятся позже');
    } finally {
      busy = false;
      if (again) { again = false; schedule(500); }
    }
  }

  async function push() {
    const list = Store.pendingList();
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      const rows = chunk.map(p => ({
        user_id: user.id, id: p.id, coll: p.coll, data: p.data,
        deleted: !p.data, updated_at: p.updatedAt,
      }));
      const { error } = await sb.from('items').upsert(rows, { onConflict: 'user_id,id' });
      if (error) throw error;
      Store.clearPending(chunk);
    }
  }

  async function pull() {
    let since = localStorage.getItem(LAST_KEY) || '1970-01-01T00:00:00Z';
    for (;;) {
      const { data, error } = await sb.from('items')
        .select('id,coll,data,deleted,updated_at,server_at')
        .gt('server_at', since).order('server_at', { ascending: true }).limit(1000);
      if (error) throw error;
      if (!data.length) break;
      if (Store.applyRemote(data) && typeof render === 'function') render();
      since = data[data.length - 1].server_at;
      localStorage.setItem(LAST_KEY, since);
      if (data.length < 1000) break;
    }
  }

  return {
    init,
    get user() { return user; },
    get status() { return status; },
    onStatus(fn) { listeners.push(fn); },
    async signIn(email, password) {
      if (!sb) throw new Error('Облако недоступно');
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signOut() {
      if (sb) await sb.auth.signOut();
      user = null;
      setStatus('off', 'Вход не выполнен');
    },
    now() { schedule(0); },
  };
})();
