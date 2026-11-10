import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAgentServer, AgentStateType } from '@stagewise/agent-interface/agent';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function localRequest(request, frontendPort) {
  if (!loopbackAddresses.has(request.socket.remoteAddress)) return false;
  try {
    if (!loopbackHosts.has(new URL(`http://${request.headers.host}`).hostname)) return false;
    if (request.headers.origin) {
      const origin = new URL(request.headers.origin);
      const port = typeof frontendPort === 'function' ? frontendPort() : frontendPort;
      if (!loopbackHosts.has(origin.hostname) || Number(origin.port) !== port) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function createBridge(project) {
  const path = join(project, '.stagewise', 'bridge-start.lock');
  const deadline = Date.now() + 15000;
  let lock;
  while (!lock) {
    try {
      lock = await open(path, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await readFile(path, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (ownerError) { if (ownerError.code === 'ESRCH') await unlink(path).catch(() => {}); }
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error('Timed out waiting for another local Stagewise bridge to start');
      await sleep(50);
    }
  }
  try {
    await lock.writeFile(String(process.pid));
    return await createAgentServer();
  } finally {
    await lock.close();
    await unlink(path).catch(() => {});
  }
}

export async function startStagewiseBridge(project, frontendPort) {
  const directory = join(project, '.stagewise', 'requests');
  await mkdir(directory, { recursive: true });
  const bridge = await createBridge(project);
  bridge.setAgentName('uptime 本地反馈');
  bridge.setAgentDescription('保存页面选择与 React 上下文，回到当前对话说“继续”处理');
  bridge.wss.options.maxPayload = 16 * 1024 * 1024;

  // The SDK binds all interfaces; restrict HTTP and WebSocket entry points. / SDK 绑定所有网络接口；限制 HTTP 和 WebSocket 入口。
  for (const event of ['request', 'upgrade']) {
    const listeners = bridge.server.listeners(event);
    bridge.server.removeAllListeners(event);
    bridge.server.on(event, (request, target, head) => {
      if (!localRequest(request, frontendPort)) {
        if (event === 'request') target.writeHead(403).end('Local frontend access only');
        else target.destroy();
        return;
      }
      for (const listener of listeners) listener.call(bridge.server, request, target, head);
    });
  }

  const receive = async (message) => {
    bridge.interface.state.set(AgentStateType.WORKING, '正在保存修改意见');
    try {
      const id = createHash('sha256').update(message.id).digest('hex').slice(0, 32);
      const record = JSON.stringify({
        schemaVersion: 1, id, source: 'stagewise', createdAt: new Date().toISOString(),
        message, handling: { state: 'pending' },
      }, null, 2);
      if (Buffer.byteLength(record) > 12 * 1024 * 1024) throw new Error('context_too_large');
      try {
        await writeFile(join(directory, `${id}.json`), record, { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      bridge.interface.messaging.set([{
        type: 'text',
        text: '修改意见、页面元素和 React 上下文已保存到当前项目。请回到当前对话发送“继续”，我会读取这轮反馈并修改代码。',
      }]);
      bridge.interface.state.set(AgentStateType.WAITING_FOR_USER_RESPONSE, '已保存，回到对话继续');
    } catch (error) {
      console.error('[stagewise] Feedback save failed:', error.message);
      bridge.interface.messaging.set([{
        type: 'text',
        text: error.message === 'context_too_large'
          ? '所选页面内容过大，尚未保存。请缩小选择范围后重新发送。'
          : '修改意见未能保存。请检查开发服务器终端中的错误，然后重新发送。',
      }]);
      bridge.interface.state.set(AgentStateType.FAILED, '反馈未保存');
    }
  };
  bridge.interface.messaging.addUserMessageListener((message) => { void receive(message); });
  bridge.interface.availability.set(true);

  return {
    ...bridge,
    close() {
      bridge.interface.cleanup.clearAllListeners();
      for (const client of bridge.wss.clients) client.terminate();
      bridge.wss.close();
      bridge.server.closeAllConnections();
      bridge.server.close();
    },
  };
}

export function stagewise({ publicOrigin } = {}) {
  let bridge;
  return {
    name: 'uptime-polaris-stagewise',
    apply: 'serve',
    async configureServer(vite) {
      const current = await startStagewiseBridge(resolve(vite.config.root, '..'),
        () => vite.httpServer?.address()?.port ?? vite.config.server.port ?? 3882);
      bridge = current;
      const frontendPort = () => vite.httpServer?.address()?.port ?? vite.config.server.port ?? 3882;
      const allowedRequest = (request) => {
        if (!loopbackAddresses.has(request.socket.remoteAddress)) return false;
        try {
          const host = new URL(`http://${request.headers.host}`);
          const origin = publicOrigin && host.host === new URL(publicOrigin).host
            ? publicOrigin
            : loopbackHosts.has(host.hostname) && Number(host.port) === frontendPort()
              ? host.origin : undefined;
          return Boolean(origin && (!request.headers.origin || request.headers.origin === origin));
        } catch {
          return false;
        }
      };
      vite.config.server.proxy ??= {};
      vite.config.server.proxy['^/stagewise/(info|ws)(?:\\?|$)'] = {
        target: `http://127.0.0.1:${current.port}`,
        ws: true,
        bypass(request) {
          if (!allowedRequest(request)) return false;
        },
        configure(proxy) {
          const localHeaders = (outgoing) => {
            outgoing.setHeader('host', `127.0.0.1:${current.port}`);
            outgoing.setHeader('origin', `http://127.0.0.1:${frontendPort()}`);
          };
          proxy.on('proxyReq', localHeaders);
          proxy.on('proxyReqWs', localHeaders);
        },
      };
      vite.config.logger.info(`[stagewise] 本地反馈接收端：localhost:${current.port}`);
      vite.httpServer?.once('close', () => current.close());
    },
    transformIndexHtml() {
      if (!bridge) return [];
      return [{
        tag: 'script',
        children: `window.__polarisStagewiseBridgePort = ${JSON.stringify(bridge.port)}; window.__polarisStagewiseSameOrigin = true;`,
        injectTo: 'head-prepend',
      }];
    },
  };
}
