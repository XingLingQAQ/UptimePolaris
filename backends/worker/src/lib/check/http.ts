import {
  DOWN,
  parseOptions,
  UP,
  WARN,
  type HttpOptions,
  type Monitor,
} from '../../types';
import { budgetedFetch, ExternalBudgetExceeded, type ExternalRequestBudget } from '../http/request-budget';
import { BODY_CAP_BYTES, errMsg, isTimeoutAbort, readCapped } from '../util';
import type { CheckResult } from './types';

/** Parse a status spec like "200-299" or "200,301,302". / 解析状态码规格，如 "200-299" 或 "200,301,302"。 */
export function parseExpected(spec: string): (code: number) => boolean {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  return (code) => {
    for (const p of parts) {
      const m = p.match(/^(\d{3})\s*-\s*(\d{3})$/);
      if (m) {
        if (code >= Number(m[1]) && code <= Number(m[2])) return true;
        continue;
      }
      if (Number(p) === code) return true;
    }
    return false;
  };
}

/**
 * Walk a dot path such as `status.code` or `data[0].id`.
 *
 * Hand-rolled rather than eval'd: the path comes from a stored monitor row.
 * Returns `undefined` for malformed paths, missing keys, out-of-range indexes
 * and scalar descent — all the same answer to the operator, and the message
 * quotes the path so they can see which.
 * 手动遍历点路径；所有解析失败统一返回 undefined，消息里带上路径。
 */
function walkPath(root: unknown, path: string): { value: unknown } | undefined {
  let cur: unknown = root;
  const re = /[^.[\]]+|\[(\d+)\]/g;
  let consumed = 0;
  let first = true;
  let m: RegExpExecArray | null;

  while ((m = re.exec(path)) !== null) {
    /** Reject malformed gaps like `a..b`; they would match a path the user did not write. / 拒绝 `a..b` 这类错误分段，避免匹配用户未写的路径。 */
    const gap = path.slice(consumed, m.index);
    if (first ? gap !== '' : gap !== '' && gap !== '.') return undefined;
    first = false;
    consumed = m.index + m[0].length;

    if (m[1] !== undefined) {
      const i = Number(m[1]);
      if (!Array.isArray(cur) || i >= cur.length) return undefined;
      cur = cur[i];
      continue;
    }

    // `Object.hasOwn`, not `in`: inherited names like `length` or `toString` would
    // otherwise resolve and hide a typo such as `data.length`.
    // 用 Object.hasOwn 而非 in，避免继承属性掩盖路径拼写错误。
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, m[0])) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[m[0]];
  }

  if (first) return undefined; // an empty path names nothing / 空路径不指向任何内容
  // A trailing separator (`a.`) leaves unconsumed input behind.
  // 末尾分隔符（`a.`）会留下未消费的输入。
  if (consumed !== path.length) return undefined;
  return { value: cur };
}

/** Compare scalars via String; serialize objects instead of comparing `[object Object]`. / 标量用 String 比较；对象先序列化。 */
function asComparable(v: unknown): string {
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

/** UTF-8 then base64 for Basic auth; btoa throws on non-Latin credentials. / Basic 认证先 UTF-8 再 base64；btoa 处理不了非拉丁字符。 */
function basicAuth(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export async function checkHttp(m: Monitor, budget?: ExternalRequestBudget): Promise<CheckResult> {
  const start = Date.now();
  const expected = parseExpected(m.expected_status);
  const opts = parseOptions<HttpOptions>(m.options_json);

  /** Default headers first, so monitor headers of the same name win. / 默认头在前，监控同名头覆盖。 */
  const headers: Record<string, string> = {
    'user-agent': 'uptime-polaris-worker/1.0',
    ...(opts.headers ?? {}),
  };

  /** Apply auth whenever a type is set, even with empty credentials, so the target returns 401. / 设置了认证类型就发送，即使凭据为空，让目标返回 401。 */
  if (opts.auth?.type === 'basic') {
    headers.authorization = basicAuth(opts.auth.username ?? '', opts.auth.password ?? '');
  } else if (opts.auth?.type === 'bearer') {
    headers.authorization = `Bearer ${opts.auth.token ?? ''}`;
  }

  try {
    const res = await budgetedFetch(m.target, {
      method: m.method || 'GET',
      signal: AbortSignal.timeout(m.timeout_ms),
      headers,
      /** Send the body verbatim; do not upgrade GET/HEAD, let fetch report the mismatch. / 原样发送正文；不擅自升级方法，由 fetch 报错。 */
      ...(opts.body !== undefined && opts.body !== '' ? { body: opts.body } : {}),
    }, budget);

    if (!expected(res.status)) {
      await res.body?.cancel().catch(() => {});
      return {
        status: DOWN,
        latencyMs: Date.now() - start,
        statusCode: res.status,
        message: `HTTP ${res.status} not in ${m.expected_status}`,
      };
    }

    /**
     * The body is read once, when something needs it, and reused.
     *
     * A Response body is single-use: a second `readCapped` returns '' rather than
     * throwing, so keyword-then-JSON would report "body is not JSON" for a body
     * that parsed fine. When neither assertion is configured the body is cancelled
     * instead of read.
     * 正文只读一次并复用；重复读取会得到空串，误报“不是 JSON”。
     */
    const needsBody = Boolean(m.keyword) || Boolean(opts.jsonPath);
    const read = needsBody ? await readCapped(res) : { body: '', truncated: false, error: null };
    if (!needsBody) await res.body?.cancel().catch(() => {});

    /** A failed body read is reported before assertions; it may be an aborted download. / 正文读取失败先于断言上报；可能只是下载中断。 */
    if (read.error) {
      const timedOut = isTimeoutAbort(read.error);
      return {
        status: DOWN,
        latencyMs: Date.now() - start,
        statusCode: res.status,
        message: timedOut ? 'timeout while reading body' : `body read failed: ${errMsg(read.error)}`,
      };
    }

    const body = read.body;

    if (m.keyword && !body.includes(m.keyword)) {
      return {
        status: DOWN,
        latencyMs: Date.now() - start,
        statusCode: res.status,
        // Say the read was capped, not that the keyword is absent. / 说明读取被截断，而不是断言关键词不存在。
        message: read.truncated
          ? `keyword "${m.keyword}" not found in first ${BODY_CAP_BYTES} bytes`
          : `keyword "${m.keyword}" not found`,
      };
    }

    if (opts.jsonPath) {
      const expectedJson = opts.jsonExpected ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return {
          status: DOWN,
          latencyMs: Date.now() - start,
          statusCode: res.status,
          message: read.truncated ? 'body is not JSON (truncated)' : 'body is not JSON',
        };
      }

      const hit = walkPath(parsed, opts.jsonPath);
      if (!hit) {
        return {
          status: DOWN,
          latencyMs: Date.now() - start,
          statusCode: res.status,
          message: `json path "${opts.jsonPath}" not found`,
        };
      }

      const got = asComparable(hit.value);
      if (got !== expectedJson) {
        return {
          status: DOWN,
          latencyMs: Date.now() - start,
          statusCode: res.status,
          // The value is quoted and shown: an operator whose API changed shape
          // needs to see what it changed to, not just that it changed.
          // 引用并显示实际值：API 结构改变时，管理员需要看到变成了什么，而不只是知道发生了变化。
          message: `json "${opts.jsonPath}" is "${got.slice(0, 120)}", expected "${expectedJson.slice(0, 120)}"`,
        };
      }
    }

    if (opts.headerName) {
      // `Headers.get` is already case-insensitive per the fetch spec, which is
      // what HTTP requires of field names - no folding is done here.
      // 按 fetch 规范，`Headers.get` 已经不区分大小写，符合 HTTP 对字段名的要求；此处不再折叠。
      const got = res.headers.get(opts.headerName);
      if (got === null) {
        return {
          status: DOWN,
          latencyMs: Date.now() - start,
          statusCode: res.status,
          message: `header "${opts.headerName}" missing`,
        };
      }
      // An empty `headerExpected` asserts nothing beyond existence, which is the
      // useful check on its own - "this response carries the header at all" is
      // how a proxy stripping it is caught.
      // 空的 `headerExpected` 只断言响应头存在；这本身很有用，可发现代理剥除了该头。
      const want = opts.headerExpected ?? '';
      if (want && !got.includes(want)) {
        return {
          status: DOWN,
          latencyMs: Date.now() - start,
          statusCode: res.status,
          message: `header "${opts.headerName}" is "${got.slice(0, 120)}", expected "${want.slice(0, 120)}"`,
        };
      }
    }

    /**
     * Latency is asserted last, and it is a WARN.
     *
     * Last because an assertion failure is more actionable than a slow response.
     * WARN because a target answering correctly in 1.2 s is degraded, not down;
     * paging for it would be wrong, and the heartbeat counts WARN as up, so it
     * never moves availability.
     * 延迟最后检查并记为 WARN；慢不等于故障，也不影响可用率。
     */
    const latencyMs = Date.now() - start;
    const max = opts.maxLatencyMs;
    if (typeof max === 'number' && Number.isFinite(max) && max > 0 && latencyMs > max) {
      return {
        status: WARN,
        latencyMs,
        statusCode: res.status,
        message: `slow: ${Math.round(latencyMs)}ms > ${Math.round(max)}ms`,
      };
    }

    return { status: UP, latencyMs, statusCode: res.status, message: '' };
  } catch (e) {
    if (e instanceof ExternalBudgetExceeded) throw e;
    return { status: DOWN, latencyMs: Date.now() - start, statusCode: 0, message: errMsg(e) };
  }
}
