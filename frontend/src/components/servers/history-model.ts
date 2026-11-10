import { useTheme } from 'next-themes';
import type { PublicServer, PublicServerHistory } from '../../../../shared/public-servers';

export const RANGES = [1, 6, 24] as const;
export type HistoryField = 'cpu' | 'memory' | 'upload' | 'download';

export function publishesSeries(server: PublicServer, key: HistoryField): boolean {
  return (key === 'cpu' ? server.cpu : key === 'memory' ? server.memoryUsed : server[key]) !== undefined;
}

export function historyWindow(history: PublicServerHistory[], now: number, hours: number): PublicServerHistory[] {
  return history.filter(point => Number.isFinite(point.ts) && point.ts >= now - hours * 3600 && point.ts <= now);
}

export function useSeriesColors(accent: string) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  return { accent, green: dark ? '#34d399' : '#059669', compare: dark ? [accent, '#2dd4bf', '#c084fc', '#f472b6'] : [accent, '#0d9488', '#9333ea', '#db2777'] };
}
