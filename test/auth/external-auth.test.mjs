// Check Worker Cloudflare Access external administrator authentication.
// 验证 Worker 端 Cloudflare Access 外部管理员认证、JWT 校验及会话回退。

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const watchdog = setTimeout(() => {
  console.error('External auth fixture timed out');
  process.exit(2);
}, 90_000);

const HARNESS = `
import { api } from './backends/worker/src/api';
import { setExternalAuthJwksFetch, parseExternalAuthConfig, resetExternalAuthCache, verifyCloudflareAccessRequest } from './backends/worker/src/lib/auth/external';
import { finishSetup } from './backends/worker/src/lib/auth/service';
import { loadLiveFresh } from './backends/worker/src/lib/monitor/store';

let jwksCalls = 0;
let jwksUnavailable = false;
let jwksDelayMs = 0;
let activeKeys = [];

setExternalAuthJwksFetch(async (url) => {
  jwksCalls++;
  if (!String(url).endsWith('/cdn-cgi/access/certs')) {
    return new Response('not found', { status: 404 });
  }
  if (jwksDelayMs) await new Promise((resolve) => setTimeout(resolve, jwksDelayMs));
  if (jwksUnavailable) {
    return new Response('unavailable', { status: 503 });
  }
  return Response.json({ keys: activeKeys });
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__setup-owner') {
      const id = await finishSetup(env, 'fixture-owner', 'fixture-owner-secret');
      return Response.json({ ok: Boolean(id), id });
    }
    if (url.pathname === '/__jwks') {
      if (request.method === 'POST') {
        const body = await request.json();
        if (body.keys !== undefined) activeKeys = body.keys;
        if (body.unavailable !== undefined) jwksUnavailable = body.unavailable;
        if (body.delayMs !== undefined) jwksDelayMs = body.delayMs;
        if (body.reset) {
          jwksCalls = 0;
          resetExternalAuthCache();
        }
      }
      return Response.json({ calls: jwksCalls, unavailable: jwksUnavailable });
    }
    if (url.pathname === '/__check-config') {
      const body = await request.json();
      return Response.json(parseExternalAuthConfig(body));
    }
    if (url.pathname === '/__verify-batch') {
      const { tokens, nowSec } = await request.json();
      const users = await Promise.all(tokens.map((token) => verifyCloudflareAccessRequest(
        new Request(request.url, { headers: { 'cf-access-jwt-assertion': token } }), env, nowSec,
      )));
      return Response.json(users.map(Boolean));
    }
    if (url.pathname === '/__live') return Response.json(await loadLiveFresh(env));
    return api.fetch(request, env, ctx);
  },
};
`;

const built = await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  write: false,
  target: 'es2022',
  plugins: workerBundlePlugins(),
  logLevel: 'error',
});

const TEAM_DOMAIN = 'https://polaris-team.cloudflareaccess.com';
const AUDIENCE = 'polaris-access-aud-123';
const ADMIN_TOKEN = 'external-auth-admin-token';
const ORIGIN = 'https://status.example.test';

function b64url(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateRsaPair(kid) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
  };
}

async function signJwt(claims, privateKey, headerOverrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'kid-1', ...headerOverrides };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(body, 'utf8'));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

function worker(bindings = {}) {
  return new Miniflare({
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ADMIN_TOKEN,
      PBKDF2_ITERATIONS: '3000',
      AUTH_MODE: 'cloudflare-access',
      AUTH_CF_TEAM_DOMAIN: TEAM_DOMAIN,
      AUTH_CF_AUDIENCE: AUDIENCE,
      AUTH_ALLOWED_IDENTITIES: 'Owner@example.com, operator@example.com',
      ...bindings,
    },
    d1Databases: { DB: crypto.randomUUID() },
    kvNamespaces: { CONFIG: 'external-auth-config' },
    analyticsEngineDatasets: { UPTIME: { dataset: 'external_auth_fixture' } },
  });
}

async function req(mf, path, init = {}) {
  const res = await mf.dispatchFetch(ORIGIN + path, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { res, body };
}

const key1 = await generateRsaPair('kid-1');
const key2 = await generateRsaPair('kid-2');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nGNgYGD4z8Dwn4GBAQAAAAD//wMAAP8A//8AAoAAAf+amj8cAAAAAElFTkSuQmCC', 'base64');

const baseClaims = () => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TEAM_DOMAIN,
    aud: [AUDIENCE],
    exp: now + 3600,
    iat: now - 60,
    nbf: now - 60,
    sub: 'cf-user-subject-1',
    email: 'owner@example.com',
    type: 'app',
  };
};

// 1. Setup gate + config validation
{
  const mf = worker();
  try {
    await applyD1Migrations(await mf.getD1Database('DB'));
    await req(mf, '/__jwks', { method: 'POST', body: JSON.stringify({ keys: [key1.jwk], reset: true }) });

    // Configuration validation cases
    for (const bad of [
      { AUTH_MODE: 'trusted-header', AUTH_ALLOWED_IDENTITIES: 'owner@example.com' },
      { AUTH_MODE: 'proxy' },
      { AUTH_MODE: 'cloudflare-access', AUTH_CF_TEAM_DOMAIN: 'http://polaris-team.cloudflareaccess.com', AUTH_CF_AUDIENCE: AUDIENCE },
      { AUTH_MODE: 'cloudflare-access', AUTH_CF_TEAM_DOMAIN: 'https://polaris-team.cloudflareaccess.com.evil.test', AUTH_CF_AUDIENCE: AUDIENCE },
      { AUTH_MODE: 'cloudflare-access', AUTH_CF_TEAM_DOMAIN: 'https://polaris-team.cloudflareaccess.com/path', AUTH_CF_AUDIENCE: AUDIENCE },
      { AUTH_MODE: 'cloudflare-access', AUTH_CF_TEAM_DOMAIN: 'https://user:pass@polaris-team.cloudflareaccess.com', AUTH_CF_AUDIENCE: AUDIENCE },
      { AUTH_MODE: 'cloudflare-access', AUTH_CF_TEAM_DOMAIN: TEAM_DOMAIN, AUTH_CF_AUDIENCE: '' },
      { AUTH_MODE: 'cloudflare-access', AUTH_CF_TEAM_DOMAIN: TEAM_DOMAIN, AUTH_CF_AUDIENCE: AUDIENCE, AUTH_ALLOWED_IDENTITIES: 'owner@example.com,' },
    ]) {
      const check = await req(mf, '/__check-config', { method: 'POST', body: JSON.stringify(bad) });
      assert.equal(check.body.status, 'invalid', JSON.stringify(bad));
    }

    const validJwt = await signJwt(baseClaims(), key1.privateKey, { kid: 'kid-1' });

    // Before /setup completes, external auth must stay disabled and never bypass setup.
    const preSetupSession = await req(mf, '/api/auth/session', {
      headers: { 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(preSetupSession.body.needsSetup, true);
    assert.equal(preSetupSession.body.authenticated, false);
    assert.equal(preSetupSession.body.externalAuth, null);
    assert.equal(preSetupSession.body.authentication, null);
    const preSetupExternal = await req(mf, '/api/auth/external', {
      method: 'POST',
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(preSetupExternal.res.status, 404);

    // A trusted-but-unprovisioned identity must not reach the management API before
    // `/setup` completes, matching Go's `setupReady` gate.
    // 初始化未完成时，验签通过的外部身份也不得进入管理 API（对齐 Go 的 setupReady）。
    for (const [method, path] of [['GET', '/api/monitors'], ['GET', '/api/admin/settings']]) {
      assert.equal((await req(mf, path, { headers: { 'cf-access-jwt-assertion': validJwt } })).res.status, 401, `${method} ${path}`);
    }
    assert.equal((await req(mf, '/api/monitors', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-access-jwt-assertion': validJwt },
      body: JSON.stringify({ name: 'pre-setup-probe', type: 'http', target: 'https://example.com' }),
    })).res.status, 401);
    console.log('PASS Worker external auth config validation and pre-setup gate');

    // Complete setup
    const seeded = await req(mf, '/__setup-owner');
    assert.equal(seeded.body.ok, true);

    await req(mf, '/__jwks', { method: 'POST', body: JSON.stringify({ delayMs: 100 }) });
    const concurrent = await Promise.all(['/api/auth/session', '/api/overview', '/api/monitors'].map((path) =>
      req(mf, path, { headers: { 'cf-access-jwt-assertion': validJwt } }),
    ));
    for (const result of concurrent) assert.equal(result.res.status, 200);
    assert.equal(concurrent[0].body.authenticated, true, 'cold-start session must await the shared JWKS fetch');
    assert.equal((await req(mf, '/__jwks')).body.calls, 1);
    await req(mf, '/__jwks', { method: 'POST', body: JSON.stringify({ delayMs: 0 }) });

    // Valid JWT signs in without setting any local session cookie
    const session = await req(mf, '/api/auth/session', {
      headers: { 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(session.res.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.authentication, 'cloudflare-access');
    assert.deepEqual(session.body.externalAuth, { mode: 'cloudflare-access' });
    assert.equal(session.body.user.username, 'owner@example.com');
    assert.ok(session.body.user.id.startsWith('external:cloudflare-access:'));
    assert.notEqual(session.body.user.id, seeded.body.id);
    assert.equal(session.res.headers.get('set-cookie'), null);

    // Email-only header without JWT must be rejected
    const emailOnly = await req(mf, '/api/monitors', {
      headers: { 'cf-access-authenticated-user-email': 'owner@example.com' },
    });
    assert.equal(emailOnly.res.status, 401);

    // Admin routes work with verified JWT and fail without it or with cross-origin write
    assert.equal((await req(mf, '/api/monitors', { headers: { 'cf-access-jwt-assertion': validJwt } })).res.status, 200);
    assert.equal((await req(mf, '/api/groups', {
      method: 'POST',
      headers: { origin: 'https://evil.example.test', 'content-type': 'application/json', 'cf-access-jwt-assertion': validJwt },
      body: JSON.stringify({ name: 'bad-origin' }),
    })).res.status, 403);
    assert.equal((await req(mf, '/api/groups', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-access-jwt-assertion': validJwt },
      body: JSON.stringify({ name: 'cf-access-group' }),
    })).res.status, 201);

    // JWKS cached after first verification
    assert.equal((await req(mf, '/__jwks')).body.calls, 1);
    assert.equal((await req(mf, '/api/monitors', { headers: { 'cf-access-jwt-assertion': validJwt } })).res.status, 200);
    assert.equal((await req(mf, '/__jwks')).body.calls, 1);

    // External identity cannot mutate local username/password
    const accountEdit = await req(mf, '/api/auth/account', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-access-jwt-assertion': validJwt },
      body: JSON.stringify({ current: 'fixture-owner-secret', username: 'hijack' }),
    });
    assert.equal(accountEdit.res.status, 403);
    assert.equal(accountEdit.body.error, 'external_account_managed');

    // External identity avatar upload/read/delete works without hitting users FK constraints
    const avatarUp = await req(mf, '/api/auth/avatar', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'image/png', 'cf-access-jwt-assertion': validJwt },
      body: png,
    });
    assert.equal(avatarUp.res.status, 200);
    assert.equal(avatarUp.body.uploaded, true);
    const db = await mf.getD1Database('DB');
    const liveState = { 'avatar-test-monitor': { status: 'up', ts: 100 } };
    const avatarId = 'external-avatar:' + session.body.user.id;
    await db.prepare('INSERT INTO live_state (id, json, updated_at) VALUES (?, ?, ?)')
      .bind('all', JSON.stringify(liveState), 100).run();
    await db.prepare('INSERT INTO live_state (id, json, updated_at) VALUES (?, ?, ?)')
      .bind('external-avatar:external:other-user', '{"version":"other"}', 100).run();
    assert.deepEqual((await req(mf, '/__live')).body, liveState);
    assert.ok(await db.prepare('SELECT json FROM live_state WHERE id = ?').bind(avatarId).first());
    const avatarRead = await req(mf, '/api/auth/avatar', { headers: { 'cf-access-jwt-assertion': validJwt } });
    assert.equal(avatarRead.body.uploaded, true);
    const avatarDel = await req(mf, '/api/auth/avatar', {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(avatarDel.res.status, 200);
    assert.equal(await db.prepare('SELECT json FROM live_state WHERE id = ?').bind(avatarId).first(), null);
    assert.ok(await db.prepare('SELECT json FROM live_state WHERE id = ?').bind('external-avatar:external:other-user').first());
    assert.deepEqual((await req(mf, '/__live')).body, liveState);

    // Reject invalid claims, wrong signature, alg:none, service token, non-allowlisted email, and duplicate headers
    const now = Math.floor(Date.now() / 1000);
    for (const [label, overrides, signingKey, header] of [
      ['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }, key1.privateKey, {}],
      ['wrong audience', { aud: ['other-aud'] }, key1.privateKey, {}],
      ['expired', { exp: now - 10 }, key1.privateKey, {}],
      ['missing exp', { exp: undefined }, key1.privateKey, {}],
      ['future nbf', { nbf: now + 120 }, key1.privateKey, {}],
      ['future iat', { iat: now + 120 }, key1.privateKey, {}],
      ['service token', { type: 'service' }, key1.privateKey, {}],
      ['empty sub', { sub: '' }, key1.privateKey, {}],
      ['empty email', { email: '' }, key1.privateKey, {}],
      ['not allowlisted', { email: 'stranger@example.com' }, key1.privateKey, {}],
      ['wrong signature', {}, key2.privateKey, { kid: 'kid-1' }],
      ['alg none', {}, key1.privateKey, { alg: 'none' }],
      ['unknown kid in cooldown', {}, key1.privateKey, { kid: 'unknown-kid' }],
    ]) {
      const claims = { ...baseClaims(), ...overrides };
      if (overrides.exp === undefined && 'exp' in overrides) delete claims.exp;
      const token = header.alg === 'none'
        ? `${b64url(JSON.stringify({ alg: 'none', kid: 'kid-1' }))}.${b64url(JSON.stringify(claims))}.`
        : await signJwt(claims, signingKey, header);
      const res = await req(mf, '/api/monitors', { headers: { 'cf-access-jwt-assertion': token } });
      assert.equal(res.res.status, 401, `expected 401 for ${label}`);
    }

    // Duplicate JWT headers combined by Fetch Headers or sent separately must be rejected
    const dupHeaders = new Headers();
    dupHeaders.append('cf-access-jwt-assertion', validJwt);
    dupHeaders.append('cf-access-jwt-assertion', validJwt);
    assert.equal((await req(mf, '/api/monitors', { headers: dupHeaders })).res.status, 401);
    assert.equal((await req(mf, '/__jwks')).body.calls, 1, 'unknown kid during cooldown must not hammer JWKS');

    // Logout sets polaris_external_logout=1 and suppresses auto external auth; /api/auth/external clears it
    const logout = await req(mf, '/api/auth/logout', {
      method: 'POST',
      headers: { origin: ORIGIN, 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(logout.res.status, 200);
    const setCookies = logout.res.headers.getSetCookie?.() ?? [logout.res.headers.get('set-cookie') ?? ''];
    const extLogoutCookie = setCookies.find((c) => c.startsWith('polaris_external_logout=1'));
    assert.ok(extLogoutCookie, 'logout must set polaris_external_logout=1');
    const logoutCookiePair = extLogoutCookie.split(';')[0];

    const suppressedSession = await req(mf, '/api/auth/session', {
      headers: { cookie: logoutCookiePair, 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(suppressedSession.body.authenticated, false);
    assert.equal(suppressedSession.body.authentication, null);
    assert.deepEqual(suppressedSession.body.externalAuth, { mode: 'cloudflare-access' });
    assert.equal((await req(mf, '/api/monitors', {
      headers: { cookie: logoutCookiePair, 'cf-access-jwt-assertion': validJwt },
    })).res.status, 401);

    // Cross-origin /api/auth/external is rejected
    assert.equal((await req(mf, '/api/auth/external', {
      method: 'POST',
      headers: { origin: 'https://evil.example.test', cookie: logoutCookiePair, 'cf-access-jwt-assertion': validJwt },
    })).res.status, 403);

    // Invalid JWT on /api/auth/external returns 401
    assert.equal((await req(mf, '/api/auth/external', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: logoutCookiePair },
    })).res.status, 401);

    // Valid JWT on /api/auth/external clears suppression cookie and restores external login
    const resume = await req(mf, '/api/auth/external', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: logoutCookiePair, 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(resume.res.status, 200);
    const clearedCookie = resume.res.headers.get('set-cookie') ?? '';
    assert.match(clearedCookie, /polaris_external_logout=;.*Max-Age=0/);

    const resumedSession = await req(mf, '/api/auth/session', {
      headers: { 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(resumedSession.body.authenticated, true);
    assert.equal(resumedSession.body.authentication, 'cloudflare-access');

    // Local login & ADMIN_TOKEN bearer still work as recovery fallback
    const localLogin = await req(mf, '/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'fixture-owner', password: 'fixture-owner-secret' }),
    });
    assert.equal(localLogin.res.status, 200);
    const localCookie = (localLogin.res.headers.get('set-cookie') ?? '').split(';')[0];
    const localSession = await req(mf, '/api/auth/session', {
      headers: { cookie: localCookie, 'cf-access-jwt-assertion': validJwt },
    });
    assert.equal(localSession.body.authentication, 'local');
    assert.equal(localSession.body.user.username, 'fixture-owner');

    const bearerSession = await req(mf, '/api/auth/session', {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(bearerSession.body.authenticated, true);
    assert.equal(bearerSession.body.authentication, 'bearer');
    assert.equal(bearerSession.body.user, null);

    const configureJwks = (body) => req(mf, '/__jwks', { method: 'POST', body: JSON.stringify(body) });
    const verifyBatch = async (tokens, nowSec) => (await req(mf, '/__verify-batch', {
      method: 'POST', body: JSON.stringify({ tokens, nowSec }),
    })).body;
    const fetchedAt = Math.floor(Date.now() / 1000);
    const rotatedJwt = await signJwt(baseClaims(), key2.privateKey, { kid: 'kid-2' });
    const unknownJwt = await signJwt(baseClaims(), key1.privateKey, { kid: 'missing-kid' });
    await configureJwks({ keys: [key1.jwk], reset: true, delayMs: 25 });
    assert.deepEqual(await verifyBatch([validJwt, validJwt, unknownJwt], fetchedAt), [true, true, false]);
    assert.equal((await req(mf, '/__jwks')).body.calls, 1);

    await configureJwks({ keys: [key2.jwk] });
    assert.deepEqual(await verifyBatch([rotatedJwt, rotatedJwt], fetchedAt + 1), [false, false]);
    assert.equal((await req(mf, '/__jwks')).body.calls, 1, 'cooldown must still reject unknown kids');
    assert.deepEqual(await verifyBatch([rotatedJwt, rotatedJwt, validJwt, unknownJwt], fetchedAt + 10), [true, true, true, false]);
    assert.equal((await req(mf, '/__jwks')).body.calls, 2, 'rotation must share one fetch');
    assert.deepEqual(await verifyBatch([validJwt], fetchedAt + 11), [false], 'nonempty JWKS replaces removed keys');

    await configureJwks({ keys: [] });
    assert.deepEqual(await verifyBatch([validJwt, validJwt], fetchedAt + 20), [false, false]);
    assert.deepEqual(await verifyBatch([rotatedJwt], fetchedAt + 21), [true], 'empty JWKS must retain cached keys');
    assert.equal((await req(mf, '/__jwks')).body.calls, 3);

    await configureJwks({ unavailable: true });
    assert.deepEqual(await verifyBatch([validJwt, validJwt], fetchedAt + 30), [false, false]);
    assert.deepEqual(await verifyBatch([rotatedJwt], fetchedAt + 30), [true], 'failed JWKS must retain cached keys');
    assert.equal((await req(mf, '/__jwks')).body.calls, 4, 'failed refresh must be shared');

    await configureJwks({ unavailable: false, keys: [key1.jwk, key2.jwk] });
    assert.deepEqual(await verifyBatch([validJwt], fetchedAt + 31), [false]);
    assert.equal((await req(mf, '/__jwks')).body.calls, 4, 'failed refresh must keep cooldown');
    assert.deepEqual(await verifyBatch([validJwt, rotatedJwt, validJwt], fetchedAt + 40), [true, true, true]);
    assert.equal((await req(mf, '/__jwks')).body.calls, 5, 'failed in-flight fetch must clear for recovery');

    await configureJwks({ unavailable: true, reset: true });
    assert.deepEqual(await verifyBatch([rotatedJwt, rotatedJwt], fetchedAt + 50), [false, false]);
    assert.equal((await req(mf, '/__jwks')).body.calls, 1);
    console.log('PASS Worker Cloudflare Access JWT, concurrent cold start/rotation, JWKS recovery, avatar isolation, logout and local fallback');
  } finally {
    await mf.dispose();
  }
}

// 2. Worker explicitly rejects trusted-header even if configured
{
  const mf = worker({
    AUTH_MODE: 'trusted-header',
    AUTH_ALLOWED_IDENTITIES: 'owner@example.com',
  });
  try {
    await applyD1Migrations(await mf.getD1Database('DB'));
    await req(mf, '/__setup-owner');
    const session = await req(mf, '/api/auth/session', {
      headers: { 'remote-user': 'owner@example.com', 'cf-access-authenticated-user-email': 'owner@example.com' },
    });
    assert.equal(session.body.authenticated, false);
    assert.equal(session.body.externalAuth, null);
    assert.equal((await req(mf, '/api/monitors', {
      headers: { 'remote-user': 'owner@example.com' },
    })).res.status, 401);
    assert.equal((await req(mf, '/api/auth/external', {
      method: 'POST',
      headers: { origin: ORIGIN, 'remote-user': 'owner@example.com' },
    })).res.status, 404);
    console.log('PASS Worker explicitly rejects trusted-header external auth');
  } finally {
    await mf.dispose();
  }
}

clearTimeout(watchdog);
console.log('Worker external auth tests passed');
