import { MAINTENANCE_STYLE } from '../../../../../shared/maintenance-style';
import {
  BRAND_BLUE,
  BRAND_RING_PATH,
  RING,
  TIGHT_VIEWBOX,
} from '../../../../../shared/brand-mark';
import type { PublicMaintenancePeriod } from './maintenance';
import en from '../../../../../frontend/src/locales/en-US.json';
import zhCN from '../../../../../frontend/src/locales/zh-CN.json';
import zhTW from '../../../../../frontend/src/locales/zh-TW.json';
import zhHK from '../../../../../frontend/src/locales/zh-HK.json';
import ja from '../../../../../frontend/src/locales/ja-JP.json';
import ko from '../../../../../frontend/src/locales/ko-KR.json';
import fr from '../../../../../frontend/src/locales/fr-FR.json';
import pt from '../../../../../frontend/src/locales/pt-BR.json';
import ru from '../../../../../frontend/src/locales/ru-RU.json';

const labels = Object.fromEntries(
  Object.entries({
    en,
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    'zh-HK': zhHK,
    ja,
    ko,
    fr,
    pt,
    ru,
  }).map(([locale, messages]) => [
    locale,
    [
      messages.maintenance.InProgress,
      messages.publicMaintenance.description,
      messages.publicMaintenance.signIn,
      messages.publicMaintenance.scheduled,
      messages.publicMaintenance.expectedEnd,
    ],
  ]),
);

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}

export function maintenancePage(
  period: Pick<PublicMaintenancePeriod, 'title' | 'description'> & {
    endsAt?: string | null;
  },
  locale: string,
): string {
  const mark = (size: number, className = '') =>
    `<svg class="${className}" width="${size}" height="${size}" viewBox="${TIGHT_VIEWBOX}" aria-hidden="true"><path d="${BRAND_RING_PATH}" fill="none" stroke="${BRAND_BLUE}" stroke-width="${RING.strokeWidth}" stroke-linecap="round"/></svg>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(period.title || en.maintenance.InProgress)}</title><style>*{box-sizing:border-box}body{margin:0}${MAINTENANCE_STYLE}</style></head><body data-polaris-maintenance-page data-locale="${escapeHtml(locale)}"><main class="polaris-maintenance"><div class="maintenance-wrap"><header class="maintenance-header"><span class="maintenance-brand">${mark(28)}Uptime Polaris</span><a href="/login" class="maintenance-login"><span id="maintenance-login">${escapeHtml(en.publicMaintenance.signIn)}</span><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7 7h10v10M7 17 17 7"/></svg></a></header><section class="maintenance-content"><div class="maintenance-copy"><h1 id="maintenance-title">${escapeHtml(period.title || en.maintenance.InProgress)}</h1><p id="maintenance-description" class="maintenance-description">${escapeHtml(period.description || en.publicMaintenance.description)}</p><p id="maintenance-end" class="maintenance-end"${period.endsAt ? '' : ' hidden'}><span id="maintenance-end-label">${escapeHtml(en.publicMaintenance.expectedEnd)}</span><time id="maintenance-end-time" datetime="${escapeHtml(period.endsAt || '')}">${escapeHtml(period.endsAt || '')}</time></p></div><div class="maintenance-visual" aria-hidden="true">${mark(240, 'maintenance-orbit')}<svg class="maintenance-tool" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-7.27 7.27a2.12 2.12 0 0 1-3-3l7.27-7.27a6 6 0 0 1 7.94-7.94z"/></svg></div></section></div></main><script src="/polaris-maintenance.js" defer></script></body></html>`;
}

export const maintenanceScript = String.raw`(() => {
  const labels = ${JSON.stringify(labels)};
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
})();`;
