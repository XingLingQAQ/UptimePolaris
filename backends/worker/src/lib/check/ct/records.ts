import { isMonitorHostname } from '../../../../../../shared/monitor-hostname';
import { isPrivateHost } from '../../http/private-host';

export interface CtCertificate {
  id: string;
  issuer: string;
  notBefore: number;
  notAfter: number;
  revoked: boolean;
}

export function dnsName(value: string): string | null {
  if (!value || /[\s/:@?#%\\]/.test(value)) return null;
  try {
    const host = new URL(`https://${value}/`).hostname.toLowerCase().replace(/\.$/, '');
    return host.includes('.') && isMonitorHostname(host) && !isPrivateHost(host) && !/^[\d.]+$/.test(host) ? host : null;
  } catch { return null; }
}

export function matchesIdentity(identity: string, host: string): boolean {
  const value = identity.trim();
  if (!value.startsWith('*.')) return dnsName(value) === host;
  const suffix = dnsName(value.slice(2));
  return suffix !== null && host.slice(host.indexOf('.') + 1) === suffix;
}

export function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return NaN;
  const day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return NaN;
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : value + 'Z');
}

export function normalizeCertificate(record: {
  id: unknown; names: unknown; issuer: unknown; notBefore: unknown; notAfter: unknown; revoked?: unknown;
}, host: string, now: number): CtCertificate | null {
  const id = typeof record.id === 'string' ? record.id : Number.isSafeInteger(record.id) && Number(record.id) > 0 ? String(record.id) : '';
  if (!id || id.length > 128 || /[\x00-\x20\x7f]/.test(id) || !Array.isArray(record.names) || record.names.length > 256 ||
    !record.names.some(name => typeof name === 'string' && name.length <= 253 && matchesIdentity(name, host))) return null;
  const notBefore = timestamp(record.notBefore);
  const notAfter = timestamp(record.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore || notBefore > now) return null;
  return {
    id, notBefore, notAfter, revoked: record.revoked === true,
    issuer: typeof record.issuer === 'string' ? record.issuer.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160) : '',
  };
}

export function newestCertificate(records: CtCertificate[]): CtCertificate | null {
  return records.reduce<CtCertificate | null>((selected, candidate) => {
    if (!selected || candidate.notBefore > selected.notBefore || candidate.notBefore === selected.notBefore && (
      candidate.notAfter < selected.notAfter || candidate.notAfter === selected.notAfter && (
        candidate.revoked && !selected.revoked || candidate.revoked === selected.revoked && candidate.id > selected.id
      ))) return candidate;
    return selected;
  }, null);
}

export function identities(host: string): string[] {
  return host.split('.').length > 2 ? [host, '*.' + host.slice(host.indexOf('.') + 1)] : [host];
}
