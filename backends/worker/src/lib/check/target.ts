import type { MonitorType } from '../../types';
import { isMonitorHostname } from '../../../../../shared/monitor-hostname';
import { registrableDomain } from './domain';
import { parseHostPort } from './tcp';

/** Only HTTP/TCP targets support hostname add-ons. / 只有 HTTP/TCP 目标支持主机名附加检查。 */
export function supportsAddons(type: MonitorType): boolean {
  return type === 'http' || type === 'tcp';
}

/** Clear add-on flags for passive monitor types. / 清除被动监控类型的附加检查标记。 */
export function addonFlag(type: MonitorType, value: unknown): number {
  return supportsAddons(type) && value ? 1 : 0;
}

/** Accept hostname labels or literal IPs; URL parsing alone does not enforce these target rules. / 接受主机名标签或字面 IP；仅解析 URL 无法保证符合这些目标规则。 */
export function isHostname(host: string): boolean {
  return isMonitorHostname(host);
}

/** An IP literal has no registrable domain, so RDAP has nothing to look up. / 字面 IP 没有可注册域名，因此 RDAP 无需查询。 */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}\.?$/.test(host) || host.includes(':');
}

/** Return a domain candidate, or an empty string for literal IPs and single-label names. / 返回候选域名；字面 IP 和单标签名称返回空字符串。 */
function rdapDomain(host: string): string {
  if (isIpLiteral(host)) return '';
  const d = registrableDomain(host);
  return d.includes('.') ? d : '';
}

/** Add-on target derived from the primary monitor target. / 从监控主目标派生的附加检查目标。 */
export interface AddonTarget {
  /** Hostname or IP literal; IPv6 is unbracketed. / 主机名或字面 IP；IPv6 不带方括号。 */
  host: string;
  /** Registrable domain for RDAP, or '' when the host has none (an IP, say). / RDAP 查询的可注册域名；主机没有域名（如 IP）时为 ''。 */
  domain: string;
}

/** Resolve the add-on target for HTTP/TCP; passive or invalid targets yield null. / 解析 HTTP/TCP 的附加检查目标；被动或无效目标返回 null。 */
export function addonTarget(type: MonitorType, target: string): AddonTarget | null {
  if (type === 'tcp') {
    try {
      const { host } = parseHostPort(target);
      if (!isHostname(host)) return null;
      return { host, domain: rdapDomain(host) };
    } catch {
      return null;
    }
  }

  if (type === 'http') {
    try {
      const url = new URL(target);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!isHostname(host)) return null;

      return { host, domain: rdapDomain(host) };
    } catch {
      return null;
    }
  }

  return null;
}
