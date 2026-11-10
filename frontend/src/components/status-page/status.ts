import { getLatestHeartbeat, getMonitorStatusKey, type MonitorStatusKey } from '@/lib/monitor-status';
import type { Heartbeat, Monitor } from '@/types/monitor';


export type PublicStatus = MonitorStatusKey;

export const STATUS_DOT: Record<PublicStatus, string> = {
  up: 'bg-success',
  down: 'bg-danger',
  warn: 'bg-warning',
  pending: 'bg-warning',
  unknown: 'bg-default-300',
};

/** Rail segments: healthy a step lighter, so one red check in forty is what the eye finds. / 状态条的正常段颜色更淡，便于发现故障段。 */
export const STATUS_RAIL: Record<PublicStatus, string> = {
  up: 'bg-[var(--polaris-rail-up)]',
  down: 'bg-danger',
  warn: 'bg-warning',
  pending: 'bg-warning',
  unknown: 'bg-[var(--polaris-rail-empty)]',
};

export const STATUS_INK: Record<PublicStatus, string> = {
  up: 'text-[var(--polaris-ink-2)]',
  down: 'text-danger-600',
  warn: 'text-warning-700',
  pending: 'text-warning-700',
  unknown: 'text-[var(--polaris-ink-3)]',
};

/** Shared status labels distinguish WARN, retrying PENDING and unknown observations. / 共用状态标签区分警告、重试中的待定和未知观测。 */
export const STATUS_KEY: Record<PublicStatus, string> = {
  up: 'node.online',
  down: 'node.offline',
  warn: 'common.status.warn',
  pending: 'node.pending',
  unknown: 'common.status.unknown',
};

export function monitorStatus(monitor: Monitor, heartbeats: Heartbeat[] | undefined): PublicStatus {
  const latest = getLatestHeartbeat(heartbeats);
  return getMonitorStatusKey(latest?.status, monitor.sourceAvailable !== false);
}

/** The status a single heartbeat stands for. / 单次心跳代表的状态。 */
export function beatStatus(beat: Heartbeat): PublicStatus {
  return getMonitorStatusKey(beat.status);
}

/** Latest reading as display text: latency for probes, CPU for agent monitors. / 最新读数的显示文本：探测显示延迟，Agent 监控项显示 CPU。 */
export function readingText(monitor: Monitor, heartbeats: Heartbeat[] | undefined): string | null {
  if (monitor.type === 'push') return null;
  const last = getLatestHeartbeat(heartbeats);
  if (!last || last.ping === null || !Number.isFinite(last.ping)) return null;
  if (monitor.type === 'agent') return `CPU ${Math.round(last.ping)}%`;
  return `${Math.round(last.ping)}ms`;
}

/** 24-hour availability, 0-1 in the payload, as a percentage string. / 将响应中 0–1 的 24 小时可用率转换为百分比文本。 */
export function uptimeText(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const pct = ratio * 100;
  return pct >= 100 ? '100%' : `${pct.toFixed(2)}%`;
}

export function uptimeInk(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'text-[var(--polaris-ink-4)]';
  const pct = ratio * 100;
  return pct < 95 ? 'text-danger-600' : pct < 99 ? 'text-warning-700' : 'text-[var(--polaris-ink)]';
}
