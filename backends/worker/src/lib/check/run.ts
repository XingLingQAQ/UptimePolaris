import type { AddonReading, DnsAddonReading, DnsOptions, Monitor, Status } from '../../types';
import { DOWN, parseOptions, PENDING, UP, WARN } from '../../types';
import type { ExternalRequestBudget } from '../http/request-budget';
import { checkDns, type DnsCheckResult } from './dns';
import { checkDomain } from './domain';
import { checkHttp } from './http';
import { checkSsl, sslProviderKey } from './ssl';
import { addonTarget } from './target';
import { checkTcp } from './tcp';
import type { CheckResult } from './types';

/** Run an active HTTP/TCP transport probe. Cron derives passive Push and Agent readings separately. / 执行主动 HTTP/TCP 传输探测；定时任务另行计算被动 Push 和 Agent 观测值。 */
export async function runCheck(m: Monitor, budget?: ExternalRequestBudget): Promise<CheckResult> {
  switch (m.type) {
    case 'http':
      return checkHttp(m, budget);
    case 'tcp':
      return checkTcp(m, budget);
    case 'udp':
    case 'icmp':
      return { status: PENDING, latencyMs: 0, statusCode: 0, message: 'Agent probe source required' };
    case 'push':
      return {
        status: DOWN,
        latencyMs: 0,
        statusCode: 0,
        message: 'push monitors are not actively checked',
      };
    case 'agent':
      return {
        status: DOWN,
        latencyMs: 0,
        statusCode: 0,
        message: 'agent monitors are not actively checked',
      };
    default:
      return { status: 0, latencyMs: 0, statusCode: 0, message: `unknown type: ${m.type}` };
  }
}

/** Shared API/check-loop test for literal IPs; hostname-only add-ons are unavailable for them. / API 和检查循环共用的字面 IP 判断；仅支持主机名的附加检查不适用。 */
export function isIpAddress(host: string): boolean {
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}\.?$/.test(host)) return true;
  return host.includes(':');
}

/** Run enabled hostname add-ons concurrently against the shared request budget; failures contribute WARN. / 在共享请求预算内并发运行已启用的主机名附加检查；失败产生 WARN。 */
export async function runAddons(
  m: Monitor,
  budget?: ExternalRequestBudget,
  previousSsl?: AddonReading,
): Promise<{ ssl?: AddonReading; domain?: AddonReading; dns?: DnsAddonReading }> {
  const wantSsl = Boolean(m.check_ssl);
  const wantDomain = Boolean(m.check_domain);
  const wantDns = Boolean(m.check_dns);
  if (!wantSsl && !wantDomain && !wantDns) return {};

  /** An invalid stored target produces a configuration warning for each enabled add-on. / 存储的目标无效时，每个已启用的附加检查都会产生配置警告。 */
  const target = addonTarget(m.type, m.target);
  if (!target) {
    const ts = Math.floor(Date.now() / 1000);
    const msg = `no hostname in target: ${m.target}`;
    const reading: AddonReading = { st: WARN, days: null, msg, ts };
    return {
      ...(wantSsl ? { ssl: reading } : {}),
      ...(wantDomain ? { domain: reading } : {}),
      // DNS keeps its WARN cap here too: a misconfigured target is not a
      // service outage, and a DOWN reading would incorrectly trigger the
      // alert path.
      // DNS 仍以 WARN 为上限：目标配置错误不等于服务故障，DOWN 会错误触发告警。
      ...(wantDns ? { dns: { st: WARN, msg, ts } } : {}),
    };
  }

  /** No hostname add-on readings for literal IP targets. / 字面 IP 目标没有主机名附加检查结果。 */
  if (isIpAddress(target.host)) return {};

  const now = Math.floor(Date.now() / 1000);
  const sslKey = `${sslProviderKey()}|${target.host.toLowerCase().replace(/\.$/, '')}|${Math.floor(now / 86400)}`;
  const reuseSsl = previousSsl?.checkKey === sslKey && Number.isInteger(previousSsl.ts) &&
    previousSsl.ts > 0 && previousSsl.ts <= now &&
    (previousSsl.days === null || Number.isFinite(previousSsl.days));
  let sslReading: Promise<AddonReading> | undefined;
  if (wantSsl) {
    if (reuseSsl) {
      sslReading = Promise.resolve({ ...previousSsl, st: previousSsl.revoked || previousSsl.days === null || previousSsl.days <= m.warn_days ? WARN : UP });
    } else {
      sslReading = checkSsl({ host: target.host, timeoutMs: m.timeout_ms, warnDays: m.warn_days, budget }).then(result => ({
        ...toAddonReading(result, Math.floor(Date.now() / 1000)), checkKey: sslKey,
      }));
    }
  }

  const [ssl, domain, dns] = await Promise.all([
    sslReading,
    wantDomain && target.domain
      ? checkDomain({
          domain: target.domain,
          timeoutMs: m.timeout_ms,
          warnDays: m.warn_days,
          budget,
        })
      : undefined,
    wantDns
      ? checkDns(
          target.host,
          readDnsOptions(m.options_json),
          m.timeout_ms,
          budget,
        )
      : undefined,
  ]);

  const ts = Math.floor(Date.now() / 1000);
  const out: { ssl?: AddonReading; domain?: AddonReading; dns?: DnsAddonReading } = {};
  if (ssl) out.ssl = ssl;
  if (wantDomain) {
    out.domain = target.domain
      ? toAddonReading(domain!, ts)
      : {
          st: WARN,
          days: null,
          msg: `no registrable domain in host: ${target.host}`,
          ts,
        };
  }
  if (wantDns && dns) out.dns = toDnsReading(dns, ts);
  return out;
}

/** DNS options are nested under options_json.dns to avoid collisions with transport fields. / DNS 选项位于 options_json.dns 下，避免与传输字段冲突。 */
function readDnsOptions(optionsJson: string): DnsOptions {
  const opts = parseOptions<DnsOptions & { dns?: DnsOptions }>(optionsJson);
  const dns = opts.dns;
  if (typeof dns !== 'object' || dns === null || Array.isArray(dns)) return {} as DnsOptions;
  return dns;
}

function toAddonReading(r: CheckResult, ts: number): AddonReading {
  return {
    st: r.status === UP ? UP : WARN,
    days: r.daysLeft === undefined ? null : Math.round(r.daysLeft * 100) / 100,
    msg: r.message.slice(0, 512),
    ts: r.observedAt ?? ts,
    ...(r.revoked ? { revoked: true } : {}),
  };
}

/** DNS failures contribute WARN; retain the resolver's structured result. / DNS 失败产生 WARN；保留解析器的结构化结果。 */
function toDnsReading(r: DnsCheckResult, ts: number): DnsAddonReading {
  return {
    st: r.status === DOWN ? WARN : (r.status as Status),
    msg: r.message.slice(0, 512),
    ts,
    hostname: r.hostname,
    recordType: r.recordType,
    rcode: r.rcode,
    latencyMs: r.latencyMs,
    records: r.records,
  };
}

/** Combine readings; precedence is DOWN, WARN, PENDING, UP. / 合并观测值；优先级依次为 DOWN、WARN、PENDING、UP。 */
export function worstStatus(...statuses: Status[]): Status {

  let worst: Status = UP;
  for (const s of statuses) {
    if (s === DOWN) return DOWN;
    if (s === WARN) worst = WARN;
    else if (s === PENDING && worst !== WARN) worst = PENDING;
  }
  return worst;
}
