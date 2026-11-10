export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException.
    // AbortSignal.timeout 以 TimeoutError DOMException 拒绝。
    if (e.name === 'TimeoutError') return 'timeout';
    return e.message;
  }
  return String(e);
}

export function hostOf(target: string): string {
  return target
    .replace(/^[a-z]+:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase();
}

/** How much of a body a check reads before giving up. / 检查在停止前最多读取的响应体大小。 */
export const BODY_CAP_BYTES = 262144;

/** Capped body read; `truncated` and `error` are distinct so a timeout is not read as "keyword absent". / 有上限的正文读取；`truncated` 与 `error` 分开，避免超时被当成“没有关键词”。 */
export interface CappedBody {
  body: string;
  /** Read stopped at the cap, so there may be more even if the body was exactly `max` bytes. / 读取在上限处停止；即使正好 `max` 字节，也可能还有更多。 */
  truncated: boolean;
  /** The read failure (a timeout abort lands here), or null when it completed. / 读取失败信息（包括超时中止）；完成时为 null。 */
  error: Error | null;
}

/** Timeout and abort both mean the check ran out of time. / 超时和中止都表示检查耗尽时间。 */
export function isTimeoutAbort(e: unknown): boolean {
  const name = typeof e === 'object' && e !== null
    ? (e as { name?: unknown }).name
    : undefined;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Read at most `max` bytes; keyword checks must not burn the CPU budget on large pages. / 最多读 `max` 字节；关键词检查不能在大页面上耗尽 CPU 预算。 */
export async function readCapped(res: Response, max = BODY_CAP_BYTES): Promise<CappedBody> {
  const reader = res.body?.getReader();
  if (!reader) return { body: '', truncated: false, error: null };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let error: Error | null = null;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value.subarray(0, max - total));
      total += value.byteLength;
    }
    truncated = total >= max;
  } catch (e) {
    // Kept, not swallowed: the caller must be able to tell a timeout from a
    // keyword that is genuinely absent (see `CappedBody.error`).
    // 保留而非吞掉错误：调用方必须区分超时与关键字确实不存在（见 `CappedBody.error`）。
    error = e instanceof Error ? e : new Error(String(e));
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= buf.length) break;
    buf.set(c.subarray(0, buf.length - off), off);
    off += c.byteLength;
  }
  return { body: new TextDecoder().decode(buf), truncated, error };
}

export function daysUntil(iso: string): number {
  return (Date.parse(iso) - Date.now()) / 86400000;
}

export function clampInteger(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
