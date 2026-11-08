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

  let initInfo = '';

  // Библиотека входа: сначала своя копия на сайте, если не загрузилась, пробуем внешние
  function loadScript(src) {
    return new Promise(res => {
      const el = document.createElement('script');
      el.src = src; el.onload = () => res(true); el.onerror = () => res(false);
      document.head.appendChild(el);
    });
  }

  async function ensureLib() {
    if (window.supabase) return true;
    for (const src of ['vendor/supabase.js?v=2', 'https://unpkg.com/@supabase/supabase-js@2.49.4/dist/umd/supabase.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js']) {
      if (await loadScript(src) && window.supabase) return true;
    }
    return false;
  }

  async function init() {
    try {
      if (!CONFIG.supabaseUrl) { initInfo = 'нет адреса облака в config.js'; }
      else if (!(await ensureLib())) { initInfo = 'библиотека входа не загрузилась ни с сайта, ни с внешних серверов'; }
      else {
        sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kalendar-auth' },
        });
      }
    } catch (e) { sb = null; initInfo = `ошибка запуска: ${e && e.message}`; }
    if (!sb) { setStatus('off', `Облако недоступно (${initInfo})`); return; }
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

  function b64uToBytes(s) {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  }

  return {
    init,
    get user() { return user; },
    get status() { return status; },
    onStatus(fn) { listeners.push(fn); },
    async signIn(email, password) {
      if (!sb) throw new Error(`Облако недоступно (${initInfo || 'ещё запускается, подожди и повтори'})`);
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signOut() {
      if (sb) await sb.auth.signOut();
      user = null;
      setStatus('off', 'Вход не выполнен');
    },
    now() { schedule(0); },

    // Уведомления: подписать это устройство на напоминания с сервера
    async pushState() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      return sub ? 'on' : 'off';
    },
    async enablePush() {
      if (!user) throw new Error('Сначала войди');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Уведомления не разрешены');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(CONFIG.vapidPublicKey) });
      const json = sub.toJSON();
      const { error } = await sb.from('push_subs').upsert(
        { user_id: user.id, endpoint: json.endpoint, sub: json, device: navigator.userAgent.slice(0, 200) },
        { onConflict: 'endpoint' });
      if (error) throw error;
    },
    async disablePush() {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (!sub) return;
      if (sb && user) await sb.from('push_subs').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    },
  };
})();
