import { connect } from 'cloudflare:sockets';
import { DOWN, parseOptions, UP, type Monitor, type TcpOptions } from '../../types';
import { ExternalBudgetExceeded, type ExternalRequestBudget } from '../http/request-budget';
import { errMsg } from '../util';
import type { CheckResult } from './types';

/** Accepts "host:port", "[::1]:443" and "tcp://host:port". / 接受 "host:port"、"[::1]:443" 和 "tcp://host:port"。 */
export function parseHostPort(target: string): { host: string; port: number } {
  const s = target.replace(/^tcp:\/\//i, '').trim();
  const v6 = s.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) {
    const port = Number(v6[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
    return { host: v6[1], port };
  }
  const i = s.lastIndexOf(':');
  if (i < 0) throw new Error('target must be host:port');
  if (!/^\d+$/.test(s.slice(i + 1))) throw new Error('invalid port');
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return { host: s.slice(0, i), port };
}

/** Stop reading after a chunk brings the banner to 4 KiB; the final chunk can exceed this threshold. / 服务横幅累计达到 4 KiB 后停止读取；最后一个数据块可能使其超过此阈值。 */
const BANNER_CAP = 4096;

/** How much of the banner a mismatch message carries. / 不匹配消息中包含的服务横幅长度。 */
const BANNER_REPORT = 200;

export async function checkTcp(m: Monitor, budget?: ExternalRequestBudget): Promise<CheckResult> {
  const start = Date.now();
  const opts = parseOptions<TcpOptions>(m.options_json);
  const send = opts.send ?? '';
  const expect = opts.expect ?? '';

  // `Socket` is a global ambient type, not an export of cloudflare:sockets.
  // `Socket` 是全局环境类型，并非 cloudflare:sockets 的导出项。
  let socket: ReturnType<typeof connect> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { host, port } = parseHostPort(m.target);
    budget?.reserve();
    socket = connect({ hostname: host, port });

    /** One shared deadline covers connect, write and reads. / 连接、写入和读取共用一个截止时间。 */
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), m.timeout_ms);
    });
    await Promise.race([socket.opened, timeout]);

    // Connect-only checks must not wait for a banner.
    // 仅检查连接时不能等待服务横幅。
    if (!send && !expect) {
      return { status: UP, latencyMs: Date.now() - start, statusCode: 0, message: '' };
    }

    if (send) {
      const writer = socket.writable.getWriter();
      try {
        // Add a line ending for line-oriented protocols unless one is supplied.
        // 面向行的协议需要行尾；调用方未提供时补上。
        const line = /[\r\n]$/.test(send) ? send : `${send}\r\n`;
        await Promise.race([writer.write(new TextEncoder().encode(line)), timeout]);
      } finally {

        writer.releaseLock();
      }
    }

    let banner = '';
    if (expect) {
      const reader = socket.readable.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      try {
        while (total < BANNER_CAP) {
          const { done, value } = await Promise.race([reader.read(), timeout]);
          if (done || !value) break;
          total += value.byteLength;
          // Keep UTF-8 characters intact across chunks.
          // 保持跨数据块的 UTF-8 字符完整。
          banner += decoder.decode(value, { stream: true });

          if (banner.includes(expect)) break;
        }
        banner += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }

      if (!banner.includes(expect)) {
        return {
          status: DOWN,
          latencyMs: Date.now() - start,
          statusCode: 0,

          message: `expect "${expect}" not found in "${banner.slice(0, BANNER_REPORT)}"`,
        };
      }
    }

    return { status: UP, latencyMs: Date.now() - start, statusCode: 0, message: '' };
  } catch (e) {
    if (e instanceof ExternalBudgetExceeded) throw e;

    return { status: DOWN, latencyMs: Date.now() - start, statusCode: 0, message: errMsg(e) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (socket) await socket.close().catch(() => {});
  }
}
