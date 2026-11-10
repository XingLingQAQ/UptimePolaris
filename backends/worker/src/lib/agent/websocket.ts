/** Authenticated agent socket; request ACKs follow their database writes. / 已认证的 Agent 套接字；请求 ACK 在数据库写入后发送。 */

import type { Context } from 'hono';
import type { Agent, Env } from '../../types';
import { withDBScope, withIndependentDBScope } from '../db/factory';
import { databaseIdentity, requireReadyDatabase } from '../db/setup-control';
import { findAgentByToken } from './registry';
import type { AgentRpcFrame } from './protocol';
import { dispatchRpc } from './report';

/** Agent WebSocket route; resolves a per-Agent credential before upgrading. / Agent WebSocket 路由；升级前验证各 Agent 的凭据。 */
export async function handleAgentWebSocket(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const upgrade = c.req.header('Upgrade');
  if (upgrade !== 'websocket') {
    return c.json(
      { error: 'expected websocket upgrade', code: 'upgrade_required' },
      426,
    );
  }

  const token = c.req.param('token') ?? '';

  const monitor = await withDBScope(c.env, (env) => findAgentByToken(env, token));
  if (!monitor) {
    // Same wording as /api/public/push/:token: the failure must not be a
    // lookup oracle that distinguishes "no such token" from "not an agent
    // token".
    // 与 /api/public/push/:token 使用相同措辞，避免通过失败响应区分
    // “令牌不存在”和“令牌不属于 Agent”。
    return c.json({ error: 'invalid token' }, 401);
  }

  /** Accept the server end and return the client end in the upgrade response. / 接受服务端套接字，并在升级响应中返回客户端套接字。 */
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  /** Attach listeners before returning the upgrade response; frames are processed in order. / 返回升级响应前注册监听器；按顺序处理帧。 */
  handleAgentConnection(c.env, server, monitor, c.executionCtx);

  return new Response(null, { status: 101, webSocket: client });
}

function handleAgentConnection(
  env: Env,
  ws: WebSocket,
  monitor: Agent,
  executionCtx: Pick<ExecutionContext, 'waitUntil'>,
): void {
  let tail = Promise.resolve();
  let queued = 0;
  // 串行持久化帧，保证同一连接的 ACK 与上报顺序一致。
  // Persist frames serially so ACKs follow report order on the same connection.
  ws.addEventListener('message', (event: MessageEvent) => {
    if (queued >= 32) {
      ws.close(1013, 'frame queue full');
      return;
    }
    queued++;
    const work = tail.then(async () => {
      return dispatchFrameSafely(env, ws, monitor, event.data);
    });
    const tracked = work.catch(() => undefined);
    executionCtx.waitUntil(tracked);
    tail = tracked.finally(() => { queued--; });
  });

  ws.addEventListener('close', (event: CloseEvent) => {
    if (ws.readyState !== WebSocket.CLOSED) {
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
      ws.close(code, event.reason.slice(0, 123));
    }
    console.log(JSON.stringify({ event: 'agent_disconnected', monitor: monitor.id }));
  });

  ws.addEventListener('error', (ev) => {
    console.error(
      JSON.stringify({ event: 'agent_socket_error', monitor: monitor.id, err: String(ev) }),
    );
  });
}

// ACK 必须晚于独立数据库作用域中的持久化；失败时关闭连接并让队列记录失败。
// ACK only after persistence in an independent DB scope; close and reject on failure.
async function dispatchFrameSafely(env: Env, ws: WebSocket, monitor: Agent, data: unknown): Promise<void> {
  try {
    const msg = JSON.parse(String(data)) as AgentRpcFrame;
    const result = await withIndependentDBScope(env, async (scopedEnv) => {
      await requireReadyDatabase(scopedEnv);
      if (databaseIdentity(scopedEnv) !== databaseIdentity(env)) throw new Error('database_changed');
      return dispatchRpc(scopedEnv, monitor, msg);
    });
    if (!result.ack) {
      ws.close(1008, 'frame rejected');
      return;
    }
    if (msg.id !== null && msg.id !== undefined) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ack: true, ignored: result.ignored, ...(result.deferred ? { deferred: true } : {}) } }));
    }
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'agent_dispatch_error', monitor: monitor.id, err: String(err) }),
    );
    ws.close(1011, 'persistence failed');
    throw err;
  }
}
