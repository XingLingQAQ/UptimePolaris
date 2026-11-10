(() => {
  const target = document.body.dataset.target;
  const $ = (id) => document.getElementById(id);
  const strings = {
    en: {
      service: 'SERVICE STATUS', machines: 'MACHINE STATUS', live: 'LIVE OVERVIEW', current: 'CURRENT STATUS',
      monitors: 'Monitors', servers: 'Machines', refresh: 'Refresh', loading: 'Loading status…',
      error: 'Status is unavailable', errorDetail: 'Could not load public data. Select Refresh to try again.',
      noMonitors: 'No monitors are available on this page.', noServers: 'No machines are available on this page.',
      allUp: 'All monitors operational', someDown: 'Some monitors are down', someWarn: 'Some monitors need attention',
      pending: 'Waiting for status', allOnline: 'All machines online', someOffline: 'Some machines are offline',
      someUnknown: 'Some statuses are unknown', online: 'Online', offline: 'Offline', operational: 'Operational',
      down: 'Down', warning: 'Warning', unknown: 'Unknown', noData: 'No data yet',
      updated: 'Updated', footer: 'Public status page', availability: 'Availability', cpu: 'CPU', items: 'items'
    },
    zh: {
      service: '服务状态', machines: '机器状态', live: '实时概览', current: '当前状态',
      monitors: '监控项目', servers: '机器', refresh: '刷新', loading: '正在加载状态…',
      error: '暂时无法获取状态', errorDetail: '公开数据加载失败，请点击刷新重试。',
      noMonitors: '此页面暂无公开的监控项目。', noServers: '此页面暂无公开的机器。',
      allUp: '所有监控运行正常', someDown: '部分监控发生故障', someWarn: '部分监控需要关注',
      pending: '等待状态数据', allOnline: '所有机器在线', someOffline: '部分机器离线',
      someUnknown: '部分状态未知', online: '在线', offline: '离线', operational: '运行正常',
      down: '故障', warning: '警告', unknown: '未知', noData: '暂无数据',
      updated: '更新于', footer: '公开状态页面', availability: '可用率', cpu: 'CPU', items: '项'
    }
  };
  let lang = 'en';
  let loading = false;
  const t = (key) => strings[lang][key];
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  function localize() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    $('refresh').textContent = t('refresh');
    $('eyebrow').textContent = t(target === 'agent' ? 'machines' : 'service');
    $('overview-label').textContent = t('current');
    $('list-eyebrow').textContent = t('live');
    $('list-title').textContent = t(target === 'agent' ? 'servers' : 'monitors');
    $('footer').textContent = t('footer');
  }
  function stateOf(item) {
    if (target === 'agent') return item.online === true ? 'good' : item.online === false ? 'bad' : 'unknown';
    if (item.source_available === false || item.st == null || item.st === 4) return 'unknown';
    return item.st === 1 ? 'good' : item.st === 0 ? 'bad' : item.st === 2 ? 'warn' : 'unknown';
  }
  function stateLabel(state) {
    if (target === 'agent') return t({ good: 'online', bad: 'offline', unknown: 'unknown' }[state]);
    return t({ good: 'operational', bad: 'down', warn: 'warning', unknown: 'unknown' }[state]);
  }
  function applyConfig(config) {
    const locale = config.presentation?.locale;
    lang = typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    localize();
    $('custom-content').innerHTML = typeof config.theme_content_html === 'string' ? config.theme_content_html : '';
    const settings = config.theme_settings || {};
    const accent = settings.accent;
    if (typeof accent === 'string' && /^#[0-9a-f]{6}$/i.test(accent)) document.documentElement.style.setProperty('--accent', accent);
    const mode = config.presentation?.colorMode;
    if (mode === 'dark' || mode === 'light') document.documentElement.dataset.mode = mode;
    else delete document.documentElement.dataset.mode;
    const headline = typeof settings.headline === 'string' ? settings.headline.trim() : '';
    const title = headline || config.siteMeta?.title || 'Uptime Polaris';
    $('title').textContent = title;
    document.title = title + ' · Polaris Simple';
    $('description').textContent = typeof settings.description === 'string' && settings.description.trim() ? settings.description : config.siteMeta?.description || '';
  }
  function renderItem(item) {
    const state = stateOf(item);
    const row = node('article', 'item');
    const left = node('div');
    left.append(node('p', 'item-name', item.name || '—'));
    const detail = target === 'agent' ? item.group?.name : item.group;
    if (detail) left.append(node('p', 'item-sub', detail));
    const right = node('div', 'item-right');
    if (target === 'monitor' && typeof item.uptime === 'number' && Number.isFinite(item.uptime)) {
      right.append(node('span', 'metric', `${t('availability')} ${item.uptime.toFixed(2)}%`));
    }
    if (target === 'agent' && typeof item.cpu === 'number' && Number.isFinite(item.cpu)) {
      right.append(node('span', 'metric', `${t('cpu')} ${item.cpu.toFixed(1)}%`));
    }
    const label = node('span', `state ${state}`);
    const dot = node('span', `dot ${state}`);
    dot.setAttribute('aria-hidden', 'true');
    label.append(dot, document.createTextNode(stateLabel(state)));
    right.append(label);
    row.append(left, right);
    return row;
  }
  function render(data) {
    const items = target === 'agent' ? data.servers : data.monitors;
    if (!Array.isArray(items)) throw new Error('Invalid public data');
    const states = items.map(stateOf);
    const state = states.includes('bad') ? 'bad' : states.includes('warn') ? 'warn' : !items.length || states.includes('unknown') ? 'unknown' : 'good';
    const titleKey = !items.length ? 'noData' : state === 'bad' ? (target === 'agent' ? 'someOffline' : 'someDown') : state === 'warn' ? 'someWarn' : state === 'unknown' ? 'someUnknown' : target === 'agent' ? 'allOnline' : 'allUp';
    $('signal').className = `signal ${state}`;
    $('overall').textContent = t(titleKey);
    $('summary').textContent = `${items.length} ${t('items')}`;
    $('count').textContent = String(items.length);
    $('updated').textContent = `${t('updated')} ${new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`;
    $('content').replaceChildren(...(items.length ? items.map(renderItem) : [node('p', 'message', t(target === 'agent' ? 'noServers' : 'noMonitors'))]));
  }
  async function refresh() {
    if (loading) return;
    loading = true;
    $('refresh').disabled = true;
    $('overall').textContent = t('loading');
    $('signal').className = 'signal';
    try {
      const sdk = window.polarisTheme;
      if (!sdk) throw new Error('Theme SDK unavailable');
      const [config, data] = await Promise.allSettled([sdk.read('config'), sdk.read(target === 'agent' ? 'servers' : 'status')]);
      if (config.status === 'fulfilled') applyConfig(config.value);
      if (config.status === 'rejected' || data.status === 'rejected') throw new Error('Public data unavailable');
      render(data.value);
    } catch {
      $('overall').textContent = t('error');
      $('summary').textContent = '';
      $('updated').textContent = '';
      $('count').textContent = '—';
      $('content').replaceChildren(node('p', 'message', t('errorDetail')));
    } finally {
      $('refresh').disabled = false;
      loading = false;
    }
  }
  lang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  localize();
  $('refresh').addEventListener('click', refresh);
  refresh();
})();
