import type { MonitorType } from './types';
import { hasNonCanonicalHttpIPv4, isMonitorHostname } from '../../../../shared/monitor-hostname';

/** 提交前检查 Agent 告警选项的字段和数值范围。 / Validate Agent alert fields and numeric ranges before submission. */
export function validateAgentOptions(json: string): boolean {
  let options: unknown;
  try { options = JSON.parse(json); } catch { return false; }
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const root = options as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== 'alerts')) return false;
  if (root.alerts === undefined) return true;
  if (!root.alerts || typeof root.alerts !== 'object' || Array.isArray(root.alerts)) return false;
  const alerts = root.alerts as Record<string, unknown>;
  if (Object.keys(alerts).some((key) => !['cpu', 'memory', 'disk', 'load'].includes(key))) return false;
  return Object.entries(alerts).every(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const rule = value as Record<string, unknown>;
    const threshold = rule.threshold;
    return Object.keys(rule).every((field) => ['enabled', 'threshold', 'duration_sec', 'recovery_pct'].includes(field)) &&
      typeof rule.enabled === 'boolean' && typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0 && threshold <= (key === 'load' ? 10000 : 100) &&
      typeof rule.duration_sec === 'number' && Number.isInteger(rule.duration_sec) && rule.duration_sec >= 1 && rule.duration_sec <= 86400 &&
      typeof rule.recovery_pct === 'number' && Number.isFinite(rule.recovery_pct) && rule.recovery_pct > 0 && rule.recovery_pct < 100;
  });
}

/** Validation codes are translated by the form. / 校验代码由表单翻译。 */
export type TargetError =
  | 'required'
  | 'no_hostname'
  | 'bad_url'
  | 'need_host_port'
  | 'bad_port'
  | 'need_hostname';

/** Validate hostname labels or an IPv6 literal. / 校验主机名标签或 IPv6 字面量。 */
export function isPlausibleHostname(host: string): boolean {
  return isMonitorHostname(host);
}

/** Detect literal IP targets so the form can disable hostname-only add-ons. / 检测 IP 字面量目标，以便表单禁用仅支持主机名的附加项。 */
export function isIpAddress(host: string): boolean {
  if (!host) return false;
  if (host.includes(':')) return isMonitorHostname(host);
  host = host.replace(/\.$/, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.split('.').every((o) => Number(o) <= 255);
}

/** Immediate form feedback; the backend also validates submissions. / 表单即时反馈；后端仍会校验提交。 */
export function validateTarget(type: MonitorType, target: string): TargetError | null {
  const t = target.trim();

  /** Passive monitors have no target. / 被动监控项没有目标。 */
  if (type === 'push' || type === 'agent') return null;

  if (!t) return 'required';
  if (type === 'icmp' || type === 'dns') return isPlausibleHostname(t.replace(/^\[|\]$/g, '')) ? null : 'no_hostname';

  if (type === 'websocket') {
    try {
      const url = new URL(t);
      return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.hash && isPlausibleHostname(url.hostname.replace(/^\[|\]$/g, '')) ? null : 'bad_url';
    } catch { return 'bad_url'; }
  }

  if (type === 'http') {
    const candidate = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    if (hasNonCanonicalHttpIPv4(candidate)) return 'bad_url';
    let host: string;
    try {
      host = new URL(candidate).hostname;
    } catch {
      return 'bad_url';
    }
    // Apply the form's hostname rules after URL parsing. / 解析 URL 后应用表单的主机名规则。
    if (!host) return 'no_hostname';
    if (!isPlausibleHostname(host.replace(/^\[|\]$/g, ''))) return 'bad_url';
    return null;
  }

  const s = t.replace(new RegExp(`^${type}://`, 'i'), '');
  const v6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  const m = v6 ?? s.match(/^(.+):(\d+)$/);
  if (!m) return 'need_host_port';
  if (!isPlausibleHostname(m[1])) return 'need_host_port';
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'bad_port';
  return null;
}

/** Host used by add-ons, or null for passive monitors and invalid targets. / 附加项使用的主机名；被动监控或无效目标返回 null。 */
export function hostOfTarget(type: MonitorType, target: string): string | null {
  if (type === 'push' || type === 'agent') return null;

  const t = target.trim();
  if (!t) return null;

  let host: string | null = null;

  if (type === 'http' || type === 'websocket') {
    try {
      const candidate = type === 'http' && !/^https?:\/\//i.test(t) ? `https://${t}` : t;
      if (type === 'http' && hasNonCanonicalHttpIPv4(candidate)) return null;
      if (type === 'websocket' && validateTarget(type, t)) return null;
      host = new URL(candidate).hostname || null;
    } catch {
      return null;
    }
    if (host) host = host.replace(/^\[|\]$/g, '');
  } else {
    const s = t.replace(new RegExp(`^${type}://`, 'i'), '');
    const v6 = s.match(/^\[([^\]]+)\]:\d+$/);
    if (v6) host = v6[1];
    else {
      const m = s.match(/^(.+):\d+$/);
      host = m ? m[1] : null;
    }
  }

  return host && isPlausibleHostname(host) ? host : null;
}
