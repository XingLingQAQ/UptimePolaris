import { Segmented } from '@/components/ui/Segmented';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { NAV_TRANSITION } from '@/lib/motion';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocale } from '@/i18n/IntlProvider';
import { ChevronDown, GitCompareArrows, Search, Server, SlidersHorizontal, Star, X } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { useMediaQuery } from 'usehooks-ts';
import type { PublicServer } from '../../../../shared/public-servers';
import { FleetStrip } from './FleetStrip';
import { countryCode, countryName } from './geo';
import { MapOverview, MapView } from './MapView';
import { FilterSelect } from './FilterSelect';
import { COMPARE_LIMIT, NO_REGION, regionKey, selectServers, serverSorts, serverStates, stateOf, type ServerFilters, type ServerSort, type ServerView } from './model';
import { ServerCard } from './ServerCard';
import { ServerTable, type TableSection } from './ServerTable';
import type { LiveSeries } from './useVisitorState';

export interface ListProps {
  servers: PublicServer[]; visible: PublicServer[]; live: LiveSeries; now: number;
  filters: ServerFilters;
  view: ServerView; density: 'compact' | 'normal' | 'comfortable'; columns: number;
  pins: string[]; selection: string[];
  href: (id?: string) => string; change: (key: string, value: string) => void; clear: () => void;
  onPin: (id: string) => void; onSelect: (id: string) => void; onClearSelection: () => void; onCompare: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * The list route: fleet overview, a sticky toolbar, pinned machines, then the fleet by group as cards or a table.
 * 列表页：机群概览、吸顶工具栏、收藏机器，然后按分组以卡片或表格展示。
 */
export function ServerList(props: ListProps) {
  const t = useTranslations('presentation');
  const { servers, visible, filters, view, pins, selection, href, change } = props;
  const { locale } = useLocale();
  const narrow = useMediaQuery('(max-width: 767px)');
  const hasRegion = servers.some(server => countryCode(server.region) !== null);
  const regions = useMemo(() => hasRegion ? [...new Set(servers.map(regionKey))].sort((a, b) => (a === NO_REGION ? 1 : 0) - (b === NO_REGION ? 1 : 0) || countryName(a, locale).localeCompare(countryName(b, locale), locale)) : [], [servers, hasRegion, locale]);
  const overviewServers = useMemo(() => selectServers(servers, { ...filters, region: '' }, locale), [servers, filters, locale]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const groups = useMemo(() => [...new Map(servers.filter(server => server.group).map(server => [server.group!.id, server.group!])).values()], [servers]);
  const tags = useMemo(() => [...new Map(servers.flatMap(server => server.tags.map(tag => [tag.id, tag] as const))).values()], [servers]);
  const counts = useMemo(() => Object.fromEntries(serverStates.map(state => [state, servers.filter(server => stateOf(server) === state).length])), [servers]);
  const filtered = Boolean(filters.query || filters.group || filters.tag || filters.region || filters.status !== 'all');
  const pinned = visible.filter(server => pins.includes(server.id));
  const rest = visible.filter(server => !pins.includes(server.id));
  const sections = useMemo(() => {
    if (filters.sort !== 'default' || !groups.length) return [{ key: 'all', label: '', rows: rest }];
    const map = new Map<string, { key: string; label: string; rows: PublicServer[] }>();
    for (const server of rest) {
      const key = server.group?.id ?? '';
      if (!map.has(key)) map.set(key, { key, label: server.group?.name ?? t('ungrouped'), rows: [] });
      map.get(key)!.rows.push(server);
    }
    return [...map.values()];
  }, [rest, filters.sort, groups.length, t]);

  const common = { now: props.now, selectionFull: selection.length >= COMPARE_LIMIT, onPin: props.onPin, onSelect: props.onSelect, onTag: (tag: string) => change('tag', tag) };
  const toggle = (key: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const cards = (rows: PublicServer[]) => (
    <div className="server-grid grid gap-4" style={{ '--server-columns': props.columns } as React.CSSProperties}>
      {rows.map(server => <ServerCard key={server.id} server={server} href={href(server.id)} samples={props.live[server.id]} pinned={pins.includes(server.id)} selected={selection.includes(server.id)} density={props.density} {...common} />)}
    </div>
  );
  const table = view === 'list';
  const tableSections: TableSection[] = [
    ...(pinned.length ? [{ key: 'pinned', label: t('pinned'), pinned: true, online: 0, rows: pinned, collapsed: false }] : []),
    ...sections.map(section => ({ key: section.key, label: section.label || (pinned.length ? t('allMachines') : ''), online: section.rows.filter(server => server.online === true).length, rows: section.rows,
      collapsed: collapsed.has(section.key), onToggle: section.label ? () => toggle(section.key) : undefined })),
  ];

  return (
    <>
      <div className="server-overview-grid">
        {narrow ? <FleetStrip servers={servers} live={props.live} status={filters.status} onStatus={status => change('status', status)} href={id => href(id)} /> : null}
        {!narrow || view !== 'map' ? <MapOverview servers={overviewServers} region={filters.region} onRegion={code => change('region', code)} collapsible={narrow} /> : null}
        {!narrow ? <FleetStrip servers={servers} live={props.live} status={filters.status} onStatus={status => change('status', status)} href={id => href(id)} /> : null}
      </div>
      <Toolbar {...props} groups={groups} tags={tags} counts={counts} regions={regions} hasRegion={hasRegion} />
      <p className="server-results mb-3 flex items-center gap-2 text-[12px] text-[var(--polaris-ink-3)]" aria-live="polite">
        <span className="polaris-num">{t('resultCount', { n: visible.length, total: servers.length })}</span>
        {filtered ? <button type="button" onClick={props.clear} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[var(--polaris-ink-2)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">{t('clearFilters')}<X size={12} /></button> : null}
        <span className="ml-auto hidden items-center gap-1.5 sm:flex"><kbd className="polaris-kbd">?</kbd>{t('shortcuts')}</span>
      </p>
      {!servers.length ? <Empty title={t('empty')} hint={t('emptyHint')} />
        : view === 'map' && hasRegion && visible.length > 0 ? <MapView servers={overviewServers} region={filters.region} onRegion={code => change('region', code)} href={id => href(id)} now={props.now} />
        : !visible.length ? <Empty title={t('noMatches')} hint={t('noMatchesHint')} action={<button type="button" className="server-button" onClick={props.clear}>{t('clearFilters')}</button>} />
        : table ? <ServerTable sections={tableSections} hrefOf={id => href(id)} samplesOf={id => props.live[id]} pins={pins} selection={selection} sort={filters.sort} onSort={(sort: ServerSort) => change('sort', sort === 'default' ? '' : sort)} {...common} />
        : <div className="flex flex-col gap-7">
          {pinned.length ? <Section icon={<Star size={14} className="fill-amber-400 text-amber-500" />} label={t('pinned')} count={pinned.length}>{cards(pinned)}</Section> : null}
          {sections.map(section => section.rows.length ? (
            section.label
              ? <Section key={section.key} label={section.label} count={section.rows.length} online={section.rows.filter(server => server.online === true).length} collapsed={collapsed.has(section.key)} onToggle={() => toggle(section.key)}>{cards(section.rows)}</Section>
              : <div key={section.key}>{cards(section.rows)}</div>
          ) : null)}
        </div>}
      <CompareTray servers={servers} selection={selection} onRemove={props.onSelect} onClear={props.onClearSelection} onCompare={props.onCompare} />
    </>
  );
}

function Toolbar({ servers, filters, view, change, searchRef, groups, tags, counts, regions, hasRegion }: ListProps & {
  groups: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string; color: string }>; counts: Record<string, number>; regions: string[]; hasRegion: boolean;
}) {
  const { locale } = useLocale();
  const t = useTranslations('presentation');
  const filtersId = useId();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterCount = [filters.group, filters.tag, filters.region, filters.sort !== 'default'].filter(Boolean).length;
  return (
    <div className="server-toolbar sticky top-14 z-30 -mx-4 mt-5 mb-3 border-b border-transparent bg-[var(--polaris-canvas)]/88 px-4 py-2.5 backdrop-blur-md sm:-mx-6 sm:px-6">
      <div className="server-toolbar-layout flex flex-wrap items-center gap-2">
        <div className="server-search-row">
          <label className="server-search flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--polaris-line-strong)] bg-[var(--polaris-card)] px-2.5 shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-shadow focus-within:border-[var(--polaris-field-focus)] focus-within:shadow-[0_0_0_3px_var(--polaris-ring)] sm:w-60">
            <Search size={14} className="shrink-0 text-[var(--polaris-ink-4)]" aria-hidden="true" />
            <input ref={searchRef} type="search" value={filters.query} onChange={event => change('q', event.target.value)} placeholder={t('searchMachines')} aria-label={t('searchMachines')}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--polaris-ink)] outline-none placeholder:text-[var(--polaris-ink-4)] [&::-webkit-search-cancel-button]:hidden" />
            {filters.query ? <button type="button" aria-label={t('clearSearch')} onClick={() => { change('q', ''); searchRef.current?.focus(); }} className="text-[var(--polaris-ink-4)] transition-colors hover:text-[var(--polaris-ink)]"><X size={14} /></button> : <kbd className="polaris-kbd hidden sm:inline-flex">/</kbd>}
          </label>
          <button type="button" className={clsx('server-mobile-filter-toggle', filtersOpen && 'is-active')} aria-label={t('filtersAndSort')} title={t('filtersAndSort')} aria-expanded={filtersOpen} aria-controls={filtersId} onClick={() => setFiltersOpen(open => !open)}>
            <SlidersHorizontal size={18} aria-hidden="true" />{filterCount ? <span className="polaris-num">{filterCount}</span> : null}
          </button>
        </div>
        <div className="server-status-filter max-w-full overflow-x-auto">
          <Segmented className="server-status-segments" label={t('statusFilter')} value={filters.status} onChange={value => change('status', value === 'all' ? '' : value)}
            options={[{ value: 'all', label: t('allStates'), count: servers.length }, ...serverStates.filter(state => counts[state] || filters.status === state).map(state => ({ value: state, label: t(state), count: counts[state] }))]} />
        </div>
        <div id={filtersId} className={clsx('server-filter-fields', filtersOpen && 'is-open')}>
          {groups.length ? <FilterSelect label={t('allGroups')} value={filters.group} options={[{ value: '', label: t('allGroups') }, ...groups.map(group => ({ value: group.id, label: group.name }))]} onChange={value => change('group', value)} /> : null}
          {tags.length ? <FilterSelect label={t('allTags')} value={filters.tag} options={[{ value: '', label: t('allTags') }, ...tags.map(tag => ({ value: tag.id, label: tag.name }))]} onChange={value => change('tag', value)} /> : null}
          {regions.length ? <FilterSelect label={t('allRegions')} value={filters.region} options={[{ value: '', label: t('allRegions') }, ...regions.map(code => ({ value: code, label: code === NO_REGION ? t('unknownRegion') : countryName(code, locale) }))]} onChange={value => change('region', value)} /> : null}
          <FilterSelect className="server-sort-filter" label={t('sortLabel')} value={filters.sort} options={serverSorts.map(sort => ({ value: sort, label: t(`sort_${sort}`) }))} onChange={value => change('sort', value === 'default' ? '' : value)} />
        </div>
        <div className="server-view-controls flex min-w-0 items-center gap-2">
          <Segmented label={t('viewLabel')} value={view} onChange={value => change('view', value)} options={[{ value: 'cards' as ServerView, label: t('cardsView') }, { value: 'list' as ServerView, label: t('listView') }, ...(hasRegion ? [{ value: 'map' as ServerView, label: t('mapView') }] : [])]} />
        </div>
      </div>
    </div>
  );
}

function Section({ icon, label, count, online, collapsed, onToggle, children }: { icon?: ReactNode; label: string; count: number; online?: number; collapsed?: boolean; onToggle?: () => void; children: ReactNode }) {
  const t = useTranslations('presentation');
  const title = <><span className="truncate">{label}</span><span className="polaris-num text-[12px] font-normal text-[var(--polaris-ink-4)]">{online === undefined ? count : t('groupOnline', { online, n: count })}</span></>;
  return (
    <section>
      <h2 className="mb-3 flex min-w-0 items-center gap-2 text-[13.5px] font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">
        {onToggle ? (
          <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="-ml-1 inline-flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-[var(--polaris-hover)]">
            <ChevronDown size={14} aria-hidden="true" className={clsx('shrink-0 text-[var(--polaris-ink-4)] transition-transform', collapsed && '-rotate-90')} />{title}
          </button>
        ) : <>{icon}{title}</>}
        <span aria-hidden="true" className="ml-1 h-px flex-1 bg-[var(--polaris-line)]" />
      </h2>
      {collapsed ? null : children}
    </section>
  );
}

function Empty({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="polaris-card flex flex-col items-center px-6 py-16 text-center">
      <span className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-4)]"><Server size={20} strokeWidth={1.5} /></span>
      <p className="text-[14px] font-semibold text-[var(--polaris-ink)]">{title}</p>
      <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">{hint}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Machines picked for comparison, floating above the page until compared or cleared. / 已选对比的机器浮在页面底部，直到开始对比或清空。 */
export function CompareTray({ servers, selection, onRemove, onClear, onCompare }: { servers: PublicServer[]; selection: string[]; onRemove: (id: string) => void; onClear: () => void; onCompare: () => void }) {
  const t = useTranslations('presentation');
  const reduced = useReducedMotion();
  const picked = selection.map(id => servers.find(server => server.id === id)).filter((server): server is PublicServer => Boolean(server));
  return (
    <AnimatePresence>
      {picked.length ? (
        <motion.div role="region" aria-label={t('compareTray')} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }} transition={NAV_TRANSITION}
          className="server-compare-tray fixed inset-x-3 bottom-4 z-40 mx-auto flex max-w-2xl flex-wrap items-center gap-2 rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-3 py-2.5 shadow-[var(--polaris-shadow-float)] sm:inset-x-6">
          <span className="flex items-center gap-1.5 px-1 text-[12.5px] font-medium text-[var(--polaris-ink)]"><GitCompareArrows size={15} className="text-[var(--polaris-ink-3)]" aria-hidden="true" /><span className="polaris-num">{picked.length}/{COMPARE_LIMIT}</span></span>
          <span className="server-compare-picks flex min-w-0 flex-1 flex-wrap gap-1.5">
            {picked.map(server => (
              <span key={server.id} className="inline-flex h-7 max-w-[11rem] items-center gap-1 rounded-lg bg-[var(--polaris-active)] pr-1 pl-2 text-[12px] text-[var(--polaris-ink-2)]">
                <span className="truncate">{server.name}</span>
                <button type="button" aria-label={t('removeFromCompareNamed', { name: server.name })} onClick={() => onRemove(server.id)} className="inline-flex h-5 w-5 items-center justify-center rounded-md text-[var(--polaris-ink-4)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]"><X size={12} /></button>
              </span>
            ))}
          </span>
          <button type="button" onClick={onClear} className="h-8 rounded-lg px-2.5 text-[12.5px] text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">{t('clearSelection')}</button>
          <button type="button" onClick={onCompare} disabled={picked.length < 2} title={picked.length < 2 ? t('compareNeedTwo') : undefined}
            className="h-8 rounded-lg bg-[var(--polaris-ink)] px-3 text-[12.5px] font-medium text-[var(--polaris-canvas)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {t('compareCount', { n: picked.length })}
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
