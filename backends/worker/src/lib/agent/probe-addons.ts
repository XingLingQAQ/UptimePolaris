import { UP, WARN, parseOptions, type AddonReading, type DnsAddonReading, type Monitor } from '../../types';
import { addonTarget } from '../check/target';
import { parseHostPort } from '../check/tcp';

export interface ProbeAddonRequest {
  ssl?: { host: string; port: number; warn_days: number };
  domain?: { domain: string; warn_days: number };
  dns?: { hostname: string; record_type: string; resolver: string; expected: string };
}

export interface ProbeAddonResults { ssl?: AddonReading; domain?: AddonReading; dns?: DnsAddonReading }

function sslKey(agentId: string, host: string, port: number, ts: number): string {
  return `ssl:agent|${agentId}|${host.toLowerCase().replace(/\.$/, '')}|${port}|${Math.floor(ts / 86400)}`;
}

function sslTarget(monitor: Monitor): { host: string; port: number; warn_days: number } | undefined {
  const target = addonTarget(monitor.type, monitor.target);
  if (!target) return undefined;
  const port = monitor.type === 'tcp' ? parseHostPort(monitor.target).port : Number(new URL(monitor.target).port || 443);
  return { host: target.host, port, warn_days: monitor.warn_days };
}

export function reuseAgentSsl(monitor: Monitor, agentId: string, previous: AddonReading | undefined, now: number): AddonReading | undefined {
  const target = monitor.check_ssl ? sslTarget(monitor) : undefined;
  if (!target || !previous || previous.checkKey !== sslKey(agentId, target.host, target.port, now) ||
      !Number.isInteger(previous.ts) || previous.ts <= 0 || previous.ts > now || previous.days !== null && !Number.isFinite(previous.days)) return undefined;
  return { ...previous, st: previous.days === null || previous.tls_valid === false || previous.revoked || previous.days <= monitor.warn_days ? WARN : UP };
}

export function probeAddonRequest(monitor: Monitor, agentId: string, previous: AddonReading | undefined, now: number): ProbeAddonRequest {
  const target = addonTarget(monitor.type, monitor.target);
  if (!target) return {};
  const options = parseOptions<{ dns?: { recordType?: string; resolver?: string; expected?: string } }>(monitor.options_json);
  return {
    ...(monitor.check_ssl && !reuseAgentSsl(monitor, agentId, previous, now) ? { ssl: sslTarget(monitor) } : {}),
    ...(monitor.check_domain ? { domain: { domain: target.domain, warn_days: monitor.warn_days } } : {}),
    ...(monitor.check_dns ? { dns: { hostname: target.host, record_type: options.dns?.recordType ?? 'A',
      resolver: options.dns?.resolver || 'https://cloudflare-dns.com/dns-query', expected: options.dns?.expected ?? '' } } : {}),
  };
}

/** Validate only the add-ons issued in this lease. / 仅接收本次租约实际请求的附加检查。 */
export function parseProbeAddons(value: unknown, requested: ProbeAddonRequest, agentId: string, scheduledAt: number, now: number): ProbeAddonResults | null {
  const data = value === undefined ? {} : value;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const values = data as Record<string, unknown>;
  if (Object.keys(values).some(key => !['ssl', 'domain', 'dns'].includes(key) || !requested[key as keyof ProbeAddonRequest])) return null;
  const results: ProbeAddonResults = {};
  for (const key of ['ssl', 'domain', 'dns'] as const) {
    if (!requested[key]) continue;
    const candidate = values[key];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if ((record.status !== UP && record.status !== WARN) || typeof record.message !== 'string' || record.message.length > 512 ||
      !Number.isInteger(record.observed_at) || Number(record.observed_at) < scheduledAt - 30 || Number(record.observed_at) > now + 15) return null;
    const ts = Number(record.observed_at);
    if (key === 'dns') {
      if (record.records !== undefined && (!Array.isArray(record.records) || record.records.length > 64 || record.records.some(item => typeof item !== 'string' || item.length > 2048))) return null;
      if (record.rcode !== undefined && (typeof record.rcode !== 'string' || record.rcode.length > 32)) return null;
      results.dns = { st: record.status, msg: record.message, ts, hostname: requested.dns!.hostname,
        recordType: requested.dns!.record_type, records: record.records as string[] | undefined, rcode: record.rcode as string | undefined };
    } else {
      if (record.days_left !== null && (typeof record.days_left !== 'number' || !Number.isFinite(record.days_left) || Math.abs(record.days_left) > 365000)) return null;
      const days = record.days_left === null ? null : Math.round(Number(record.days_left) * 100) / 100;
      const reading: AddonReading = { st: days === null ? WARN : record.status, days, msg: record.message, ts };
      if (key === 'ssl') {
        if (typeof record.tls_valid !== 'boolean') return null;
        reading.tls_valid = record.tls_valid;
        reading.checkKey = sslKey(agentId, requested.ssl!.host, requested.ssl!.port, ts);
        if (!record.tls_valid || days === null || days <= requested.ssl!.warn_days) reading.st = WARN;
        results.ssl = reading;
      } else {
        if (days === null || days <= requested.domain!.warn_days) reading.st = WARN;
        results.domain = reading;
      }
    }
  }
  return results;
}
