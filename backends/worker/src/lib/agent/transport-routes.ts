/** Agent 安装、上报、任务轮询及配置交换的传输路由。 / Transport routes for Agent installation, reports, job polling, and configuration exchange. */
export const agentTransportRoutes = new Hono<{ Bindings: Env }>();

import { Hono } from 'hono';
import type { Env } from '../../types';
import { agentCapabilities, agentReleaseManifest, downloadAgentArtifact, serveAgentInstaller } from './download';
import { handleAgentHttpPush } from './http-push';
import { handleAgentCommandResult, handleAgentProbePoll, handleAgentProbeResult, handleProbeSources } from './probes';
import { handleAgentWebSocket } from './websocket';
import { handleAgentConfigurationExchange } from './runtime-config';

agentTransportRoutes.get('/install.sh', (c) => serveAgentInstaller(c, 'install.sh', true));
agentTransportRoutes.get('/install.ps1', (c) => serveAgentInstaller(c, 'install.ps1', true));

agentTransportRoutes.get('/api/public/agent/capabilities', agentCapabilities);
agentTransportRoutes.post('/api/public/agent/config/:token', handleAgentConfigurationExchange);

agentTransportRoutes.get('/api/public/agent/manifest', agentReleaseManifest);

agentTransportRoutes.get('/api/public/agent/download/:file', downloadAgentArtifact);

/** Register HTTP ingestion before the WebSocket :token route so `push` is not treated as a token. / HTTP 接入路由须先于 WebSocket :token 路由注册，避免将 `push` 当作令牌。 */
agentTransportRoutes.post('/api/public/agent/push/:token', handleAgentHttpPush);

agentTransportRoutes.get('/api/public/agent/push/:token', (c) =>
  // A GET on this path is almost always someone checking the URL by hand.
  // Answering with what the endpoint is saves them guessing.
  // 此路径上的 GET 通常是手动检查 URL；直接说明端点用途可避免猜测。
  c.json({
    ok: true,
    transport: 'http-push',
    note: 'POST one JSON-RPC frame, or an array of them, to this URL. The token in the path is the credential.',
  }),
);

agentTransportRoutes.get('/api/public/agent/jobs/:token', handleAgentProbePoll);

agentTransportRoutes.post('/api/public/agent/results/:token', handleAgentProbeResult);

agentTransportRoutes.post('/api/public/agent/commands/:token/result', handleAgentCommandResult);

agentTransportRoutes.get('/api/agents/probe-sources', handleProbeSources);

agentTransportRoutes.get('/api/public/agent/:token', handleAgentWebSocket);
