import { CountryFlag } from '@/admin/components/CountryFlag';
import { useLocale } from '@/i18n/IntlProvider';
import clsx from 'clsx';
import { ChevronDown, Globe2, MapPin, X } from 'lucide-react';
import { useId, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import type { PublicServer } from '../../../../shared/public-servers';
import { countryName, landDots, project } from './geo';
import { attentionOf, NO_REGION, percentText, regionKey, resourcePercent, serverStates, stateOf } from './model';
import { Recency, StatusBadge } from './ServerParts';
import { COUNTRY_PATHS } from './world-countries';
import { WORLD } from './world-dots';

type MarkerTone = 'up' | 'warn' | 'down' | 'idle';
export interface MapMarker { key: string; lat: number; lon: number; count: number; tone: MarkerTone; label: string; active?: boolean; dimmed?: boolean; onSelect?: () => void }
interface RegionGroup { code: string; name: string; servers: PublicServer[]; online: number; offline: number; unknown: number; tone: MarkerTone }

const TONE_FILL: Record<MarkerTone, string> = { up: 'bg-success', warn: 'bg-warning', down: 'bg-danger', idle: 'bg-default-400' };
const MIN_GAP = 3.4;
const pathFor = (code: string) => COUNTRY_PATHS[code === 'UK' ? 'GB' : code];
type RegionTranslator = ReturnType<typeof useTranslations<'presentation'>>;

function regionDescription(group: RegionGroup, t: RegionTranslator) {
  return [group.name || t('unknownRegion'), t('machineCount', { n: group.servers.length }),
    ...serverStates.map(state => `${t(state)} ${group[state]}`)].join(' · ');
}

function RegionStates({ group }: { group: RegionGroup }) {
  const t = useTranslations('presentation');
  return <dl className="server-region-states">
    {serverStates.map(state => <div key={state} data-state={state}>
      <dt><i aria-hidden="true" />{t(state)}</dt><dd className="polaris-num">{group[state]}</dd>
    </div>)}
  </dl>;
}

function toneOf(servers: PublicServer[]): MarkerTone {
  if (servers.some(server => server.online === false)) return 'down';
  if (servers.some(server => attentionOf(server) === 'critical' || attentionOf(server) === 'warning')) return 'warn';
  return servers.some(server => server.online === true) ? 'up' : 'idle';
}

export function groupByRegion(servers: PublicServer[], locale: string): RegionGroup[] {
  const map = new Map<string, PublicServer[]>();
  for (const server of servers) {
    const code = regionKey(server);
    const rows = map.get(code) ?? [];
    rows.push(server);
    map.set(code, rows);
  }
  return [...map].map(([code, rows]) => ({
    code, name: code === NO_REGION ? '' : countryName(code, locale), servers: rows, tone: toneOf(rows),
    online: rows.filter(server => stateOf(server) === 'online').length, offline: rows.filter(server => stateOf(server) === 'offline').length, unknown: rows.filter(server => stateOf(server) === 'unknown').length,
  })).sort((a, b) => (a.code === NO_REGION ? 1 : 0) - (b.code === NO_REGION ? 1 : 0) || b.servers.length - a.servers.length || a.name.localeCompare(b.name, locale));
}

/**
 * A dotted world in the console's ink with a marker per country. Markers that land on top of each other are pushed
 * apart a little, so Hong Kong and Macau stay two targets.
 *
 * 使用控制台墨色绘制的点阵世界地图，每个国家/地区一个标记。重叠的标记会被稍微推开，使香港与澳门等仍可分别点击。
 */
export function WorldMap({ markers, className, compact = false }: { markers: MapMarker[]; className?: string; compact?: boolean }) {
  const dots = useMemo(() => landDots(), []);
  const placed = useMemo(() => {
    const points = markers.map(marker => ({ marker, ...project([marker.lat, marker.lon]) }));
    for (let round = 0; round < 24; round++) {
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        const dx = points[j].x - points[i].x, dy = points[j].y - points[i].y, distance = Math.hypot(dx, dy) || 0.01;
        if (distance >= MIN_GAP) continue;
        const push = (MIN_GAP - distance) / 2, ux = dx ? dx / distance : 1, uy = dy / distance;
        points[i].x -= ux * push; points[i].y -= uy * push; points[j].x += ux * push; points[j].y += uy * push;
      }
    }
    return points;
  }, [markers]);
  return (
    <div className={clsx('server-map relative w-full', className)} style={{ aspectRatio: `${WORLD.cols} / ${WORLD.rows}` }}>
      <svg viewBox={`0 0 ${WORLD.cols} ${WORLD.rows}`} className="absolute inset-0 h-full w-full" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        <path d={dots} className="server-map-land" fill="none" strokeWidth={compact ? 0.62 : 0.56} strokeLinecap="round" />
      </svg>
      {placed.map(({ marker, x, y }) => {
        const size = Math.min(30, (compact ? 12 : 14) + Math.sqrt(Math.max(0, marker.count - 1)) * 4.5);
        const style = { left: `${x / WORLD.cols * 100}%`, top: `${y / WORLD.rows * 100}%`, width: size, height: size } as CSSProperties;
        const body = <>
          {marker.tone === 'down' ? <span aria-hidden="true" className={clsx('server-map-ping absolute inset-0 rounded-full', TONE_FILL[marker.tone])} /> : null}
          <span aria-hidden="true" className={clsx('relative flex h-full w-full items-center justify-center rounded-full text-[10.5px] font-semibold text-white ring-2 ring-[var(--polaris-card)]', TONE_FILL[marker.tone])}>{marker.count > 1 ? marker.count : null}</span>
          <span className="server-map-tip pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-[var(--polaris-island)] px-2 py-1 text-[11.5px] whitespace-nowrap text-[var(--polaris-island-ink)] shadow-[var(--polaris-shadow-float)]">{marker.label}</span>
        </>;
        const common = clsx('server-map-marker absolute -translate-x-1/2 -translate-y-1/2 rounded-full', marker.active && 'is-active', marker.dimmed && 'is-dimmed');
        return marker.onSelect
          ? <button key={marker.key} type="button" aria-label={marker.label} aria-pressed={Boolean(marker.active)} onClick={marker.onSelect} className={common} style={style}>{body}</button>
          : <span key={marker.key} role="img" aria-label={marker.label} className={common} style={style}>{body}</span>;
      })}
    </div>
  );
}

function CountryMap({ groups, region, onRegion }: { groups: RegionGroup[]; region: string; onRegion: (code: string) => void }) {
  const t = useTranslations('presentation');
  const tooltipId = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const highlighted = groups.find(group => group.code === hovered);
  const mapped = groups.filter(group => pathFor(group.code));
  const toggle = (code: string) => onRegion(code === region ? '' : code);

  return <div className="server-country-map">
    <svg viewBox="0 0 1000 430" aria-label={t('regionDistribution')} role="group" className="server-country-svg" preserveAspectRatio="xMidYMid meet">
      <g aria-hidden="true" className="server-country-base">
        {Object.entries(COUNTRY_PATHS).map(([code, d]) => <path key={code} d={d} vectorEffect="non-scaling-stroke" />)}
      </g>
      {mapped.map(group => {
        const active = group.code === region;
        return <path key={group.code} d={pathFor(group.code)} data-country={group.code} data-tone={group.tone} vectorEffect="non-scaling-stroke" role="button" tabIndex={0} aria-label={regionDescription(group, t)} aria-pressed={active} aria-describedby={hovered === group.code ? tooltipId : undefined}
          className={clsx('server-country', active && 'is-active', region && !active && 'is-dimmed', hovered === group.code && 'is-hovered')}
          onPointerEnter={() => setHovered(group.code)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(group.code)} onBlur={() => setHovered(null)}
          onClick={() => toggle(group.code)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggle(group.code); }
          }} />;
      })}
    </svg>
    {highlighted ? <div id={tooltipId} className="server-country-tooltip" role="tooltip" data-region={highlighted.code}>
      <div className="server-country-tooltip-heading"><CountryFlag code={highlighted.code} size={16} /><strong>{highlighted.name}</strong><span className="polaris-num">{t('machineCount', { n: highlighted.servers.length })}</span></div>
      <RegionStates group={highlighted} />
    </div> : null}
  </div>;
}

export function MapOverview({ servers, region, onRegion, expanded = false, collapsible = false }: { servers: PublicServer[]; region: string; onRegion: (code: string) => void; expanded?: boolean; collapsible?: boolean }) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const groups = useMemo(() => groupByRegion(servers, locale), [servers, locale]);
  const regions = groups.filter(group => group.code !== NO_REGION).length;
  const chips = expanded ? groups.filter(group => !pathFor(group.code)) : groups;
  const legend: Array<[MarkerTone, string]> = [['up', t('online')], ['warn', t('highLoad')], ['down', t('offline')], ['idle', t('unknown')]];

  const heading = <div className="server-map-heading">
      <div>
        <h2><Globe2 size={15} aria-hidden="true" />{t('regionDistribution')}</h2>
        <p className="polaris-num">{t('regionSummary', { regions, n: servers.length })}</p>
      </div>
      {collapsible ? <ChevronDown size={16} className="server-map-disclosure-chevron" aria-hidden="true" /> : region ? <button type="button" className="server-map-reset" onClick={() => onRegion('')}><X size={12} aria-hidden="true" />{t('allRegions')}</button> : null}
    </div>;
  const content = <>
    {collapsible && region ? <button type="button" className="server-map-reset" onClick={() => onRegion('')}><X size={12} aria-hidden="true" />{t('allRegions')}</button> : null}
    <CountryMap groups={groups} region={region} onRegion={onRegion} />
    {!servers.length || !regions ? <p className="server-map-empty">{t(!servers.length ? 'noMatches' : 'noRegions')}</p> : null}
    <div className="server-map-legend" aria-label={t('statusFilter')}>
      {legend.map(([tone, label]) => <span key={tone}><i aria-hidden="true" className={TONE_FILL[tone]} />{label}</span>)}
    </div>
    {chips.length ? <div className="server-region-chips polaris-scrollbar" aria-label={t('allRegions')}>
      {chips.map(group => <button key={group.code} type="button" aria-pressed={region === group.code} data-tone={group.tone}
        title={regionDescription(group, t)}
        className={clsx('server-region-chip', region === group.code && 'is-active')} onClick={() => onRegion(region === group.code ? '' : group.code)}>
        {group.code === NO_REGION ? <MapPin size={14} aria-hidden="true" /> : <CountryFlag code={group.code} size={14} />}
        <span className="truncate">{group.name || t('unknownRegion')}</span><span className="polaris-num">{group.servers.length}</span><i aria-hidden="true" />
      </button>)}
    </div> : null}
  </>;
  return collapsible ? <details className="server-map-disclosure polaris-card">
    <summary>{heading}</summary><div className="server-map-disclosure-body">{content}</div>
  </details> : <section className={clsx('server-overview-map polaris-card', expanded && 'server-explore-map')} aria-label={t('regionDistribution')}>{heading}{content}</section>;
}

export function MapView({ servers, region, onRegion, href, now }: { servers: PublicServer[]; region: string; onRegion: (code: string) => void; href: (id: string) => string; now: number }) {
  const t = useTranslations('presentation');
  const { locale } = useLocale();
  const groups = useMemo(() => groupByRegion(servers, locale), [servers, locale]);
  const selected = groups.find(group => group.code === region);
  const label = (group: RegionGroup) => group.name || t('unknownRegion');

  return <div className="server-region-browser">
    <MapOverview servers={servers} region={region} onRegion={onRegion} expanded />
    <aside className="server-map-sidebar polaris-card min-w-0 overflow-hidden" aria-label={selected ? label(selected) : t('allRegions')}>
      <div className="server-region-heading">
        <h2>{selected ? label(selected) : t('allRegions')}</h2>
        {selected ? <button type="button" className="server-map-reset" onClick={() => onRegion('')}><X size={12} aria-hidden="true" />{t('allRegions')}</button> : <span className="polaris-num">{groups.length}</span>}
      </div>
      {selected ? <>
        <RegionStates group={selected} />
        <ul className="polaris-scrollbar server-region-machines">
          {selected.servers.map(server => <li key={server.id} data-server-id={server.id}>
            <Link to={href(server.id)} className="server-link server-region-machine">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--polaris-ink)]">{server.name}</span>
                <span className="block truncate text-[12px] text-[var(--polaris-ink-3)]">{[server.region, server.os].filter(Boolean).join(' · ') || server.group?.name || t('ungrouped')}</span>
              </span>
              <StatusBadge server={server} />
              <span className="server-region-machine-readings">
                {server.cpu !== undefined ? <span className="polaris-num text-[12px] text-[var(--polaris-ink-2)]"><span className="text-[11px] text-[var(--polaris-ink-3)]">CPU </span>{percentText(resourcePercent(server, 'cpu'))}</span> : null}
                <Recency server={server} now={now} className="server-region-recency text-right text-[11px]" />
              </span>
            </Link>
          </li>)}
        </ul>
      </> : <ul className="polaris-scrollbar server-region-list">
        {groups.map(group => <li key={group.code}>
          <button type="button" aria-pressed={region === group.code} onClick={() => onRegion(group.code === region ? '' : group.code)} className={clsx('server-region-row', region === group.code && 'is-active')}>
            {group.code === NO_REGION ? <MapPin size={16} aria-hidden="true" /> : <CountryFlag code={group.code} size={16} />}
            <span className="min-w-0 flex-1 truncate">{label(group)}</span>
            <span className="server-region-bar" aria-hidden="true">
              {group.online ? <i className="bg-success" style={{ flex: group.online }} /> : null}
              {group.offline ? <i className="bg-danger" style={{ flex: group.offline }} /> : null}
              {group.unknown ? <i className="bg-default-300" style={{ flex: group.unknown }} /> : null}
            </span>
            <span className="server-region-row-count polaris-num"><strong>{group.servers.length}</strong><span>{serverStates.filter(state => group[state]).map(state => `${t(state)} ${group[state]}`).join(' · ')}</span></span>
          </button>
        </li>)}
      </ul>}
    </aside>
  </div>;
}
