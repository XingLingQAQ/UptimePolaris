/**
 * Number formatting shared by the console's new readouts.
 *
 * The agent page and its dialog each grew their own copies of these; new
 * surfaces import from here so a byte count reads the same wherever it appears.
 *
 * 控制台共用数字格式，确保 Agent 页面和详情等界面的字节数显示一致。
 */

/** Byte counts as an operator reads them, never as raw digits. / 将字节数格式化为易读单位。 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled.toFixed(scaled >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${formatBytes(value)}/s`;
}

/** Milliseconds, switching to seconds once a reading stops fitting in four digits. / 以毫秒显示；超过四位数时切换为秒。 */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/**
 * Availability with as many decimals as it needs to say something.
 *
 * 100 and 99.95 are different statements about a month, and rounding the
 * second to "100.0%" erases the outage it records - so two decimals below 100,
 * none at exactly 100.
 *
 * 可用率低于 100 时保留两位小数，避免将 99.95% 舍入为 100%；恰好 100 时不显示小数。
 */
export function formatAvailability(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 100) return '100%';
  return `${value.toFixed(2)}%`;
}

/** Compact counts for tiles: 1,284 -> 1.3K. / 指标卡的紧凑计数，例如 1,284 显示为 1.3K。 */
export function formatCompact(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** A duration in seconds as days/hours/minutes, two units at most. / 将秒数显示为天、小时和分钟，最多使用两个单位。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

/** Clock time in the reader's own zone, for chart axes and tooltips. / 读者所在时区的时间，用于图表坐标轴和提示框。 */
export function formatClock(epochSec: number, locale?: string): string {
  return new Date(epochSec * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** A short calendar date, for daily series. / 用于每日序列的简短日期。 */
export function formatDay(epochSec: number, locale?: string): string {
  return new Date(epochSec * 1000).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
