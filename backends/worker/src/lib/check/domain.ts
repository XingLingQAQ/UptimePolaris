import { UP, WARN } from '../../types';
import { budgetedFetch, ExternalBudgetExceeded, type ExternalRequestBudget } from '../http/request-budget';
import { daysUntil, errMsg, hostOf } from '../util';
import type { CheckResult } from './types';

/** RDAP discovery from IANA's bootstrap file, cached per isolate. / 从 IANA bootstrap 文件发现 RDAP，按 isolate 缓存。 */
const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';

/** Fallback for when the bootstrap fetch fails. / 获取引导文件失败时的回退表。 */
const FALLBACK_RDAP: Record<string, string> = {
  com: 'https://rdap.verisign.com/com/v1/',
  net: 'https://rdap.verisign.com/net/v1/',
  org: 'https://rdap.publicinterestregistry.org/rdap/',
  io: 'https://rdap.identitydigital.services/rdap/',
  dev: 'https://rdap.nic.google/',
  app: 'https://rdap.nic.google/',
};

interface BootstrapService {
  0: string[];
  1: string[];
}

let bootstrapCache: { at: number; map: Map<string, string> } | null = null;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

async function loadBootstrap(timeoutMs: number, budget?: ExternalRequestBudget): Promise<Map<string, string>> {
  const now = Date.now();
  if (bootstrapCache && now - bootstrapCache.at < BOOTSTRAP_TTL_MS) {
    return bootstrapCache.map;
  }

  const res = await budgetedFetch(IANA_BOOTSTRAP, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  }, budget);
  if (!res.ok) throw new Error(`IANA bootstrap HTTP ${res.status}`);

  const json = (await res.json()) as { services: BootstrapService[] };
  const map = new Map<string, string>();

  for (const svc of json.services ?? []) {
    const tlds = svc[0] ?? [];
    // Prefer an https endpoint; the first entry is not guaranteed to be one.
    // 优先选择 HTTPS 端点；第一个条目不一定是 HTTPS。
    const urls = svc[1] ?? [];
    const base = urls.find((u) => u.startsWith('https://')) ?? urls[0];
    if (!base) continue;
    for (const tld of tlds) map.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
  }

  bootstrapCache = { at: now, map };
  return map;
}

/** Resolve the RDAP base URL for a domain's TLD. / 解析域名顶级域对应的 RDAP 基地址。 */
async function rdapBaseFor(domain: string, timeoutMs: number, budget?: ExternalRequestBudget): Promise<string> {
  const tld = domain.split('.').pop()?.toLowerCase() ?? '';

  try {
    const map = await loadBootstrap(timeoutMs, budget);
    const found = map.get(tld);
    if (found) return found;
  } catch {
    if (budget?.remaining === 0) throw new ExternalBudgetExceeded();
    // Bootstrap unreachable; fall through to the static table.
    // 无法获取引导文件时回退到静态表。
  }

  const fallback = FALLBACK_RDAP[tld];
  if (fallback) return fallback;

  throw new Error(`no RDAP server known for .${tld}`);
}

/** SLDs where the registrable name is three labels, e.g. example.co.uk. / 可注册名称为三个标签的二级域，例如 example.co.uk。 */
const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.tw', 'com.hk', 'com.au',
  'com.br', 'co.kr', 'com.sg', 'co.in', 'com.mx', 'co.nz', 'com.tr',
]);

/** Reduce a hostname to the domain you can actually look up in RDAP. / 将主机名缩减为可通过 RDAP 查询的域名。 */
export function registrableDomain(input: string): string {
  const host = hostOf(input).replace(/\.$/, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(last2) && parts.length >= 3) return parts.slice(-3).join('.');
  return last2;
}

export interface RdapEvent {
  eventAction: string;
  eventDate: string;
}

export interface DomainCheckOptions {
  /** Registrable domain to look up, already reduced by `registrableDomain`. / 要查询的可注册域名，已由 `registrableDomain` 缩减。 */
  domain: string;
  timeoutMs: number;
  /** Days-remaining threshold below which the reading is WARN. / 剩余天数低于此阈值时结果为 WARN。 */
  warnDays: number;
  budget?: ExternalRequestBudget;
}

/** Registration lookup over RDAP JSON; takes the registrable domain, not a Monitor. / 通过 RDAP JSON 查询注册信息；接收可注册域名。 */
export async function checkDomain(o: DomainCheckOptions): Promise<CheckResult> {
  const start = Date.now();
  const domain = o.domain;
  try {
    const base = await rdapBaseFor(domain, o.timeoutMs, o.budget);
    const res = await budgetedFetch(base + 'domain/' + encodeURIComponent(domain), {
      signal: AbortSignal.timeout(o.timeoutMs),
      headers: { accept: 'application/rdap+json, application/json' },
    }, o.budget);

    if (res.status === 404) {
      return { status: WARN, latencyMs: Date.now() - start, statusCode: 404, message: `RDAP: ${domain} not found` };
    }
    if (!res.ok) {
      return { status: WARN, latencyMs: Date.now() - start, statusCode: res.status, message: `RDAP HTTP ${res.status}` };
    }

    const data = (await res.json()) as { events?: RdapEvent[]; ldhName?: string; status?: string[] };
    const expiry = (data.events ?? []).find((e) => e.eventAction === 'expiration');

    if (!expiry) {
      return { status: WARN, latencyMs: Date.now() - start, statusCode: res.status, message: 'no expiration event in RDAP' };
    }

    const days = daysUntil(expiry.eventDate);
    const latencyMs = Date.now() - start;
    const status = days <= o.warnDays ? WARN : UP;

    return {
      status,
      latencyMs,
      statusCode: res.status,
      // Check-layer detail stays English; the UI localizes from `daysLeft`. / 检查层详情用英语；界面根据 `daysLeft` 本地化。
      message: `${data.ldhName ?? domain} · expires ${expiry.eventDate.slice(0, 10)} · ${Math.round(days)} days left`,
      daysLeft: days,
    };
  } catch (e) {
    return { status: WARN, latencyMs: Date.now() - start, statusCode: 0, message: errMsg(e) };
  }
}
