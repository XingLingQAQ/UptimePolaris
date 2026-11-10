import source from '../../../../../shared/agent-release-repository.json';

export const AGENT_RELEASE_REPOSITORY = source.repository;
export const PROBE_PLATFORMS: Record<string, string> = {
  'linux-x86_64': '', 'linux-aarch64': '', 'windows-x86_64': '.exe',
  'darwin-x86_64': '', 'darwin-aarch64': '',
};
export interface AgentPlatform { key: string; file: string; size: number; sha256: string; version: string }
export interface AgentManifest { repository: string; tag: string; version: string; platforms: AgentPlatform[] }
let cached: { value: AgentManifest; until: number } | undefined;
let pending: Promise<AgentManifest> | undefined;

// 每次跳转都检查目标；流式计数不依赖 Content-Length 是否存在或准确。
// Check each redirect target; count streamed bytes independently of Content-Length.
async function requestJson(url: string, limit: number): Promise<unknown> {
  let next = new URL(url);
  let response: Response | undefined;
  const signal = AbortSignal.timeout(10000);
  for (let count = 0; count < 5; count++) {
    if (next.protocol !== 'https:' || next.port || next.username || next.password || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)) throw new Error('invalid_release_redirect');
    response = await fetch(next.toString(), { headers: { 'User-Agent': 'Uptime-Polaris', Accept: 'application/vnd.github+json' }, signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('invalid_release_redirect');
    next = new URL(location, next);
    response = undefined;
  }
  if (!response) throw new Error('invalid_release_redirect');
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'github_rate_limited' : response.status === 404 ? 'release_not_found' : 'github_unavailable');
  if (Number(response.headers.get('content-length')) > limit) throw new Error('release_response_too_large');
  if (!response.body) throw new Error('empty_release_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) { await reader.cancel(); throw new Error('release_response_too_large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function load(): Promise<AgentManifest> {
  const release = await requestJson(`https://api.github.com/repos/${AGENT_RELEASE_REPOSITORY}/releases/latest`, 1024 * 1024) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  const tag = release.tag_name;
  if (typeof tag !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error('invalid_release');
  const version = tag.slice(1);
  const base = `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/download/${tag}/`;
  const assets = new Map<string, { browser_download_url?: unknown; size?: unknown }>();
  for (const item of release.assets) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || assets.has(item.name)) throw new Error('invalid_release_assets');
    assets.set(item.name, item);
  }
  if (assets.get('manifest.json')?.browser_download_url !== `${base}manifest.json`) throw new Error('release_manifest_missing');
  const manifest = await requestJson(`${base}manifest.json`, 65536) as AgentManifest;
  if (!manifest || manifest.repository !== AGENT_RELEASE_REPOSITORY || manifest.tag !== tag || manifest.version !== version || !Array.isArray(manifest.platforms) || !manifest.platforms.length) throw new Error('invalid_release_manifest');
  // manifest 必须与同一 Release 的附件名、大小和下载地址匹配。
  // Match manifest filenames, sizes, and URLs against assets in the same release.
  const seen = new Set<string>();
  for (const item of manifest.platforms) {
    if (!item || typeof item.key !== 'string' || !Object.hasOwn(PROBE_PLATFORMS, item.key) || seen.has(item.key) || item.version !== version || item.file !== `polaris-agent-${version}-${item.key}${PROBE_PLATFORMS[item.key]}` || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 64 * 1024 * 1024 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid_release_manifest');
    const asset = assets.get(item.file);
    if (asset?.browser_download_url !== `${base}${item.file}` || asset.size !== item.size) throw new Error('release_asset_missing');
    seen.add(item.key);
  }
  return manifest;
}
/** 成功结果缓存五分钟，并合并同一实例内的并发刷新。 / Cache successful results for five minutes and share concurrent refreshes within this instance. */
export async function latestAgentRelease(): Promise<AgentManifest> {
  if (cached && cached.until > Date.now()) return cached.value;
  pending ??= load().then(value => { cached = { value, until: Date.now() + 300_000 }; return value; }).finally(() => { pending = undefined; });
  return pending;
}
export function cachedAgentRelease(): AgentManifest | null {
  return cached && cached.until > Date.now() ? cached.value : null;
}
export function releaseUrl(manifest: AgentManifest, file: string): string {
  return `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/download/${manifest.tag}/${file}`;
}
