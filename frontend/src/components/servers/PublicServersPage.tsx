import { ApiError } from '@/api/errors';
import { Footer } from '@/components/status-page/Footer';
import { ThemeSwitch } from '@/components/ui/ThemeSwitch';
import { useLocale } from '@/i18n/IntlProvider';
import { LocaleSwitch } from '@/i18n/LocaleSwitch';
import { PROJECT_NAME } from '@/lib/project';
import { RouteError } from '@/routes/RouteStates';
import clsx from 'clsx';
import { AlertTriangle, Keyboard, Monitor, RefreshCw, Timer } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { BRAND_BLUE, BRAND_RING_PATH, RING, TIGHT_VIEWBOX } from '../../../../shared/brand-mark';
import { CompareView } from './CompareView';
import { COMPARE_LIMIT, compareIds, selectServers, serverFilters, type DetailResponse, type FleetResponse, type ServerPageConfig, type ServerView } from './model';
import { ServerDetail } from './ServerDetail';
import { CompareTray, ServerList } from './ServerList';
import { useServerData } from './useServerData';
import { refreshIntervals, useLiveSamples, usePins, useRefreshInterval } from './useVisitorState';
import { WallView } from './WallView';
import { countryCode } from './geo';
import { FilterSelect } from './FilterSelect';
import './servers.css';

const EMPTY: PublicServer[] = [];
const ROUTE_KEYS = ['compare', 'wall'];

/**
 * The public machine page: list, detail, comparison and wall display over the two public machine endpoints.
 * Filters, view, comparison and wall mode live in the URL so any state can be shared; pins and the refresh
 * interval are this browser's own.
 *
 * 公开机器页：基于两个公开接口提供列表、详情、对比和墙板。筛选、视图、对比和墙板状态保存在 URL 中便于分享；
 * 收藏和刷新间隔只保存在当前浏览器。
 */
export function PublicServersPage({ config, configError, configRefreshing, onRefreshConfig }: {
  config: ServerPageConfig;
  configError?: unknown;
  configRefreshing: boolean;
  onRefreshConfig: () => Promise<unknown>;
}) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const [params, setParams] = useSearchParams();
  const [interval, setRefreshInterval] = useRefreshInterval();
  const { pins, toggle: togglePin } = usePins();
  const [selection, setSelection] = useState<string[]>(() => compareIds(params.get('compare')));
  const [compareRefreshKey, setCompareRefreshKey] = useState(0);
  const [compareRefreshing, setCompareRefreshing] = useState(false);
  const [help, setHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const fleet = useServerData<FleetResponse>('/api/public/servers', interval);
  const detail = useServerData<DetailResponse>(id ? `/api/public/servers/${encodeURIComponent(id)}` : null, interval);
  const servers = fleet.data?.servers ?? EMPTY;
  const live = useLiveSamples(fleet.data?.servers, fleet.updatedAt);
  const presentation = config.presentation;

  const skew = fleet.data && fleet.updatedAt ? fleet.data.now - Math.floor(fleet.updatedAt / 1000) : 0;
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const timer = window.setInterval(() => setClock(Math.floor(Date.now() / 1000)), 5000); return () => window.clearInterval(timer); }, []);
  const now = clock + skew;

  const viewParam = params.get('view');
  const hasRegion = servers.some(server => countryCode(server.region) !== null);
  const view: ServerView = viewParam === 'list' || viewParam === 'cards' || viewParam === 'map' && hasRegion ? viewParam : presentation.layout;
  const filters = serverFilters(params);
  const wall = params.get('wall') === '1';
  const compare = id ? [] : compareIds(params.get('compare'));
  const visible = useMemo(() => selectServers(servers, filters, locale), [servers, filters.query, filters.status, filters.group, filters.tag, filters.region, filters.sort, locale]);
  /** The list's own reading order (pins, then groups), which J/K and previous/next follow. / 列表的阅读顺序（收藏优先，再按分组），J/K 与上一台/下一台按此顺序。 */
  const order = useMemo(() => {
    const pinned = pins.map(pin => visible.find(server => server.id === pin)).filter((server): server is PublicServer => Boolean(server));
    const rest = visible.filter(server => !pins.includes(server.id));
    if (filters.sort !== 'default') return [...pinned, ...rest];
    const groups = [...new Set(rest.map(server => server.group?.id ?? ''))];
    return [...pinned, ...groups.flatMap(group => rest.filter(server => (server.group?.id ?? '') === group))];
  }, [visible, pins, filters.sort]);

  const listQuery = useMemo(() => { const next = new URLSearchParams(params); ROUTE_KEYS.forEach(key => next.delete(key)); return next.toString(); }, [params]);
  const href = useCallback((serverId?: string) => `${serverId ? `/server/${encodeURIComponent(serverId)}` : '/'}${listQuery ? `?${listQuery}` : ''}`, [listQuery]);
  const change = useCallback((key: string, value: string) => setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set(key, value); else next.delete(key); return next; }, { replace: true }), [setParams]);
  const clear = useCallback(() => setParams(previous => { const next = new URLSearchParams(previous); ['q', 'status', 'group', 'tag', 'region', 'sort'].forEach(key => next.delete(key)); return next; }, { replace: true }), [setParams]);
  const toggleSelect = useCallback((serverId: string) => setSelection(current => current.includes(serverId) ? current.filter(item => item !== serverId) : current.length >= COMPARE_LIMIT ? current : [...current, serverId]), []);
  const openCompare = useCallback(() => { if (selection.length >= 2) navigate(`/?${new URLSearchParams([...new URLSearchParams(listQuery), ['compare', selection.join(',')]]).toString()}`); }, [selection, listQuery, navigate]);
  const removeCompared = (serverId: string) => {
    const rest = compare.filter(item => item !== serverId);
    setSelection(rest);
    change('compare', rest.length ? rest.join(',') : '');
  };
  const refresh = useCallback(() => { void onRefreshConfig().catch(() => undefined); void fleet.refresh(); if (id) void detail.refresh(); if (compare.length) setCompareRefreshKey(key => key + 1); }, [onRefreshConfig, fleet, detail, id, compare.length]);
  const setWall = useCallback((on: boolean) => {
    change('wall', on ? '1' : '');
    if (on) void document.documentElement.requestFullscreen?.().catch(() => undefined);
    else if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
  }, [change]);

  const position = id ? order.findIndex(server => server.id === id) : -1;
  const prev = position > 0 ? order[position - 1] : null;
  const next = position >= 0 && position < order.length - 1 ? order[position + 1] : null;
  const current = detail.data?.server;
  const siteTitle = config.siteMeta.title || PROJECT_NAME;

  useEffect(() => {
    document.title = current && id ? `${current.name} · ${siteTitle}` : compare.length ? `${t('compareTitle', { n: compare.length })} · ${siteTitle}` : siteTitle;
  }, [current, id, compare.length, siteTitle, t]);
  const compareParam = params.get('compare');
  useEffect(() => {
    setSelection(previous => {
      const next = (compareParam ? compareIds(compareParam) : previous).filter(serverId => !fleet.data || servers.some(server => server.id === serverId));
      return next.length === previous.length && next.every((serverId, index) => serverId === previous[index]) ? previous : next;
    });
  }, [compareParam, servers, fleet.data]);
  useEffect(() => {
    if (!wall) return;
    const leave = () => { if (!document.fullscreenElement && params.get('wall') === '1') change('wall', ''); };
    document.addEventListener('fullscreenchange', leave);
    return () => document.removeEventListener('fullscreenchange', leave);
  }, [wall, params, change]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], dialog, [data-keyboard-menu]')) {
        if (event.key === 'Escape' && target instanceof HTMLInputElement) target.blur();
        return;
      }
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-server-id]')?.dataset.serverId;
      const subject = focused ?? (id || undefined);
      const move = (step: number) => {
        if (id) { const target = step > 0 ? next : prev; if (target) navigate(href(target.id)); return; }
        const items = [...document.querySelectorAll<HTMLElement>('[data-server-id]')];
        if (!items.length) return;
        const index = items.findIndex(item => item.contains(document.activeElement));
        const item = items[index === -1 ? (step > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, index + step))];
        item.querySelector<HTMLElement>('.server-link')?.focus();
        item.scrollIntoView({ block: 'nearest' });
      };
      const actions: Record<string, () => void> = {
        '/': () => { if (!id && !compare.length && !wall) searchRef.current?.focus(); },
        '?': () => setHelp(true),
        j: () => move(1), k: () => move(-1),
        f: () => { if (subject) togglePin(subject); },
        x: () => { if (subject) toggleSelect(subject); },
        c: openCompare,
        v: () => { if (!id && !compare.length) { const views: ServerView[] = hasRegion ? ['cards', 'list', 'map'] : ['cards', 'list']; change('view', views[(views.indexOf(view) + 1) % views.length]); } },
        w: () => setWall(!wall),
        r: refresh,
        Escape: () => { if (wall) setWall(false); else if (compare.length || id) navigate(href()); else if (selection.length) setSelection([]); },
      };
      const action = actions[event.key] ?? actions[event.key.toLowerCase()];
      if (!action || (event.key === 'Escape' && !wall && !compare.length && !id && !selection.length)) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const icon = <SiteIcon source={config.siteMeta.icon} />;
  const style = { '--polaris-accent': presentation.accent, '--polaris-chart': presentation.accent, '--polaris-page-width': `${presentation.width}px` } as CSSProperties;
  const error = (id ? detail.error ?? fleet.error : fleet.error) ?? configError;
  const refreshing = configRefreshing || fleet.refreshing || detail.refreshing || compareRefreshing;

  if (wall && fleet.data) {
    return <div className="polaris" style={style}><WallView servers={servers} live={live} now={now} title={siteTitle} icon={icon} updatedAt={fleet.updatedAt} onExit={() => setWall(false)} /></div>;
  }

  return (
    <div className="polaris server-page relative flex min-h-dvh flex-col bg-[var(--polaris-canvas)] text-[var(--polaris-ink)]" style={style} data-density={presentation.density}>
      <header className="server-site-header sticky top-0 z-40 border-b border-[var(--polaris-line)] bg-[var(--polaris-canvas)]/85 backdrop-blur-md">
        <div className="server-header-inner mx-auto flex h-14 w-full max-w-[var(--polaris-page-width,1120px)] items-center gap-3 px-4 sm:px-6">
          <Link to={href()} className="server-site-brand flex min-w-0 items-center gap-2.5 rounded-lg py-1 pr-1.5">
            {icon}<span className="truncate text-[15px] font-semibold tracking-[-0.02em]">{siteTitle}</span>
          </Link>
          <div className="server-header-actions ml-auto flex items-center gap-1">
            <RefreshControl interval={interval} onInterval={setRefreshInterval} refreshing={refreshing} onRefresh={refresh} />
            <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-[var(--polaris-line)] sm:block" />
            <nav aria-label={t('displayPreferences')} className="flex items-center gap-0.5 text-[var(--polaris-ink-3)] [&_button]:h-8 [&_button]:w-8 [&_button]:min-w-8 [&_svg]:h-[17px] [&_svg]:w-[17px]">
              <button type="button" onClick={() => setWall(true)} aria-label={t('wallMode')} title={`${t('wallMode')} (W)`} className="server-desktop-only hidden items-center justify-center rounded-lg transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)] sm:inline-flex"><Monitor /></button>
              <button type="button" onClick={() => setHelp(true)} aria-label={t('shortcuts')} title={`${t('shortcuts')} (?)`} className="server-desktop-only hidden items-center justify-center rounded-lg transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)] sm:inline-flex"><Keyboard /></button>
              <ThemeSwitch radius="md" />
              <LocaleSwitch />
            </nav>
          </div>
        </div>
      </header>
      <main className="server-main mx-auto w-full max-w-[var(--polaris-page-width,1120px)] grow px-4 pt-6 pb-24 sm:px-6">
        {!id && !compare.length ? (
          <div className="server-page-heading mb-5 flex flex-wrap items-end gap-x-4 gap-y-1">
            <div className="min-w-0">
              <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em] text-[var(--polaris-ink)]">{t('machines')}</h1>
              {config.siteMeta.description ? <p className="mt-1 text-[13px] text-[var(--polaris-ink-3)]">{config.siteMeta.description}</p> : null}
            </div>
            {fleet.updatedAt ? <p className="polaris-num ml-auto text-[12px] text-[var(--polaris-ink-4)]">{t('updatedAt', { time: new Date(fleet.updatedAt).toLocaleTimeString(locale) })}</p> : null}
          </div>
        ) : null}
        {error && (fleet.data || detail.data) ? (
          <div role="alert" className="mb-4 flex flex-wrap items-center gap-2.5 rounded-[10px] border border-warning/30 bg-warning/[0.06] px-4 py-2.5 text-[13px] text-warning-700">
            <AlertTriangle size={15} className="shrink-0" aria-hidden="true" /><span>{t('refreshFailed')}</span>
            <button type="button" onClick={refresh} disabled={refreshing} className="ml-auto rounded-md px-2 py-0.5 font-medium underline-offset-2 hover:underline disabled:opacity-50">{t('retry')}</button>
          </div>
        ) : null}
        {!fleet.data && fleet.error ? <RouteError code="render" error={fleet.error} onRetry={refresh} embedded />
          : !fleet.data ? <Skeleton />
          : id ? (
            current ? <ServerDetail server={current} history={detail.data!.history} serverNow={detail.data!.now} now={now} samples={live[current.id]} showHistory={presentation.showHistory} accent={presentation.accent}
                listHref={href()} prev={prev ? { href: href(prev.id), name: prev.name } : null} next={next ? { href: href(next.id), name: next.name } : null}
                pinned={pins.includes(current.id)} onPin={() => togglePin(current.id)} selected={selection.includes(current.id)} selectionFull={selection.length >= COMPARE_LIMIT}
                onSelect={() => toggleSelect(current.id)} onTag={tag => navigate(`/?${new URLSearchParams([...new URLSearchParams(listQuery), ['tag', tag]]).toString()}`)} />
              : detail.error ? <RouteError code={detail.error instanceof ApiError && detail.error.status === 404 ? 'notFound' : 'render'} error={detail.error} onRetry={refresh} embedded />
              : <Skeleton detail />
          )
          : compare.length ? <CompareView ids={compare} servers={servers} now={now} interval={interval} refreshKey={compareRefreshKey} onRefreshingChange={setCompareRefreshing} showHistory={presentation.showHistory} accent={presentation.accent} backHref={href()} hrefOf={serverId => href(serverId)} onRemove={removeCompared} />
          : <ServerList servers={servers} visible={visible} live={live} now={now} filters={filters} view={view} density={presentation.density} columns={presentation.columns}
              pins={pins} selection={selection} href={href} change={change} clear={clear} onPin={togglePin} onSelect={toggleSelect} onClearSelection={() => setSelection([])} onCompare={openCompare} searchRef={searchRef} />}
        {id ? <CompareTray servers={servers} selection={selection} onRemove={toggleSelect} onClear={() => setSelection([])} onCompare={openCompare} /> : null}
      </main>
      <Footer config={{ footerText: config.config.footerText }} />
      {help ? <ShortcutsDialog onClose={() => setHelp(false)} /> : null}
    </div>
  );
}

function RefreshControl({ interval, onInterval, refreshing, onRefresh }: { interval: number; onInterval: (value: number) => void; refreshing: boolean; onRefresh: () => void }) {
  const t = useTranslations('presentation');
  return (
    <span className="server-refresh-control flex items-center gap-1">
      <FilterSelect label={t('refreshInterval')} className="server-refresh-select" value={String(interval)} onChange={value => onInterval(Number(value))}
        leading={<><Timer size={17} className="server-refresh-timer" aria-hidden="true" /><span aria-hidden="true" className={clsx('server-refresh-dot h-1.5 w-1.5 rounded-full', interval ? 'polaris-live bg-success' : 'bg-default-300')} /></>}
        options={refreshIntervals.map(value => ({ value: String(value), label: value ? t('everySeconds', { n: value / 1000 }) : t('refreshOff') }))} />
      <button type="button" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing} aria-label={t('refresh')} title={`${t('refresh')} (R)`}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)] disabled:opacity-60">
        <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
      </button>
    </span>
  );
}

const SHORTCUTS: Array<[string[], string]> = [
  [['/'], 'kbSearch'], [['J', 'K'], 'kbMove'], [['Enter'], 'kbOpen'], [['F'], 'kbPin'], [['X'], 'kbCompare'],
  [['C'], 'kbOpenCompare'], [['V'], 'kbView'], [['W'], 'kbWall'], [['R'], 'kbRefresh'], [['Esc'], 'kbBack'], [['?'], 'kbHelp'],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('presentation');
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (dialog && !dialog.open) dialog.showModal(); }, []);
  return (
    <dialog ref={ref} onClose={onClose} onClick={event => { if (event.target === ref.current) onClose(); }} aria-labelledby="server-shortcuts-title"
      className="server-dialog m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] p-0 text-[var(--polaris-ink)] shadow-[var(--polaris-shadow-float)]">
      <div className="flex items-center gap-2 border-b border-[var(--polaris-line)] px-5 py-3.5">
        <Keyboard size={16} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
        <h2 id="server-shortcuts-title" className="text-[14px] font-semibold">{t('shortcuts')}</h2>
        <button type="button" onClick={onClose} className="ml-auto rounded-md px-2 py-1 text-[12px] text-[var(--polaris-ink-3)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">{t('close')}</button>
      </div>
      <dl className="px-5 py-2">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} className="flex items-center justify-between gap-4 border-b border-[var(--polaris-line-soft)] py-2.5 text-[13px] last:border-0">
            <dt className="text-[var(--polaris-ink-2)]">{t(label)}</dt>
            <dd className="flex gap-1">{keys.map(key => <kbd key={key} className="polaris-kbd">{key}</kbd>)}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}

function SiteIcon({ source }: { source: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  return source && !failed
    ? <img src={source} width={24} height={24} alt="" className="shrink-0 rounded-md object-contain" onError={() => setFailed(true)} />
    : <svg viewBox={TIGHT_VIEWBOX} width={24} height={24} aria-hidden="true" className="shrink-0"><path d={BRAND_RING_PATH} fill="none" stroke={BRAND_BLUE} strokeWidth={RING.strokeWidth} strokeLinecap="round" /></svg>;
}

function Skeleton({ detail = false }: { detail?: boolean }) {
  const t = useTranslations('presentation');
  return (
    <div role="status" aria-label={t('loading')} className="flex flex-col gap-4">
      <span className="sr-only">{t('loading')}</span>
      <div className="polaris-shimmer h-[148px] rounded-xl" />
      <div className={clsx('grid gap-4', detail ? 'sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-3')}>
        {Array.from({ length: detail ? 3 : 6 }, (_, index) => <div key={index} className="polaris-shimmer h-[220px] rounded-xl" style={{ animationDelay: `${index * 80}ms` }} />)}
      </div>
    </div>
  );
}
