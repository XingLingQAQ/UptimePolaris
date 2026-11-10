import { DEFAULT_DOH_RESOLVER, DOWN, UP, type DnsOptions } from '../../types';
import { budgetedFetch, type ExternalRequestBudget } from '../http/request-budget';
import { errMsg } from '../util';
import type { CheckResult } from './types';

/** Retain resolver RCODE names in failure messages. / 在失败消息中保留解析器的 RCODE 名称。 */
const RCODES: Record<number, string> = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
};

/** One `Answer` entry as the JSON API returns it. / JSON API 返回的一条 `Answer` 记录。 */
interface DohAnswer {
  name?: string;
  type?: number;
  TTL?: number;
  data?: string;
}

interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

/** Match domain-name records without case folding TXT data (RFC 4343). / 匹配域名记录时不折叠 TXT 数据的大小写（RFC 4343）。 */
const CASE_INSENSITIVE = new Set(['MX', 'CNAME', 'NS']);

export interface DnsCheckResult extends CheckResult {
  hostname: string;
  recordType: string;
  rcode?: string;
  records: string[];
}

/** Query a resolver's application/dns-json API; callers map failed DNS checks to add-on WARN. / 查询解析器的 application/dns-json API；调用方将 DNS 检查失败映射为附加检查 WARN。 */
export async function checkDns(
  hostname: string,
  opts: DnsOptions,
  timeoutMs: number,
  budget?: ExternalRequestBudget,
): Promise<DnsCheckResult> {
  const start = Date.now();
  const recordType = opts.recordType ?? 'A';
  const resolver = opts.resolver?.trim() || DEFAULT_DOH_RESOLVER;
  let rcode: string | undefined;
  let records: string[] = [];
  const result = (reading: CheckResult): DnsCheckResult => ({
    ...reading, hostname, recordType, records, ...(rcode ? { rcode } : {}),
  });

  try {
    const url =
      `${resolver}${resolver.includes('?') ? '&' : '?'}` +
      `name=${encodeURIComponent(hostname)}&type=${encodeURIComponent(recordType)}`;

    const res = await budgetedFetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(timeoutMs),
    }, budget);
    const latencyMs = Date.now() - start;

    /** HTTP errors describe the resolver request, not a DNS RCODE. / HTTP 错误描述解析器请求，而不是 DNS RCODE。 */
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return result({
        status: DOWN,
        latencyMs,
        statusCode: res.status,
        message: `DoH HTTP ${res.status}`,
      });
    }

    let dns: DohResponse;
    try {
      dns = (await res.json()) as DohResponse;
    } catch {

      return result({
        status: DOWN,
        latencyMs,
        statusCode: res.status,
        message: 'DoH response is not JSON',
      });
    }

    const answers = Array.isArray(dns.Answer)
      ? dns.Answer.filter((answer) => answer && typeof answer.data === 'string' && answer.data.length > 0)
      : [];
    const status = dns.Status;

    if (typeof status !== 'number') {
      return result({
        status: DOWN,
        latencyMs,
        statusCode: res.status,
        message: 'DoH response has no Status',
      });
    }

    rcode = RCODES[status] ?? `RCODE ${status}`;
    records = [...new Set(answers.map((answer) => answer.data!))]
      .slice(0, 10).map((value) => value.slice(0, 2048));

    if (status !== 0) {
      return result({
        status: DOWN,
        latencyMs,
        statusCode: res.status,

        message: `DNS ${recordType} ${hostname}: ${rcode}`,
      });
    }

    /** NOERROR alone does not prove the requested record exists. / 单凭 NOERROR 不能证明请求的记录存在。 */
    if (answers.length === 0) {
      return result({
        status: DOWN,
        latencyMs,
        statusCode: res.status,
        message: `NOERROR but no ${recordType} record for ${hostname}`,
      });
    }

    const expected = opts.expected ?? '';
    if (expected) {
      const fold = CASE_INSENSITIVE.has(recordType);
      const needle = fold ? expected.toLowerCase() : expected;
      const hit = answers.some((a) => {
        const data = a.data ?? '';
        return (fold ? data.toLowerCase() : data).includes(needle);
      });

      if (!hit) {
        const seen = answers
          .map((a) => a.data ?? '')
          .filter(Boolean)
          .slice(0, 3)
          .join(', ');
        return result({
          status: DOWN,
          latencyMs,
          statusCode: res.status,

          message: `expected "${expected}" not in ${recordType}: "${seen.slice(0, 200)}"`,
        });
      }
    }

    return result({ status: UP, latencyMs, statusCode: res.status, message: '' });
  } catch (e) {
    return result({ status: DOWN, latencyMs: Date.now() - start, statusCode: 0, message: errMsg(e) });
  }
}
