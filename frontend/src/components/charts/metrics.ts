import type { Heartbeat } from '@/types/monitor';
export interface LatencyStats {
  min: number;
  p25: number;
  p50: number;
  p75: number;
  max: number;
}

export interface LatencyMetrics {
  latestPing: number | null;
  avgPing: number;
  trimmedAvgPing: number;
}

export const calculateLatencyStats = (heartbeats: Heartbeat[]): LatencyStats | null => {
  const onlinePings = heartbeats
    .filter(hb => (hb.status === 1 || hb.status === 2) && typeof hb.ping === 'number' && Number.isFinite(hb.ping))
    .map(hb => hb.ping as number);

  if (onlinePings.length === 0) return null;

  const sorted = [...onlinePings].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
    max: sorted[sorted.length - 1],
  };
};

export const calculateLatencyMetrics = (heartbeats: Heartbeat[]): LatencyMetrics | null => {
  const onlinePings = heartbeats
    .filter(hb => (hb.status === 1 || hb.status === 2) && typeof hb.ping === 'number' && Number.isFinite(hb.ping))
    .map(hb => hb.ping as number);

  if (onlinePings.length === 0) return null;

  // 最新延迟 / Latest latency
  const latest = heartbeats[heartbeats.length - 1];
  const latestPing = latest && (latest.status === 1 || latest.status === 2) &&
    typeof latest.ping === 'number' && Number.isFinite(latest.ping) ? latest.ping : null;

  // 平均延迟 / Average latency
  const avgPing = Math.round(onlinePings.reduce((acc, curr) => acc + curr, 0) / onlinePings.length);

  // 去除峰值后的平均延迟（去除最高和最低的 10%） / Average latency excluding the highest and lowest 10%
  const sorted = [...onlinePings].sort((a, b) => a - b);
  const trimStart = Math.floor(sorted.length * 0.1);
  const trimEnd = Math.ceil(sorted.length * 0.9);
  const trimmedPings = sorted.slice(trimStart, trimEnd);
  const trimmedAvgPing = Math.round(
    trimmedPings.reduce((acc, curr) => acc + curr, 0) / trimmedPings.length
  );

  return {
    latestPing,
    avgPing,
    trimmedAvgPing,
  };
};
