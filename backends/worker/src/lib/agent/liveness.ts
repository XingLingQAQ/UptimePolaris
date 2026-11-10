export const AGENT_STALE_SEC = 180;

/** 在线判定使用三个上报周期，并限制在 30 至 3600 秒。 / Liveness uses three report intervals, bounded to 30–3600 seconds. */
export function agentStaleAfterSec(reportInterval: number | string | null | undefined): number {
  const numeric = reportInterval == null ? NaN : Number(reportInterval);
  const interval = Number.isFinite(numeric) && numeric > 0 ? numeric : 60;
  return Math.min(3600, Math.max(30, interval * 3));
}

/** 尚无有效上报时间时返回 null，供调用方区分未知与离线。 / Return null without a valid report time so callers can distinguish unknown from offline. */
export function agentIsOnline(reportedAt: number | string | null | undefined, now: number, staleAfterSec: number): boolean | null {
  if (reportedAt == null) return null;
  const timestamp = Number(reportedAt);
  return Number.isFinite(timestamp) ? now - timestamp <= staleAfterSec : null;
}
