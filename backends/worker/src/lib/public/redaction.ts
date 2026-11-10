import type { MonitorType } from '../../types';
import { isMonitorHostname } from '../../../../../shared/monitor-hostname';

/**
 * Redact a monitor target for public output.
 *
 * A URL can carry credentials in userinfo or query, and a non-http row can
 * still hold a leftover URL when the type changed. `host:port` is retried as
 * an authority; unparseable values become `'Invalid URL'`, never echoed.
 * URL 的 userinfo/查询串可能含凭据；`host:port` 按 authority 解析，无法解析时不回显。
 */
export function publicTarget(target: string, type: MonitorType): string {
  if (type === 'icmp') return isMonitorHostname(target) ? target : 'Invalid URL';
  if (type === 'http') {
    try {
      const url = new URL(target);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Invalid URL';
      return `${originOf(url)}${url.pathname}`;
    } catch {
      return 'Invalid URL';
    }
  }

  // `''` is the stored form of a push/agent monitor - the correct value, not a
  // missing one - so it must not become a placeholder.
  // `''` 是 Push/Agent 监控正确的存储值，而不是缺失值，不能替换为占位符。
  if (target.trim() === '') return '';

  // A leftover URL on a non-http row is reduced the same way, so userinfo and query cannot leak. / 非 http 行上的遗留 URL 同样处理，避免泄露用户信息和查询串。
  try {
    const url = new URL(target);
    if (url.host) return `${originOf(url)}${url.pathname}`;
  } catch {
    // Not an absolute URL; fall through to the authority form below.
    // 不是绝对 URL，继续尝试下方的 authority 格式。
  }

  try {
    // A base is required: `new URL('//host:port')` on its own throws.
    // 必须提供基地址：单独调用 `new URL('//host:port')` 会抛错。
    const url = new URL(`//${target}`, 'http://placeholder');
    if (!url.host) return 'Invalid URL';
    // `host:port` parses with the implicit root path, which is not part of the
    // stored target and must not be invented in the output.
    // `host:port` 解析时会隐含根路径；它不属于存储目标，不能添加到输出中。
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return 'Invalid URL';
  }
}

/** `origin`, unless the scheme has no host-based origin (`foo:` -> `null`). / 返回 `origin`；不具有主机源的 scheme 除外（`foo:` -> `null`）。 */
function originOf(url: URL): string {
  return url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
}

/** 公开通用状态消息，避免把探测错误中的目标或凭据原样暴露。 / Publish generic status messages without exposing targets or credentials from probe errors. */
export function publicMessage(type: MonitorType, status: number | undefined, message: string): string {
  if (!message) return '';
  if (status === 0) {
    if (type === 'http') return 'HTTP check failed';
    if (type === 'tcp') return 'TCP check failed';
    if (type === 'udp') return 'UDP check failed';
    if (type === 'icmp') return 'ICMP check failed';
    if (type === 'push') return 'Push check failed';
    if (type === 'agent') return 'Agent unavailable';
  }
  if (status === 2) return 'Monitor warning';
  if (status === 4) return 'Check pending';
  return '';
}

/** 按允许列表选择 Agent 指标，新增数据库字段不会自动公开。 / Select Agent metrics by allowlist so new database fields are not exposed automatically. */
export function publicAgentLive(live: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    'os', 'arch', 'kernel', 'cpu_model', 'cpu_cores', 'version', 'virtualization', 'transport',
    'report_interval_secs', 'cpu_usage', 'mem_used', 'mem_total', 'swap_used', 'swap_total',
    'load_1', 'load_5', 'load_15', 'disk_used', 'disk_total', 'net_up_rate', 'net_down_rate',
    'net_up_total', 'net_down_total', 'connections_tcp', 'connections_udp', 'process_count',
    'uptime', 'interfaces_json', 'mounts_json', 'reported_at', 'updated_at',
  ];
  return Object.fromEntries(fields.filter((field) => field in live).map((field) => [field, live[field]]));
}
