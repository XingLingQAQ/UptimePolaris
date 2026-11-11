import type { Context } from 'hono';
import type { Env } from '../../types';
import { findAgentByToken } from './registry';
import type { AgentRpcFrame } from './protocol';
import { dispatchRpc, isSupportedFrame } from './report';

/** A batch larger than this is refused rather than processed. / 超过此大小的批次会被拒绝，不会处理。 */
const MAX_FRAMES_PER_POST = 40;
const MAX_POST_WORK = 40;

/**
 * POST /api/public/agent/push/:token
 *
 * The token is the whole credential, exactly as on the WebSocket route. Body
 * is one frame or an array of them.
 * POST /api/public/agent/push/:token：与 WebSocket 路由一样，仅使用路径令牌鉴权；
 * 请求体为单帧或帧数组。
 */
export async function handleAgentHttpPush(c: Context<{ Bindings: Env }>): Promise<Response> {
  const pathToken = c.req.param('token');
  const queryToken = c.req.query('token');
  const token = pathToken && pathToken !== ':token' ? pathToken : (queryToken ?? '');

  const monitor = await findAgentByToken(c.env, token);
  // Same wording as every other token failure on this surface: the answer must
  // not distinguish "no such token" from "not an agent token".
  // 与此接口的其他令牌失败使用相同措辞，不区分“令牌不存在”和“令牌不属于 Agent”。
  if (!monitor) return c.json({ error: 'invalid token' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }

  const frames: AgentRpcFrame[] = Array.isArray(body) ? (body as AgentRpcFrame[]) : [body as AgentRpcFrame];
  if (frames.length === 0) return c.json({ error: 'empty batch' }, 400);
  if (frames.length > MAX_FRAMES_PER_POST) {
    return c.json({ error: 'batch too large', max: MAX_FRAMES_PER_POST, got: frames.length }, 413);
  }
  const work = frames.reduce((total, frame) => total + frameWork(frame), 0);
  if (work > MAX_POST_WORK) {
    return c.json({ error: 'batch work too large', maxWork: MAX_POST_WORK, work }, 413);
  }

  if (frames.some((frame) => !isSupportedFrame(frame))) return c.json({ ok: false, error: 'invalid frame', applied: 0, received: frames.length }, 400);

  let applied = 0;
  let accepted = 0;
  let ignored = 0;
  let deferred = 0;
  const acknowledgements: { id: unknown; ack: true; ignored: boolean; deferred?: boolean }[] = [];
  /**
   * Sequential, not `Promise.all`.
   *
   * D1 serialises writes to the same row anyway, so concurrency here buys
   * nothing and costs a pile of overlapping upserts against one `machine_live`
   * row. Order also matters when a batch carries a `basicReport` followed by
   * its `report`: running them out of order would have the identity columns
   * land after the metrics they describe.
   * 顺序处理，而非使用 `Promise.all`。D1 本来就会串行化同一行的写入，
   * 并发只会对同一 `machine_live` 行产生重叠 upsert；顺序也影响批次中的
   * `basicReport` 和后续 `report`，否则身份列可能在其描述的指标之后写入。
   */
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || typeof frame.method !== 'string') continue;
    try {
      const result = await dispatchRpc(c.env, monitor, frame);
      if (!result.ack) return c.json({ ok: false, error: 'invalid frame', applied, received: frames.length }, 400);
      applied += 1;
      if (result.deferred) deferred += 1;
      else if (result.ignored) ignored += 1;
      else accepted += 1;
      acknowledgements.push({ id: frame.id ?? null, ack: true, ignored: result.ignored, ...(result.deferred ? { deferred: true } : {}) });
    } catch (err) {
      console.error(
        JSON.stringify({ event: 'agent_http_frame_error', monitor: monitor.id, err: String(err) }),
      );
      return c.json({ error: 'frame persistence failed', retry: true }, 503);
    }
  }

  // The status code reflects whether anything was understood, so the agent can
  // tell "the server is rejecting my frames" from "the server is down" - the
  // two need different fallbacks, and a blanket 200 would hide the first.
  // 状态码反映是否理解了任何帧，使 Agent 区分“服务端拒绝帧”和“服务端不可用”；
  // 两者需要不同的回退方式，一律返回 200 会掩盖前者。
  if (applied === 0) return c.json({ ok: false, applied: 0, received: frames.length }, 400);
  return c.json({
    ok: true, applied, accepted, ignored, deferred, received: frames.length,
    acks: acknowledgements,
  });
}

function frameWork(frame: unknown): number {
  if (typeof frame !== 'object' || frame === null) return 1;
  const row = frame as Record<string, unknown>;
  if (row.method === 'basicReport') return 2;
  if (row.method === 'report') {
    const params = typeof row.params === 'object' && row.params !== null
      ? row.params as Record<string, unknown>
      : null;
    const summaries = Array.isArray(params?.summaries) ? params.summaries.length : 0;
    return 2 + summaries;
  }
  return 1;
}
