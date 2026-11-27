/**
 * Cloudflare Access external administrator authentication for the Worker backend.
 *
 * Only `disabled` and `cloudflare-access` are accepted here: Workers sit on the public edge
 * without a loopback/CIDR proxy guarantee, so `trusted-header` is explicitly rejected.
 *
 * Worker 后端的 Cloudflare Access 外部管理员认证。仅支持 `disabled` 和 `cloudflare-access`，
 * 因 Worker 运行在公网边缘而无直连代理 IP 边界，明确拒绝 `trusted-header`。
 */

import type { Env } from '../../types';
import { sha256Hex } from './service';

export const EXTERNAL_LOGOUT_COOKIE = 'polaris_external_logout';

const ACCESS_TEAM_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_JWT_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 1024 * 1024;
const JWKS_TIMEOUT_MS = 5_000;
const JWKS_REFRESH_COOLDOWN_MS = 10_000;
const CLOCK_SKEW_SEC = 30;
const EMAIL_RE = /^[^\s@<>",;\\]+@[^\s@<>",;\\]+\.[^\s@<>",;\\]+$/;

export interface ExternalAuthConfig {
  mode: 'cloudflare-access';
  issuer: string;
  audience: string;
  allowed: Set<string>;
}

export type ExternalAuthResolution =
  | { status: 'disabled' }
  | { status: 'invalid'; error: string }
  | { status: 'enabled'; config: ExternalAuthConfig };

export interface ExternalUser {
  id: string;
  username: string;
  authProvider: 'cloudflare-access';
}

export type JwksFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface KeySetCacheEntry {
  keys: Map<string, CryptoKey>;
  lastFetchAt: number;
}

const jwksCache = new Map<string, KeySetCacheEntry>();
let jwksFetchImpl: JwksFetch | null = null;
const loggedInvalidConfig = new Set<string>();

/** Test hook: inject a custom JWKS fetcher (or pass null to restore global fetch) and clear key cache. / 测试钩子：注入自定义 JWKS 获取函数并清空密钥缓存。 */
export function setExternalAuthJwksFetch(fetcher: JwksFetch | null): void {
  jwksFetchImpl = fetcher;
  jwksCache.clear();
  loggedInvalidConfig.clear();
}

export function resetExternalAuthCache(): void {
  jwksCache.clear();
  loggedInvalidConfig.clear();
}

function validExternalIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 320 &&
    value.trim() === value &&
    !value.includes(',') &&
    !CONTROL_CHARS_RE.test(value)
  );
}

function validEmail(value: string): boolean {
  if (!validExternalIdentity(value) || value.length > 254) return false;
  if (!EMAIL_RE.test(value)) return false;
  const at = value.indexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length > 0 && local.length <= 64 && domain.length > 0 && domain.length <= 253 && !domain.startsWith('.') && !domain.endsWith('.') && !domain.includes('..');
}

/** Validate Worker external auth env configuration without leaking secrets in logs. / 校验 Worker 外部认证环境变量，不在日志中泄露密钥。 */
export function parseExternalAuthConfig(env: Partial<Env>): ExternalAuthResolution {
  const mode = (env.AUTH_MODE ?? '').trim();
  if (!mode || mode === 'disabled') return { status: 'disabled' };
  if (mode === 'trusted-header') {
    return { status: 'invalid', error: 'AUTH_MODE=trusted-header is not supported on Cloudflare Workers' };
  }
  if (mode !== 'cloudflare-access') {
    return { status: 'invalid', error: 'AUTH_MODE must be disabled or cloudflare-access' };
  }

  const rawTeam = env.AUTH_CF_TEAM_DOMAIN ?? '';
  let parsedTeam: URL;
  try {
    parsedTeam = new URL(rawTeam);
  } catch {
    return { status: 'invalid', error: 'AUTH_CF_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com' };
  }
  if (
    parsedTeam.protocol !== 'https:' ||
    !ACCESS_TEAM_HOST_RE.test(parsedTeam.host) ||
    parsedTeam.port !== '' ||
    parsedTeam.username !== '' ||
    parsedTeam.password !== '' ||
    parsedTeam.search !== '' ||
    parsedTeam.hash !== '' ||
    rawTeam.includes('?') ||
    rawTeam.includes('#') ||
    (parsedTeam.pathname !== '' && parsedTeam.pathname !== '/')
  ) {
    return { status: 'invalid', error: 'AUTH_CF_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com' };
  }

  const audience = env.AUTH_CF_AUDIENCE ?? '';
  if (!audience || audience !== audience.trim() || audience.length > 512 || /[\s,]/.test(audience)) {
    return { status: 'invalid', error: 'AUTH_CF_AUDIENCE requires one application AUD tag' };
  }

  const allowed = new Set<string>();
  const rawAllowed = env.AUTH_ALLOWED_IDENTITIES ?? '';
  if (rawAllowed.trim() !== '') {
    for (const part of rawAllowed.split(',')) {
      const identity = part.trim().toLowerCase();
      if (!validExternalIdentity(identity)) {
        return { status: 'invalid', error: 'AUTH_ALLOWED_IDENTITIES must contain nonempty identities' };
      }
      allowed.add(identity);
    }
  }

  return {
    status: 'enabled',
    config: {
      mode: 'cloudflare-access',
      issuer: `https://${parsedTeam.host}`,
      audience,
      allowed,
    },
  };
}

export function resolveExternalAuth(env: Partial<Env>): ExternalAuthConfig | null {
  const parsed = parseExternalAuthConfig(env);
  if (parsed.status === 'invalid') {
    if (!loggedInvalidConfig.has(parsed.error)) {
      loggedInvalidConfig.add(parsed.error);
      console.error(JSON.stringify({ event: 'external_auth_invalid_config', error: parsed.error }));
    }
    return null;
  }
  return parsed.status === 'enabled' ? parsed.config : null;
}

function decodeBase64Url(segment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const pad = (4 - (segment.length % 4)) % 4;
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeJwtJson(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Reject duplicate/missing or oversized Cf-Access-Jwt-Assertion headers. / 拒绝重复、缺失或超长的 JWT 请求头。 */
function singleJwtHeader(request: Request): string | null {
  let count = 0;
  let value = '';
  request.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'cf-access-jwt-assertion') {
      count++;
      value = v;
    }
  });
  // Fetch Headers combines duplicate headers with `, `; a valid compact JWS never contains `,` or whitespace.
  if (count !== 1 || !value || value.length > MAX_JWT_BYTES || /[\s,]/.test(value)) return null;
  return value;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('jwks_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(merged);
}

async function fetchAccessKeys(issuer: string): Promise<Map<string, CryptoKey>> {
  const fetcher = jwksFetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  try {
    const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`jwks_http_${response.status}`);
    const body = await readBoundedText(response, MAX_JWKS_BYTES);
    const parsed = JSON.parse(body) as { keys?: unknown };
    if (!Array.isArray(parsed?.keys)) throw new Error('jwks_invalid');

    const keys = new Map<string, CryptoKey>();
    for (const raw of parsed.keys) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const jwk = raw as JsonWebKey & { kid?: unknown; alg?: unknown; use?: unknown };
      if (typeof jwk.kid !== 'string' || !jwk.kid) continue;
      if (jwk.kty !== 'RSA') continue;
      if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
      if (jwk.use !== undefined && jwk.use !== 'sig') continue;
      try {
        const key = await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        keys.set(jwk.kid, key);
      } catch {
        // Ignore individual malformed keys while retaining valid ones in the set.
      }
    }
    return keys;
  } finally {
    clearTimeout(timer);
  }
}

async function verificationKeyForKid(issuer: string, kid: string, nowMs = Date.now()): Promise<CryptoKey | null> {
  const existing = jwksCache.get(issuer);
  const cachedKey = existing?.keys.get(kid);
  if (cachedKey) return cachedKey;

  if (existing && nowMs - existing.lastFetchAt < JWKS_REFRESH_COOLDOWN_MS) {
    return null;
  }

  // Record cooldown before fetching so repeated forged kids cannot trigger a stampede.
  const entry: KeySetCacheEntry = existing ?? { keys: new Map(), lastFetchAt: 0 };
  entry.lastFetchAt = nowMs;
  jwksCache.set(issuer, entry);

  try {
    const freshKeys = await fetchAccessKeys(issuer);
    entry.keys = freshKeys;
    return freshKeys.get(kid) ?? null;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();

export async function verifyCloudflareAccessRequest(
  request: Request,
  env: Env,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<ExternalUser | null> {
  const config = resolveExternalAuth(env);
  if (!config) return null;

  const raw = singleJwtHeader(request);
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;

  const header = decodeJwtJson(headerSeg);
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 256) {
    return null;
  }

  const signature = decodeBase64Url(sigSeg);
  if (!signature) return null;

  const key = await verificationKeyForKid(config.issuer, header.kid, nowSec * 1000);
  if (!key) return null;

  const signingInput = enc.encode(`${headerSeg}.${payloadSeg}`);
  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature as BufferSource,
      signingInput,
    );
  } catch {
    return null;
  }
  if (!verified) return null;

  const claims = decodeJwtJson(payloadSeg);
  if (!claims) return null;

  if (claims.iss !== config.issuer) return null;

  const aud = claims.aud;
  const audValid = typeof aud === 'string'
    ? aud === config.audience
    : Array.isArray(aud) && aud.some((item) => item === config.audience);
  if (!audValid) return null;

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowSec) {
    return null;
  }
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > nowSec + CLOCK_SKEW_SEC) {
      return null;
    }
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > nowSec + CLOCK_SKEW_SEC) {
      return null;
    }
  }

  if (claims.type !== 'app') return null;
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 512) {
    return null;
  }
  if (typeof claims.email !== 'string' || !validEmail(claims.email)) {
    return null;
  }

  const identity = claims.email.toLowerCase();
  if (config.allowed.size > 0 && !config.allowed.has(identity)) {
    return null;
  }

  const subjectDigest = await sha256Hex(`${config.mode}\0${config.issuer}\0${claims.sub}`);
  return {
    id: `external:${config.mode}:${subjectDigest}`,
    username: identity,
    authProvider: 'cloudflare-access',
  };
}

export function externalLogoutCookie(suppressed: boolean, secure: boolean): string {
  const attrs = [
    `${EXTERNAL_LOGOUT_COOKIE}=${suppressed ? '1' : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(suppressed ? [] : ['Max-Age=0']),
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
