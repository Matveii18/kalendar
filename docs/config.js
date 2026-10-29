// Публичные настройки облака. Publishable key не секретный: доступ к данным защищён входом и правилами RLS.
const CONFIG = {
  supabaseUrl: 'https://iqxlgaefulwklbsmecym.supabase.co',
  supabaseKey: 'sb_publishable__Gov-c8ez0rHuZlaqdh9kw_oxH5uuAi',
  // Публичная половина ключа уведомлений (закрытая хранится только в секретах Supabase)
  vapidPublicKey: 'BGAS-MTzjvhDHpM9rt7jXBSVvsdqPkUheiZEAASNQMJu3yRose75B7OKh3owVGE0jAaNJJD9rEiSF5t4X3fD01Y',
};
