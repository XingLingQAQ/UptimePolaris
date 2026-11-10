import { useCallback, useEffect, useState } from 'react';
import type { PublicServer } from '../../../../shared/public-servers';
import { fleetSummary, known, resourcePercent } from './model';

function read<T>(storage: () => Storage | undefined, key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const raw = storage()?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
const local = () => typeof window === 'undefined' ? undefined : window.localStorage;
const session = () => typeof window === 'undefined' ? undefined : window.sessionStorage;

const PINS = 'polaris-servers-pins';
const INTERVAL = 'polaris-servers-refresh';
export const refreshIntervals = [15_000, 30_000, 60_000, 0] as const;
const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const isInterval = (value: unknown): value is number => refreshIntervals.includes(value as never);

/** Pins live in this browser only; a visitor's favourites are nobody else's. / 收藏只保存在当前浏览器。 */
export function usePins() {
  const [pins, setPins] = useState<string[]>(() => read(local, PINS, [], isIds));
  useEffect(() => { try { local()?.setItem(PINS, JSON.stringify(pins)); } catch { /* storage full or blocked / 存储已满或被禁用 */ } }, [pins]);
  const toggle = useCallback((id: string) => setPins(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]), []);
  return { pins, toggle };
}

export function useRefreshInterval() {
  const [interval, setIntervalValue] = useState<number>(() => read(local, INTERVAL, 30_000, isInterval));
  useEffect(() => { try { local()?.setItem(INTERVAL, JSON.stringify(interval)); } catch { /* ignored / 忽略 */ } }, [interval]);
  return [interval, setIntervalValue] as const;
}

export interface LiveSample { t: number; cpu: number | null; memory: number | null; upload: number | null; download: number | null }
export type LiveSeries = Record<string, LiveSample[]>;
export const FLEET_SERIES = '__fleet-complete';
const SAMPLES = 'polaris-servers-live';
const KEEP = 60;
const WINDOW = 3600;
const isSeries = (value: unknown): value is LiveSeries => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Readings gathered while the page is open. The public list carries only the latest reading,
 * so each refresh appends one sample per machine; a machine that has not reported since adds nothing.
 * Kept per tab for an hour, so a reload does not start the lines from empty.
 *
 * 页面打开期间累积的读数。公开列表只有最新读数，每次刷新为每台机器追加一个采样；
 * 未产生新上报的机器不追加。按标签页保存一小时，刷新页面后走势不会清空。
 */
export function useLiveSamples(servers: PublicServer[] | undefined, updatedAt: number | null) {
  const [series, setSeries] = useState<LiveSeries>(() => read(session, SAMPLES, {}, isSeries));
  useEffect(() => {
    if (!servers || !updatedAt) return;
    const now = Math.floor(updatedAt / 1000);
    setSeries(previous => {
      const next: LiveSeries = {};
      const keep = (list: LiveSample[] | undefined) => (list ?? []).filter(sample => now - sample.t <= WINDOW).slice(-KEEP);
      for (const server of servers) {
        const list = keep(previous[server.id]);
        const t = known(server.reportedAt) && server.reportedAt > 0 ? server.reportedAt : null;
        if (t !== null && server.online === true && list.at(-1)?.t !== t) {
          list.push({ t, cpu: known(server.cpu) ? server.cpu : null, memory: resourcePercent(server, 'memory'), upload: known(server.upload) ? server.upload : null, download: known(server.download) ? server.download : null });
        }
        next[server.id] = list.slice(-KEEP);
      }
      const fleet = keep(previous[FLEET_SERIES]);
      if (fleet.at(-1)?.t !== now) {
        const summary = fleetSummary(servers);
        fleet.push({ t: now, cpu: summary.cpu, memory: summary.memory, upload: summary.upload, download: summary.download });
      }
      next[FLEET_SERIES] = fleet.slice(-KEEP);
      try { session()?.setItem(SAMPLES, JSON.stringify(next)); } catch { /* ignored / 忽略 */ }
      return next;
    });
  }, [servers, updatedAt]);
  return series;
}
