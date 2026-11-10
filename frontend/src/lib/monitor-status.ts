import type { Heartbeat, HeartbeatData, MonitorGroup } from '@/types/monitor';

/**
 * The states a monitor can be in.
 *
 * `warn` is separate from `pending` because they mean different things: warn
 * is "still serving, but an add-on is complaining" (certificate expiring, DNS
 * record changed, latency over the configured bound), while pending is "the
 * primary check failed and a retry is in flight". Collapsing them made a
 * certificate expiring soon read as "retrying".
 *
 * `warn` 表示服务仍可用但附加项有警告，例如证书即将到期、DNS 记录变化或延迟超限；
 * `pending` 表示主检查失败后正在重试。若合并，证书即将到期会被误显示为“正在重试”。
 */
export type MonitorStatusKey = 'up' | 'down' | 'warn' | 'pending' | 'unknown';

export interface MonitorStatusCounts {
  total: number;
  up: number;
  down: number;
  /** Add-on warnings: certificate expiring, DNS changed, latency bound passed. / 附加项警告：证书即将到期、DNS 变化或延迟超限。 */
  warn: number;
  pending: number;
  unknown: number;
  abnormal: number;
}

export type SystemStatus = 'normal' | 'warning' | 'error' | 'unknown';

export function selectSystemStatus(counts: MonitorStatusCounts): SystemStatus {
  if (counts.total === 0 || counts.unknown === counts.total) return 'unknown';
  if (counts.unknown > 0) return 'warning';
  if (counts.down === counts.total) return 'error';
  if (counts.down > 0 || counts.pending > 0 || (counts.warn ?? 0) > 0) return 'warning';
  return 'normal';
}

export const getLatestHeartbeat = (heartbeats: Heartbeat[] | undefined) =>
  heartbeats && heartbeats.length > 0 ? heartbeats[heartbeats.length - 1] : undefined;

export const getMonitorStatusKey = (
  status?: Heartbeat['status'],
  sourceAvailable = true,
): MonitorStatusKey => {
  if (!sourceAvailable) return 'unknown';
  if (status === 0) return 'down';
  if (status === 1) return 'up';
  if (status === 2) return 'warn';
  if (status === 4) return 'pending';
  return 'unknown';
};

export const isAbnormalMonitorStatus = (status: MonitorStatusKey) => status !== 'up';

export const calculateMonitorStatusCounts = (
  monitorGroups: MonitorGroup[],
  heartbeatList: HeartbeatData
): MonitorStatusCounts => {
  // 同一监控可以出现在多个分组中，总览只计一次。 / A monitor can appear in multiple groups but counts only once in the overview.
  const monitorIds = new Set<number>();

  const availability = new Map<number, boolean>();
  monitorGroups.forEach(group => {
    group.monitorList.forEach(monitor => {
      monitorIds.add(monitor.id);
      availability.set(monitor.id, monitor.sourceAvailable !== false);
    });
  });

  const counts: MonitorStatusCounts = {
    total: monitorIds.size,
    up: 0,
    down: 0,
    warn: 0,
    pending: 0,
    unknown: 0,
    abnormal: 0,
  };

  monitorIds.forEach(monitorId => {
    const latest = getLatestHeartbeat(heartbeatList[monitorId]);
    const currentStatus = getMonitorStatusKey(latest?.status, availability.get(monitorId));
    counts[currentStatus] += 1;

    if (isAbnormalMonitorStatus(currentStatus)) {
      counts.abnormal += 1;
    }
  });

  return counts;
};
