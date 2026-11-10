// 使用受控 GitHub 响应验证版本清单、下载与缓存。
// Check release manifests, downloads, and caching with controlled GitHub responses.

﻿import assert from 'node:assert/strict';
import { agentCapabilities, agentReleaseManifest, downloadAgentArtifact } from '../../backends/worker/src/lib/agent/download';
import { AGENT_RELEASE_REPOSITORY } from '../../backends/worker/src/lib/agent/release';

const tag = 'v0.2.0';
const version = '0.2.0';
const file = `polaris-agent-${version}-linux-x86_64`;
const base = `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/download/${tag}/`;
const entry = { key: 'linux-x86_64', file, version, size: 7, sha256: 'a'.repeat(64) };
const manifest = { repository: AGENT_RELEASE_REPOSITORY, tag, version, platforms: [entry] };
let mode = 'limited';
let calls = 0;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  calls++;
  const url = String(input);
  let response: Response;
  if (mode === 'limited') response = new Response('', { status: 403 });
  else if (mode === 'missing') response = new Response('', { status: 404 });
  else if (url.includes('api.github.com')) response = Response.json({ tag_name: tag, draft: mode === 'draft_missing' ? undefined : false, prerelease: false, assets: [{ name: 'manifest.json', browser_download_url: base + 'manifest.json' }, { name: file, browser_download_url: base + file, size: 7 }] });
  else response = Response.json(mode === 'bad' ? { ...manifest, repository: 'wrong/repo' } : mode === 'bad_size' ? { ...manifest, platforms: [{ ...entry, size: 7.5 }] } : manifest);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}) as typeof fetch;
function context(file = '') {
  return {
    env: {}, req: { url: 'https://site.test/api/public/agent/download', param: () => file },
    json: (body: unknown, status = 200) => ({ body, status }), header: () => undefined,
    body: (body: BodyInit | null) => new Response(body),
  };
}
let result = await agentCapabilities(context() as never) as { status: number; body: { error: string } };
assert.equal(result.status, 502); assert.equal(result.body.error, 'github_rate_limited');
mode = 'missing'; result = await downloadAgentArtifact(context('polaris-agent-linux-x86_64') as never) as typeof result;
assert.equal(result.status, 501); assert.equal(result.body.error, 'release_not_found');
mode = 'draft_missing'; result = await agentCapabilities(context() as never) as typeof result;
assert.equal(result.status, 502); assert.equal(result.body.error, 'invalid_release');
mode = 'bad'; result = await agentCapabilities(context() as never) as typeof result;
assert.equal(result.status, 502); assert.equal(result.body.error, 'invalid_release_manifest');
mode = 'bad_size'; result = await agentCapabilities(context() as never) as typeof result;
assert.equal(result.status, 502); assert.equal(result.body.error, 'invalid_release_manifest');
mode = 'good'; const good = await agentReleaseManifest(context() as never) as { body: typeof manifest };
assert.deepEqual(good.body, manifest);
const before = calls;
const redirect = await downloadAgentArtifact(context('polaris-agent-linux-x86_64') as never) as Response;
assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), base + file); assert.equal(calls, before);
assert.equal((await downloadAgentArtifact(context('polaris-agent-windows-aarch64.exe') as never) as { status: number }).status, 422);
assert.equal((await downloadAgentArtifact(context('polaris-agent-darwin-aarch64') as never) as { status: number }).status, 501);
assert.equal((await downloadAgentArtifact(context('polaris-agent-0.1.0-linux-x86_64') as never) as { status: number }).status, 501);
console.log('Agent GitHub release contract passed');
