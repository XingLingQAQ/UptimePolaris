import { readBoundedBody } from '../../http/binary';
import type { ExternalRequestBudget } from '../../http/request-budget';
import { identities, newestCertificate, normalizeCertificate, type CtCertificate } from './records';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 1024;
const MAX_PAGES = 4;

export interface CtRequest {
  host: string;
  signal: AbortSignal;
  budget?: ExternalRequestBudget;
}

export interface CtSource {
  name: string;
  query(request: CtRequest): Promise<CtCertificate | null>;
}

export class CtSourceError extends Error {}

async function json(url: URL, request: CtRequest, body?: Record<string, unknown>): Promise<unknown> {
  if (request.signal.aborted) throw new CtSourceError('timed out');
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CtSourceError('timed out'));
    request.signal.addEventListener('abort', onAbort, { once: true });
  });
  const operation = async () => {
    request.budget?.reserve();
    // Workers 不支持 redirect:error；3xx 由故障转移处理。 / Workers rejects redirect:error; failover handles 3xx.
    const response = await fetch(url, {
      signal: request.signal, redirect: 'manual',
      headers: { accept: 'application/json', 'user-agent': 'Uptime-Polaris', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CtSourceError(`HTTP ${response.status}`);
    }
    try { return JSON.parse(new TextDecoder().decode(await readBoundedBody(response.body, MAX_RESPONSE_BYTES))); }
    catch { throw new CtSourceError('unreadable or oversized response'); }
  };
  try { return await Promise.race([operation(), aborted]); }
  finally { request.signal.removeEventListener('abort', onAbort); }
}

function rows(value: unknown, limit: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > limit || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new CtSourceError('invalid response');
  return value as Record<string, unknown>[];
}

// 匿名接口要求串行请求；排队期间超时的任务不会再发请求。 / Anonymous access requires serial requests; expired queued work never sends a request.
let ctlogsQueue: Promise<void> = Promise.resolve();
function ctlogsJson(url: URL, request: CtRequest): Promise<unknown> {
  const result = ctlogsQueue.then(() => json(url, request));
  ctlogsQueue = result.then(() => {}, () => {});
  return result;
}

async function ctlogs(request: CtRequest): Promise<CtCertificate | null> {
  const certificates: CtCertificate[] = [];
  for (const identity of identities(request.host)) {
    let after = '';
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://api.ctlogs.dev/v1/domain/' + encodeURIComponent(identity));
      if (after) url.searchParams.set('after', after);
      const response = await ctlogsJson(url, request);
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new CtSourceError('invalid response');
      const value = response as Record<string, unknown>;
      if (typeof value.has_next !== 'boolean' || typeof value.next_cursor !== 'string' || value.archive_partial || value.truncated) throw new CtSourceError('incomplete response');
      const records = rows(value.rows, 100);
      for (const record of records) {
        const certificate = normalizeCertificate({ id: record.id, names: [record.match], issuer: record.issuer,
          notBefore: record.not_before, notAfter: record.not_after }, request.host, Date.now());
        if (certificate) certificates.push(certificate);
      }
      if (!value.has_next) break;
      const cursor = value.next_cursor;
      if (!records.length || !cursor || cursor.length > 2048 || seen.has(cursor) || page === MAX_PAGES - 1) throw new CtSourceError('pagination limit reached');
      seen.add(cursor);
      after = cursor;
    }
  }
  return newestCertificate(certificates);
}

async function certkit(request: CtRequest): Promise<CtCertificate | null> {
  const certificates: CtCertificate[] = [];
  for (const identity of identities(request.host)) {
    const response = await json(new URL('https://ct.certkit.io/search'), request, { domain: identity, limit: 100, sort: 'NotBeforeDesc' });
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new CtSourceError('invalid response');
    const value = response as Record<string, unknown>;
    const records = rows(value.results, 100);
    if (!Number.isSafeInteger(value.totalCount) || Number(value.totalCount) < records.length) throw new CtSourceError('invalid response');
    for (const record of records) {
      const certificate = normalizeCertificate({ id: record.serialNumber, names: record.dnsNames,
        issuer: record.issuerOrganization ?? record.issuerCommonName, notBefore: record.notBefore, notAfter: record.notAfter }, request.host, Date.now());
      if (certificate) certificates.push(certificate);
    }
  }
  return newestCertificate(certificates);
}

async function certspotter(request: CtRequest): Promise<CtCertificate | null> {
  const certificates: CtCertificate[] = [];
  let after = '';
  let count = 0;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://api.certspotter.com/v1/issuances');
    url.searchParams.set('domain', request.host);
    url.searchParams.set('include_subdomains', 'false');
    url.searchParams.set('match_wildcards', 'true');
    url.searchParams.append('expand', 'dns_names');
    url.searchParams.append('expand', 'issuer');
    if (after) url.searchParams.set('after', after);
    const records = rows(await json(url, request), MAX_RECORDS);
    if (!records.length) return newestCertificate(certificates);
    count += records.length;
    if (count > MAX_RECORDS) throw new CtSourceError('record limit reached');
    for (const record of records) {
      if (record.revoked !== undefined && record.revoked !== null && typeof record.revoked !== 'boolean') throw new CtSourceError('invalid revocation status');
      const issuer = record.issuer && typeof record.issuer === 'object' ? record.issuer as Record<string, unknown> : {};
      const certificate = normalizeCertificate({ id: record.id, names: record.dns_names, issuer: issuer.name ?? issuer.friendly_name,
        notBefore: record.not_before, notAfter: record.not_after, revoked: record.revoked }, request.host, Date.now());
      if (certificate) certificates.push(certificate);
    }
    const cursor = records.at(-1)?.id;
    if (typeof cursor !== 'string' || !cursor || cursor.length > 128 || seen.has(cursor)) throw new CtSourceError('invalid pagination');
    seen.add(cursor);
    after = cursor;
  }
  throw new CtSourceError('pagination limit reached');
}

async function crtsh(request: CtRequest): Promise<CtCertificate | null> {
  const pages = await Promise.all(identities(request.host).map(async identity => {
    const url = new URL('https://crt.sh/');
    const parameters = { q: identity, output: 'json', match: '=', group: 'none', deduplicate: 'Y', sort: '2', dir: '^', p: '1', n: '256' };
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    return rows(await json(url, request), 256);
  }));
  const certificates: CtCertificate[] = [];
  for (const record of pages.flat()) {
    if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0 || typeof record.name_value !== 'string' || record.name_value.length > 65536) continue;
    const certificate = normalizeCertificate({ id: record.id, names: record.name_value.split('\n'), issuer: record.issuer_name,
      notBefore: record.not_before, notAfter: record.not_after }, request.host, Date.now());
    if (certificate) certificates.push(certificate);
  }
  return newestCertificate(certificates);
}

const sources: readonly CtSource[] = [
  { name: 'ctlogs.dev', query: ctlogs },
  { name: 'CertKit', query: certkit },
  { name: 'CertSpotter', query: certspotter },
  { name: 'crt.sh', query: crtsh },
];

export function ctSources(): readonly CtSource[] { return sources; }
export function providerKey(): string { return 'ssl:anonymous'; }
