// 验证账号会话、登录限制与管理认证。
// Check account sessions, login limits, and administrator authentication.

import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/**
 * Password hashing and session tests.
 *
 * Run: node test/auth/auth.test.mjs
 * 密码哈希和会话测试。运行：node test/auth/auth.test.mjs。
 */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';

const watchdog = setTimeout(() => {
  console.error('FAIL auth fixture timed out before completion');
  process.exit(2);
}, 60_000);

const HARNESS = `
import {
  hashPassword, verifyPassword, PBKDF2_ITERATIONS, pbkdf2Iterations,
  createSession, resolveSession, deleteSession, sha256Hex,
  parseCookies, sessionCookie, clearSessionCookie, isSecureRequest,
} from './backends/worker/src/lib/auth/service.ts';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const out = {};

    try {
      if (url.pathname === '/iteration-policy') {
        let rejectsOverCap = false;
        try { pbkdf2Iterations({ PBKDF2_ITERATIONS: '100001' }); }
        catch (e) { rejectsOverCap = /1 to 100000/.test(String(e && e.message || e)); }
        return Response.json({
          defaultIsConfigured: PBKDF2_ITERATIONS === 3000,
          acceptsCap: pbkdf2Iterations({ PBKDF2_ITERATIONS: '100000' }) === 100000,
          rejectsOverCap,
          rejectsInvalid: (() => { try { pbkdf2Iterations({ PBKDF2_ITERATIONS: '1.5' }); return false; } catch { return true; } })(),
        });
      }

      if (url.pathname === '/roundtrip') {
        const hash = await hashPassword('s3cret-passphrase');
        out.matchesCorrect = (await verifyPassword('s3cret-passphrase', hash)).ok;
        out.rejectsWrong = !(await verifyPassword('wrong', hash)).ok;
        // Case and whitespace must matter - a password is not a username.
        // 密码不是用户名，大小写和空格必须参与比较。
        out.rejectsCaseChange = !(await verifyPassword('S3cret-passphrase', hash)).ok;
        out.rejectsEmpty = !(await verifyPassword('', hash)).ok;
        out.needsRehashWhenOlder = (
          await verifyPassword('s3cret-passphrase', await hashPassword('s3cret-passphrase', 1000))
        ).needsRehash;
        out.noRehashWhenCurrent = !(await verifyPassword('s3cret-passphrase', hash)).needsRehash;
        // Two hashes of the same password must differ (random salt).
        // 同一密码的两次哈希应因随机盐而不同。
        out.salted = hash !== (await hashPassword('s3cret-passphrase'));
        out.formatOk = /^pbkdf2\\$\\d+\\$[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+$/.test(hash);
        return Response.json(out);
      }

      if (url.pathname === '/malformed') {
        // A corrupt or truncated hash must fail closed, never throw and never
        // be treated as a match.
        // 损坏或截断的哈希必须安全失败，不抛错也不匹配。
        const cases = ['', 'not-a-hash', 'pbkdf2$abc$x$y', 'pbkdf2$0$AA$AA', 'pbkdf2$1000$!!!$!!!', 'bcrypt$1000$AA$AA'];
        out.allRejected = true;
        for (const c of cases) {
          try {
            const r = await verifyPassword('anything', c);
            if (r.ok) { out.allRejected = false; out.bad = c; }
          } catch (e) {
            out.allRejected = false;
            out.threw = c + ': ' + String(e && e.message || e);
          }
        }
        return Response.json(out);
      }

      if (url.pathname === '/session') {
        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until) VALUES (?,?,?,?,?,0,0)'
        ).bind(id, 'tester', await hashPassword('pw'), 1, 1).run();

        const { token } = await createSession(env, id, 'test-agent/1.0');
        out.resolvesToUser = (await resolveSession(env, token))?.username === 'tester';
        out.rejectsUnknown = (await resolveSession(env, 'not-a-real-token')) === null;
        out.rejectsEmpty = (await resolveSession(env, '')) === null;
        // The raw token must never be stored.
        // 原始令牌不得存储。
        out.tokenNotStored = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(token).first()).n === 0;
        out.hashStored = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).first()).n === 1;
        out.carriesUserAgent = (await env.DB.prepare('SELECT user_agent FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).first()).user_agent === 'test-agent/1.0';

        // Expiry is enforced, and the dead row is removed on encounter.
        // 强制执行过期时间，遇到过期行时将其删除。
        await env.DB.prepare('UPDATE sessions SET expires_at = 1 WHERE token_hash = ?').bind(await sha256Hex(token)).run();
        out.expiredRejected = (await resolveSession(env, token)) === null;
        out.expiredRowPurged = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).first()).n === 0;

        // Deleting a session invalidates it immediately (the point of
        // server-side sessions over a signed token).
        // 删除会话立即使其失效，这是服务端会话相对签名令牌的优势。
        const s2 = await createSession(env, id, null);
        await deleteSession(env, s2.token);
        out.deletedRejected = (await resolveSession(env, s2.token)) === null;

        return Response.json(out);
      }

      if (url.pathname === '/cookies') {
        const parsed = parseCookies('a=1; polaris_session=abc%20def; empty=; malformed=%E0%A4%A');
        out.parsesSimple = parsed.a === '1';
        out.decodesValue = parsed.polaris_session === 'abc def';
        out.handlesEmpty = parsed.empty === '';
        out.survivesBadEscape = typeof parsed.malformed === 'string';
        out.nullHeader = Object.keys(parseCookies(null)).length === 0;

        const c = sessionCookie('tok', 100, true);
        out.cookieFlags = ['HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/', 'Max-Age=100'].every((f) => c.includes(f));
        // Secure must be omitted on http or the browser silently drops it.
        // HTTP 下必须省略 Secure，否则浏览器会静默丢弃 cookie。
        out.noSecureOnHttp = !sessionCookie('tok', 100, false).includes('Secure');
        out.clearExpires = clearSessionCookie(true).includes('Max-Age=0');
        out.secureDetection = isSecureRequest('https://x.dev/a') && !isSecureRequest('http://x.dev/a');
        return Response.json(out);
      }

      return new Response('unknown', { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e && e.stack || e) }, { status: 500 });
    }
  },
};
`;

async function harness() {
  const built = await build({
    stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    // Workers-only module; stubbed so esbuild does not try to resolve it.
    // 此模块仅供 Workers 使用，替换为测试桩以防 esbuild 尝试解析。
    plugins: [
      {
        name: 'stub-sockets',
        setup(b) {
          b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'stub' }));
          b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const connect = () => { throw new Error("no sockets"); };' }));
          b.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
            contents: `export default function postgres() { throw new Error('postgres is stubbed in this test bundle'); }`,
          }));
        },
      },
    ],
  });

  const mf = new Miniflare({
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: '2025-01-01',
    d1Databases: { DB: 'auth-test' },
  });

  // Apply the real migrations rather than a copy: the schema is then exercised
  // as it ships, so a syntax error here is the same one production would hit.
  // 应用真实迁移而非副本，以实际发布的 schema 测试；此处语法错误与生产环境遇到的相同。
  const db = await mf.getD1Database('DB');
  console.log('CHECKPOINT auth: isolated D1 binding ready');
  const migrationFiles = readdirSync('database/schema/d1')
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await applyD1Migrations(db);

  return mf;
}

// --- tiny assertion runner -------------------------------------------------
// 简易断言执行器 / Tiny assertion runner

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const mf = await harness();
const call = async (path) => {
  const res = await mf.dispatchFetch(`http://localhost${path}`);
  const body = await res.json();
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

console.log('\niteration configuration\n');
const iterations = await call('/iteration-policy');
for (const [key, value] of Object.entries(iterations)) check(key, value === true, value);

console.log('\npassword hashing\n');
const rt = await call('/roundtrip');
for (const [k, v] of Object.entries(rt)) check(k, v === true || typeof v === 'boolean' ? v : Boolean(v), v);

console.log('\nmalformed hashes fail closed\n');
const mal = await call('/malformed');
check('every malformed hash is rejected without throwing', mal.allRejected, mal);

console.log('\nsessions\n');
const sess = await call('/session');
for (const [k, v] of Object.entries(sess)) check(k, v === true, v);

console.log('\ncookies\n');
const ck = await call('/cookies');
for (const [k, v] of Object.entries(ck)) check(k, v === true, v);

await mf.dispose();
clearTimeout(watchdog);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
