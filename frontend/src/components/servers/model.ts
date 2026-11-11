import type { PublicServer, PublicServerHistory } from '../../../../shared/public-servers';
import { loadTone as numericLoadTone, percentOf } from '@/lib/resource-metrics';
import type { Tone } from '@/types/tone';
import { publishesSeries } from './history-model';
import { countryCode, regionLabel } from './geo';

export type ServerState = 'online' | 'offline' | 'unknown';
export type ServerView = 'cards' | 'list' | 'map';
export type ServerSort = 'default' | 'name' | 'cpu' | 'memory' | 'disk' | 'load' | 'network' | 'uptime';
export type ResourceKind = 'cpu' | 'memory' | 'disk';
export type ServerPageConfig = {
  presentation: import('../context/PresentationViewContext').PresentationView;
  siteMeta: { title: string; description: string; icon: string };
  config: { footerText: string };
};
export type FleetResponse = { servers: PublicServer[]; now: number };
export type DetailResponse = { server: PublicServer; history: PublicServerHistory[]; now: number };

export const serverStates: ServerState[] = ['online', 'offline', 'unknown'];
export const serverSorts: ServerSort[] = ['default', 'name', 'cpu', 'memory', 'disk', 'load', 'network', 'uptime'];
export const resourceKinds: ResourceKind[] = ['cpu', 'memory', 'disk'];
export const COMPARE_LIMIT = 4;

export const known = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const stateOf = (server: PublicServer): ServerState => server.online === true ? 'online' : server.online === false ? 'offline' : 'unknown';
export const percentage = (used: number | null | undefined, total: number | null | undefined): number | null => known(used) && known(total) ? percentOf(used, total) : null;
export const percentText = (value: number | null | undefined) => known(value) ? `${value.toFixed(1)}%` : '—';

/** Whether the page publishes a metric at all; `undefined` means hidden, `null` means published but unknown. / 是否公开某项指标：undefined 表示未公开，null 表示已公开但暂无读数。 */
export const publishes = (server: PublicServer, kind: ResourceKind) => (kind === 'cpu' ? server.cpu : kind === 'memory' ? server.memoryUsed : server.diskUsed) !== undefined;

export function resourcePercent(server: PublicServer, kind: ResourceKind): number | null {
  if (kind === 'cpu') return known(server.cpu) ? server.cpu : null;
  return kind === 'memory' ? percentage(server.memoryUsed, server.memoryTotal) : percentage(server.diskUsed, server.diskTotal);
}

export const loadTone = (value: number | null | undefined) => numericLoadTone(known(value) ? value : null);

export function stateTone(server: PublicServer): Tone {
  return server.online === true ? 'up' : server.online === false ? 'down' : 'idle';
}

/** Why a machine needs a look: it stopped reporting, or a resource crossed the critical line. / 机器需要关注的原因：停止上报，或某项资源超过严重阈值。 */
export function attentionOf(server: PublicServer): 'offline' | 'critical' | 'warning' | null {
  if (server.online === false) return 'offline';
  if (server.online !== true) return null;
  const peak = Math.max(...resourceKinds.map(kind => resourcePercent(server, kind) ?? -1));
  return peak >= 90 ? 'critical' : peak >= 75 ? 'warning' : null;
}

export function serverFilters(params: URLSearchParams) {
  const status = params.get('status') ?? 'all';
  const sort = params.get('sort') ?? 'default';
  return { query: params.get('q') ?? '', status: serverStates.includes(status as ServerState) ? status : 'all', group: params.get('group') ?? '', tag: params.get('tag') ?? '', region: (params.get('region') ?? '').toUpperCase(), sort: serverSorts.includes(sort as ServerSort) ? sort : 'default' };
}
export type ServerFilters = ReturnType<typeof serverFilters>;

/** Region filter value for machines that publish no recognisable country. / 未公开可识别国家/地区的机器所用的筛选值。 */
export const NO_REGION = '-';
export const regionKey = (server: PublicServer) => countryCode(server.region) ?? NO_REGION;

export function sortValue(server: PublicServer, sort: string): number | null {
  switch (sort) {
    case 'cpu': return resourcePercent(server, 'cpu');
    case 'memory': return resourcePercent(server, 'memory');
    case 'disk': return resourcePercent(server, 'disk');
    case 'load': return known(server.load) ? server.load : null;
    case 'network': return known(server.upload) && known(server.download) ? server.upload + server.download : null;
    case 'uptime': return known(server.uptime) ? server.uptime : null;
    default: return null;
  }
}

export function selectServers(servers: PublicServer[], filters: Omit<ServerFilters, 'region'> & { region?: string }, locale: string) {
  const query = filters.query.trim().toLocaleLowerCase(locale);
  const selected = servers.filter(server =>
    (!query || [server.name, server.os, server.arch, server.region, regionLabel(server.region, locale), server.group?.name, ...server.tags.map(tag => tag.name)].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(query)) &&
    (filters.status === 'all' || stateOf(server) === filters.status) &&
    (!filters.group || server.group?.id === filters.group) &&
    (!filters.tag || server.tags.some(tag => tag.id === filters.tag)) &&
    (!filters.region || regionKey(server) === filters.region),
  );
  if (filters.sort === 'default') return selected;
  const compareNames = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
  return selected.sort((a, b) => {
    if (filters.sort !== 'name') {
      const left = sortValue(a, filters.sort), right = sortValue(b, filters.sort);
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      if (left !== null && right !== null && left !== right) return right - left;
    }
    return compareNames(a.name, b.name) || a.id.localeCompare(b.id);
  });
}

const sum = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) : null;
const mean = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;

/**
 * Fleet figures from online machines only: an offline machine's last reading is history, not current load.
 * Traffic totals are cumulative counters, so they add up across every machine that publishes them.
 *
 * 机群数值只统计在线机器，离线机器的最后读数不代表当前负载；累计流量是计数器，按所有公开机器求和。
 */
export function fleetSummary(servers: PublicServer[]) {
  const online = servers.filter(server => server.online === true);
  const cpus = online.map(server => server.cpu).filter(known);
  const memories = online.map(server => resourcePercent(server, 'memory')).filter(known);
  const field = (list: PublicServer[], key: 'upload' | 'download' | 'sent' | 'received') => {
    const values = list.map(server => server[key]);
    return values.length && values.every(known) ? sum(values) : null;
  };
  const hottest = online.reduce<{ server: PublicServer; value: number } | null>((best, server) => {
    const value = Math.max(...resourceKinds.map(kind => resourcePercent(server, kind) ?? -1));
    return value >= 0 && (!best || value > best.value) ? { server, value } : best;
  }, null);
  return {
    total: servers.length,
    online: online.length,
    offline: servers.filter(server => server.online === false).length,
    unknown: servers.filter(server => server.online === null).length,
    cpu: mean(cpus), cpuSamples: cpus.length,
    memory: mean(memories), memorySamples: memories.length,
    upload: field(online, 'upload'), download: field(online, 'download'),
    sent: field(servers, 'sent'), received: field(servers, 'received'),
    attention: servers.filter(server => attentionOf(server) === 'offline' || attentionOf(server) === 'critical').length,
    hottest,
  };
}

/** The compare list from the URL: known ids only, no repeats, at most four. / 从 URL 读取对比列表：仅保留存在的机器，去重，最多 4 台。 */
export function compareIds(value: string | null, servers?: PublicServer[]) {
  const ids = [...new Set((value ?? '').split(',').map(id => id.trim()).filter(Boolean))];
  return (servers ? ids.filter(id => servers.some(server => server.id === id)) : ids).slice(0, COMPARE_LIMIT);
}

export function relativeAge(seconds: number, t: (key: string, values?: Record<string, number>) => string) {
  if (seconds < 60) return t('justNow');
  if (seconds < 3600) return t('minutesAgo', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('hoursAgo', { n: Math.floor(seconds / 3600) });
  return t('daysAgo', { n: Math.floor(seconds / 86400) });
}

export function accentInk(hex: string) {
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? '#18181b' : '#ffffff';
}

/** History rows as CSV, published columns only. / 将历史数据导出为 CSV，只包含已公开的列。 */
export function historyCsv(server: PublicServer, history: PublicServerHistory[]) {
  const columns = (['cpu', 'memory', 'upload', 'download'] as const).filter(key => publishesSeries(server, key));
  const rows = history.map(point => [new Date(point.ts * 1000).toISOString(), ...columns.map(key => known(point[key]) ? String(point[key]) : '')].join(','));
  return [['time', ...columns.map(key => key === 'cpu' || key === 'memory' ? `${key}_percent` : `${key}_bytes_per_second`)].join(','), ...rows].join('\n');
}
