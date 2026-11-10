/**
 * Format latency value with appropriate unit / 使用合适单位格式化延迟
 * @param ms latency in milliseconds / 延迟毫秒数
 * @returns formatted string with unit / 带单位的格式化文本
 */
export function formatLatency(ms: number): string {
  if (!ms && ms !== 0) return '-';

  if (ms < 1000) {
    return `${ms.toFixed(0)} ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)} s`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format latency value for chart axis display / 为图表坐标轴格式化延迟
 * @param ms latency in milliseconds / 延迟毫秒数
 * @returns formatted string with unit, more compact than formatLatency / 带单位的格式化文本，比 formatLatency 更紧凑
 */
export function formatLatencyForAxis(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m${seconds}s`;
}

/**
 * Get color based on latency value for UI display / 根据延迟获取界面颜色
 * @param ms latency in milliseconds / 延迟毫秒数
 * @returns color key for HeroUI components: / HeroUI 组件使用的颜色键：
 * - "success" for < 200ms / 小于 200ms 使用 success
 * - "warning" for 200ms to < 1000ms / 200ms 至小于 1000ms 使用 warning
 * - "danger" for >= 1000ms or invalid values / 大于等于 1000ms 或无效值使用 danger
 */
export function getLatencyColor(ms: number): 'success' | 'warning' | 'danger' {
  if (!ms && ms !== 0) return 'danger';
  if (ms < 200) return 'success';
  if (ms < 1000) return 'warning';
  return 'danger';
}

/**
 * Convert date string to timestamp with timezone support / 支持时区的日期字符串转时间戳
 * @param dateString Date string in ISO format or 'YYYY-MM-DD HH:MM:SS' / ISO 格式或指定格式的日期字符串
 * @param tz Timezone offset in format '+HH:MM' or 'UTC' / 时区偏移或 UTC
 * @returns timestamp in milliseconds / 毫秒时间戳
 */
export function dateStringToTimestamp(dateString: string, tz = '+0000'): number {
  if (!dateString) return 0;

  try {
    const dateStr = dateString.trim().replace(' +0000', '');
    const timezone = tz.replace(':', '').replace('UTC', '+0000');

    let timestamp = new Date(`${dateStr} ${timezone}`).getTime();

    if (!Number.isFinite(timestamp)) {
      timestamp = new Date(dateStr).getTime();

      if (Number.isFinite(timestamp) && timezone !== '+0000') {
        const tzOffsetMs =
          Number.parseInt(timezone.slice(1, 3)) * 3600000 +
          Number.parseInt(timezone.slice(3, 5)) * 60000;
        timestamp += timezone.startsWith('-') ? tzOffsetMs : -tzOffsetMs;
      }
    }

    return Number.isFinite(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
}

/**
 * Convert timezone offset strings (e.g. "+08:00" or "-0530") into milliseconds. / 将时区偏移字符串转换为毫秒。
 * @param offset timezone offset string or undefined/"UTC" / 时区偏移字符串、undefined 或 UTC
 * @returns offset duration in milliseconds, positive east of UTC / 偏移毫秒数；UTC 以东为正
 */
export function timezoneOffsetToMs(offset?: string): number {
  if (!offset || offset === 'UTC') {
    return 0;
  }

  const normalized = offset.replace(':', '');
  if (!/^[+-]\d{4}$/.test(normalized)) {
    return 0;
  }

  const sign = normalized.startsWith('-') ? -1 : 1;
  const hours = Number.parseInt(normalized.slice(1, 3), 10);
  const minutes = Number.parseInt(normalized.slice(3, 5), 10);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  const totalMinutes = hours * 60 + minutes;
  return sign * totalMinutes * 60 * 1000;
}
