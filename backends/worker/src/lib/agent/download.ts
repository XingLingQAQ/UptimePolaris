import type { Context } from 'hono';
import type { Env } from '../../types';
import { powershellInstallBootstrap } from '../../../../../shared/agent-install';
import { installPs1, installSh } from './install-script';
import { latestAgentRelease, PROBE_PLATFORMS, releaseUrl } from './release';

export { PROBE_PLATFORMS } from './release';
export function serveAgentInstaller(c: Context<{ Bindings: Env }>, file: 'install.sh' | 'install.ps1', compact = false) {
  const base = new URL(c.req.url).origin;
  c.header('content-type', file === 'install.sh' ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8');
  c.header('cache-control', 'no-cache');
  c.header('x-content-type-options', 'nosniff');
  return c.body(file === 'install.sh' ? installSh({ base }) : compact ? powershellInstallBootstrap(base) : installPs1({ base }));
}
function releaseError(c: Context<{ Bindings: Env }>, error: unknown) {
  const code = error instanceof Error ? error.message : 'github_unavailable';
  return c.json({ error: code, note: 'Check the Agent GitHub release, network access and API rate limit.' }, code === 'release_not_found' ? 501 : 502);
}
export async function agentCapabilities(c: Context<{ Bindings: Env }>) {
  try { return c.json(await latestAgentRelease()); } catch (error) { return releaseError(c, error); }
}
export const agentReleaseManifest = agentCapabilities;
export async function downloadAgentArtifact(c: Context<{ Bindings: Env }>) {
  const file = c.req.param('file') ?? '';
  if (file === 'install.sh' || file === 'install.ps1') return serveAgentInstaller(c, file);
  const match = /^polaris-agent-(?:(\d+\.\d+\.\d+)-)?(linux-x86_64|linux-aarch64|windows-x86_64|darwin-x86_64|darwin-aarch64)(\.exe)?$/.exec(file);
  if (!match || (match[2] === 'windows-x86_64') !== (match[3] === '.exe')) return c.json({ error: 'unsupported_platform', supported: Object.keys(PROBE_PLATFORMS) }, 422);
  try {
    const manifest = await latestAgentRelease();
    const entry = manifest.platforms.find(p => p.key === match[2]);
    if (!entry || (match[1] && file !== entry.file)) return c.json({ error: 'release_asset_missing', platform: match[2] }, 501);
    return new Response(null, { status: 302, headers: { location: releaseUrl(manifest, entry.file), 'cache-control': 'no-store' } });
  } catch (error) { return releaseError(c, error); }
}
