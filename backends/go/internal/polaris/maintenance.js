(() => {
  const labels = {"en":["Maintenance In Progress","This site is undergoing maintenance. Please check back soon.","Sign in","Scheduled maintenance","Estimated completion:"],"zh-CN":["正在维护中","本站正在维护，请稍后再来。","登录","计划维护","预计恢复时间："],"zh-TW":["正在維護中","本站正在維護，請稍後再來。","登入","計畫維護","預計恢復時間："],"zh-HK":["維護進行中","本站正在維護，請稍後再來。","登入","計劃維護","預計恢復時間："],"ja":["メンテナンス実施中","現在メンテナンス中です。しばらくしてからお戻りください。","ログイン","メンテナンス予定","終了予定："],"ko":["유지보수 진행 중","현재 사이트를 점검하고 있습니다. 잠시 후 다시 방문해 주세요.","로그인","예정된 점검","예상 완료 시간:"],"fr":["Maintenance en cours","Le site est en maintenance. Revenez dans quelques instants.","Se connecter","Maintenance planifiée","Fin estimée :"],"pt":["Manutenção em Andamento","O site está em manutenção. Volte em breve.","Entrar","Manutenção programada","Previsão de conclusão:"],"ru":["Идёт обслуживание","На сайте проводятся работы. Пожалуйста, вернитесь позже.","Войти","Плановое обслуживание","Ориентировочное завершение:"]};
  const script = document.currentScript;
  let selected = '';
  try { selected = localStorage.getItem('uptime-polaris-locale') || ''; } catch (_) {}
  const configured = selected || script?.dataset.locale || document.body.dataset.locale || 'auto';
  const requested = configured === 'auto' ? navigator.language : configured;
  const locale = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(requested) ? requested : 'en-US';
  const key = /^zh-HK/i.test(locale) ? 'zh-HK' : /^zh-(TW|MO)/i.test(locale) ? 'zh-TW' : /^zh/i.test(locale) ? 'zh-CN' : locale.split('-')[0].toLowerCase();
  const words = labels[key] || labels.en;
  const page = document.body.hasAttribute('data-polaris-maintenance-page');
  let host;
  let timer;
  const render = (state) => {
    if (page) {
      if (!state.active) { location.reload(); return; }
      document.getElementById('maintenance-title').textContent = state.title || words[0];
      document.getElementById('maintenance-description').textContent = state.description || words[1];
      document.getElementById('maintenance-login').textContent = words[2];
      const end = document.getElementById('maintenance-end');
      end.hidden = !state.endsAt;
      document.getElementById('maintenance-end-label').textContent = words[4];
      const time = document.getElementById('maintenance-end-time');
      time.dateTime = state.endsAt || '';
      time.textContent = state.endsAt ? new Date(state.endsAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      document.title = state.title || words[0];
      document.documentElement.lang = locale;
      return;
    }
    if (state.active) { location.replace('/'); return; }
    const next = state.scheduled[0];
    if (!next) { host?.remove(); host = undefined; return; }
    if (!host) {
      host = document.createElement('div');
      host.style.cssText = 'display:block;position:sticky;top:0;z-index:2147483647';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{all:initial}div{box-sizing:border-box;background:#fff4d5;color:#624609;padding:12px 20px;text-align:center;font:14px/1.5 system-ui,sans-serif}strong{font-weight:700}span{margin-inline-start:8px}small{display:block;font-size:12px}</style><div role="status"><strong></strong><span></span><small></small></div>';
      document.body.prepend(host);
    }
    const root = host.shadowRoot;
    root.querySelector('strong').textContent = next.title || words[3];
    root.querySelector('span').textContent = new Date(next.startsAt).toLocaleString(locale);
    root.querySelector('small').textContent = next.description || '';
  };
  const poll = async () => {
    clearTimeout(timer);
    let delay = 15000;
    try {
      const response = await fetch('/api/public/maintenance', { cache: 'no-store' });
      if (!response.ok) throw new Error('maintenance unavailable');
      const state = await response.json();
      render(state);
      const boundary = state.active ? state.endsAt : state.scheduled[0]?.startsAt;
      if (boundary) delay = Math.max(500, Math.min(delay, Date.parse(boundary) - Date.parse(state.serverNow) + 250));
    } catch (_) {}
    timer = setTimeout(poll, delay);
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
})();