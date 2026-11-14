

import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { readBoundedBody } from '../http/binary';
import { parseTargetUrl } from '../db/data-migration';
import { bootstrapSchema } from '../db/bootstrap';
import { getDB, withSelectedDatabase } from '../db/factory';
import { databaseType, deployedDatabaseType } from '../db/setup-control';
import { initializePostgres } from '../db/setup-postgres';
import { abandonDatabaseClaim, claimDatabase, completedOperation, d1HasUsers, databaseClaimActive, deployedDatabase, discardPendingDatabase, finishDatabaseClaim, markAccountStarted, pendingDatabase, pendingDatabaseUrl, releaseDatabaseClaim, resetAccountStarted, saveDatabaseConfiguration, setupDatabaseOptions } from '../db/setup-control';
import { visibilityRevisionWrite } from '../public/cache';
import { MAX_AVATAR_BYTES, readAvatarImage, readAvatarInfo, removeAvatar, validAvatarImage, writeAvatar } from './avatar';
import { databaseConfigured, setupRequirements } from './setup-requirements';
import {
  clearFailures,
  clearLoginAttempts,
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  findUser,
  finishSetup,
  hashPassword,
  isLocked,
  isSecureRequest,
  isSetupRequired,
  normalizeUsername,
  parseCookies,
  pbkdf2Iterations,
  recordFailure,
  renameUser,
  reserveLoginAttempt,
  resolveSession,
  safeEqual,
  SESSION_COOKIE,
  sessionCookie,
  setPassword,
  sha256Hex,
  verifyPassword,
  type User,
} from './service';

/** 初始化账号、登录会话及账号资料接口。 / Endpoints for account setup, login sessions, and account details. */
export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.use('/api/auth/*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  c.header('Pragma', 'no-cache');
  await next();
});

function isObjectBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


export function installationCredentialSource(env: Env): 'ADMIN_TOKEN' | null {
  return env.ADMIN_TOKEN ? 'ADMIN_TOKEN' : null;
}

function installationCredential(env: Env): string {
  return env.ADMIN_TOKEN || '';
}

function iterationsConfigured(env: Env): boolean {
  try {
    pbkdf2Iterations(env);
    return true;
  } catch {
    return false;
  }
}

/** Hash a dummy password when the user is missing: the ~1 ms vs ~8 ms gap
 * would otherwise enumerate accounts regardless of the response body.
 * 用户不存在时也校验假哈希，抹平时间差。 */
let dummyHashCache: Promise<string> | null = null;
function dummyHash(env: Env): Promise<string> {
  dummyHashCache ??= hashPassword('placeholder-for-timing-equalisation', pbkdf2Iterations(env));
  return dummyHashCache;
}

/** Read the session cookie and resolve it. / 读取并解析会话 Cookie。 */
async function currentUser(c: { req: { header: (n: string) => string | undefined }; env: Env }) {
  const cookies = parseCookies(c.req.header('cookie'));
  const token = cookies[SESSION_COOKIE];
  if (!token) return { user: null, token: null as string | null };
  return { user: await resolveSession(c.env, token), token };
}

export { currentUser };

// ---------------------------------------------------------------- session
// ---------------------------------------------------------------- 会话 / session

/** Session state; always 200 even when anonymous. A 401 would be
 * indistinguishable from a broken endpoint and the SPA guard would render an
 * error instead of the login page.
 * 会话状态始终 200，让守卫区分匿名和故障。 */
authRoutes.get('/api/auth/session', async (c) => {
  // A machine token is reported as an authenticated principal with no username,
  // so scripts and the SPA can share one endpoint.
  // 机器令牌报告为没有用户名的已认证主体，使脚本和 SPA 可以共用端点。
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const machine = Boolean(c.env.ADMIN_TOKEN) && safeEqual(token, c.env.ADMIN_TOKEN);

  // 无数据库时仍返回选库选项，连接配置在初始化表单中校验。
  // Offer database choices before a connection exists; validate it on the setup form.
  if (!databaseConfigured(c.env)) {
    return c.json({
      authenticated: machine,
      user: null,
      needsSetup: true,
      setupCredential: installationCredentialSource(c.env),
      setupDatabase: await setupDatabaseOptions(c.env),
      setupRequirements: setupRequirements(c.env),
    });
  }

  const needsSetup = await pendingDatabase(c.env) || await isSetupRequired(c.env);
  const { user } = needsSetup ? { user: null } : await currentUser(c);

  return c.json({
    authenticated: Boolean(user) || machine,
    user: user ? { id: user.id, username: user.username } : null,
    needsSetup,
    /** Name of the setup secret, never its value; suppressed after setup. / 初始化密钥的名称，不返回值；初始化后不再返回。 */
    setupCredential: needsSetup ? installationCredentialSource(c.env) : null,
    setupDatabase: needsSetup ? await setupDatabaseOptions(c.env) : null,
    setupRequirements: needsSetup ? setupRequirements(c.env) : null,
  });
});

async function setupSelection(env: Env, selection: unknown, allowChange = false) {
  const pending = await pendingDatabase(env);
  if (selection !== undefined && !isObjectBody(selection)) throw new Error('invalid_database_type');
  const type = selection === undefined ? databaseType(env) : selection.type;
  if (type !== 'd1' && type !== 'postgres' || type === 'd1' && !env.DB) throw new Error('invalid_database_type');
  if (selection && selection.url !== undefined && typeof selection.url !== 'string') throw new Error('invalid_database_url');
  const suppliedUrl = selection && typeof selection.url === 'string' ? selection.url.trim() : '';
  const deployed = deployedDatabase(env);
  let savedUrl: string | undefined;
  if (pending && type === 'postgres') {
    try { savedUrl = await pendingDatabaseUrl(env); } catch { throw new Error('database_configuration_failed'); }
  }
  if (type === 'd1' && suppliedUrl) throw new Error('invalid_database_url');
  if (suppliedUrl && !env.CONFIG) throw new Error('invalid_database_url');
  let url: string | undefined;
  if (type === 'postgres') {
    if (suppliedUrl) {
      try { url = parseTargetUrl(suppliedUrl, true); } catch { throw new Error('invalid_database_url'); }
    } else if (pending && databaseType(env) === 'postgres' && savedUrl) {
      url = savedUrl;
    } else if (deployedDatabaseType(env) === 'postgres' && deployed.DATABASE_URL) {
      url = deployed.DATABASE_URL;
    } else throw new Error('invalid_database_url');
  }
  const changed = pending && (type !== databaseType(env) || type === 'postgres' && url !== savedUrl);
  if (changed && !allowChange) throw new Error('setup_in_progress');

  return { type: type as 'd1' | 'postgres', url, deployed, changed };
}

authRoutes.post('/api/auth/setup/database', async (c) => {
  if (!c.env.UPTIME) return c.json({ error: 'deployment_incomplete' }, 503);
  let body: unknown;
  try { body = await c.req.json<unknown>(); } catch { return c.json({ error: 'invalid_request' }, 400); }
  if (!isObjectBody(body)) return c.json({ error: 'invalid_request' }, 400);
  const expected = installationCredential(c.env);
  if (!expected) return c.json({ error: 'credential_unconfigured' }, 503);
  if (typeof body.credential !== 'string' || !safeEqual(body.credential, expected)) return c.json({ error: 'invalid_setup_credential' }, 401);
  const pending = await pendingDatabase(c.env);
  if (await databaseClaimActive(c.env) || !pending && await d1HasUsers(c.env)) return c.json({ error: 'setup_complete' }, 409);
  if (!pending && databaseConfigured(c.env)) {
    try { if (!await isSetupRequired(c.env)) return c.json({ error: 'setup_complete' }, 409); }
    catch { return c.json({ error: 'database_connection_failed' }, 503); }
  }
  let selected: Awaited<ReturnType<typeof setupSelection>>;
  try { selected = await setupSelection(c.env, body.database, true); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'database_configuration_failed';
    return c.json({ error: code }, code === 'database_configuration_failed' ? 503 : 400);
  }
  if (selected.changed && !await discardPendingDatabase(c.env)) return c.json({ error: 'setup_in_progress' }, 409);
  const { type, url } = selected;
  let failure = 'database_connection_failed';
  try {
    return await withSelectedDatabase(c.env, { DATABASE_TYPE: type, DATABASE_URL: url }, async (targetEnv) => {
      await getDB(targetEnv).queryOne('SELECT 1 AS n');
      failure = 'database_initialization_failed';
      if (type === 'postgres') await initializePostgres(targetEnv);
      else await bootstrapSchema(targetEnv);
      failure = 'database_configuration_failed';
      const claim = await claimDatabase(targetEnv, type, url);
      if (!claim) return c.json({ error: await isSetupRequired(targetEnv) ? 'setup_in_progress' : 'setup_complete' }, 409);
      try {
        if (!claim.accountStarted && !await isSetupRequired(targetEnv)) {
          await abandonDatabaseClaim(targetEnv, claim.operation, claim.lease);
          return c.json({ error: 'setup_complete' }, 409);
        }
        const configurationId = await saveDatabaseConfiguration(targetEnv);
        await releaseDatabaseClaim(targetEnv, claim.operation, claim.lease);
        return c.json({ ok: true, type, ...(configurationId ? { configurationId } : {}) });
      } catch (error) {
        if (claim.accountStarted) await releaseDatabaseClaim(targetEnv, claim.operation, claim.lease);
        else await abandonDatabaseClaim(targetEnv, claim.operation, claim.lease);
        throw error;
      }
    });
  } catch {
    return c.json({ error: failure }, 503);
  }
});

authRoutes.post('/api/auth/setup', async (c) => {
  if (!c.env.UPTIME) return c.json({ error: 'deployment_incomplete' }, 503);
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (!isObjectBody(body)) return c.json({ error: 'invalid_request' }, 400);
  if (!iterationsConfigured(c.env)) {
    return c.json({ error: 'invalid_auth_config', message: 'PBKDF2_ITERATIONS must be an integer from 1 to 100000' }, 503);
  }

  const credential = typeof body.credential === 'string' ? body.credential : '';
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const expected = installationCredential(c.env);

  /** No setup secret is bound; distinct from a wrong credential. / 没有配置初始化密钥；与凭据错误区分。 */
  if (!expected) return c.json({ error: 'credential_unconfigured' }, 503);
  if (!safeEqual(credential, expected)) return c.json({ error: 'invalid_setup_credential' }, 401);
  if (!normalizeUsername(username)) return c.json({ error: 'invalid_username' }, 400);
  if (password.length < 8) return c.json({ error: 'password_too_short' }, 400);
  const pending = await pendingDatabase(c.env);
  if (!pending && await databaseClaimActive(c.env)) return c.json({ error: 'setup_complete' }, 409);
  if (!pending && databaseConfigured(c.env)) {
    try {
      if (!(await isSetupRequired(c.env)) || await d1HasUsers(c.env)) return c.json({ error: 'setup_complete' }, 409);
    } catch {
      return c.json({ error: 'database_connection_failed' }, 503);
    }
  }

  if (!pending && c.env.DB && databaseType(c.env) === 'postgres') {
    try {
      const stateExists = await c.env.DB.prepare("SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = 'auth_setup_state'").first();
      if (stateExists && await c.env.DB.prepare('SELECT 1 AS n FROM auth_setup_state WHERE completed = 1 LIMIT 1').first()) return c.json({ error: 'setup_complete' }, 409);
    } catch {
      return c.json({ error: 'database_initialization_failed' }, 503);
    }
  }

  let selected: Awaited<ReturnType<typeof setupSelection>>;
  try { selected = await setupSelection(c.env, body.database); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'database_configuration_failed';
    return c.json({ error: code }, code === 'setup_in_progress' ? 409 : code === 'database_configuration_failed' ? 503 : 400);
  }
  const { type, url } = selected;
  let failure: 'database_connection_failed' | 'database_initialization_failed' | 'database_configuration_failed' = 'database_connection_failed';
  try {
    return await withSelectedDatabase(c.env, { DATABASE_TYPE: type, DATABASE_URL: url }, async (targetEnv) => {
      const db = getDB(targetEnv);
      await db.queryOne('SELECT 1 AS n');
      failure = 'database_initialization_failed';
      if (type === 'postgres') await initializePostgres(targetEnv);
      else await bootstrapSchema(targetEnv);
      failure = 'database_configuration_failed';
      const claim = await claimDatabase(targetEnv, type, url);
      if (!claim) return c.json({ error: await isSetupRequired(targetEnv) ? 'setup_in_progress' : 'setup_complete' }, 409);
      let accountWriteStarted = claim.accountStarted;
      try {
        await saveDatabaseConfiguration(targetEnv);
        let userId: string | null;
        if (await isSetupRequired(targetEnv)) {
          await markAccountStarted(targetEnv, claim.operation, claim.lease);
          accountWriteStarted = true;
          failure = 'database_initialization_failed';
          userId = await finishSetup(targetEnv, username, password, claim.operation);
          if (!userId) {
            failure = 'database_configuration_failed';
            await resetAccountStarted(targetEnv, claim.operation, claim.lease);
            accountWriteStarted = false;
          }
        } else {
          const operationUser = await db.queryOne<{ id: string }>(type === 'postgres' ? 'SELECT id FROM users WHERE id = $1' : 'SELECT id FROM users WHERE id = ?', [claim.operation]);
          if (!operationUser) {
            await resetAccountStarted(targetEnv, claim.operation, claim.lease);
            accountWriteStarted = false;
            await abandonDatabaseClaim(targetEnv, claim.operation, claim.lease);
            return c.json({ error: 'setup_complete' }, 409);
          }
          const existing = await findUser(targetEnv, username);
          userId = existing?.id === claim.operation && (await verifyPassword(password, existing.password_hash, pbkdf2Iterations(targetEnv))).ok ? existing.id : null;
        }
        if (!userId) {
          if (accountWriteStarted) await releaseDatabaseClaim(targetEnv, claim.operation, claim.lease);
          else await abandonDatabaseClaim(targetEnv, claim.operation, claim.lease);
          return c.json({ error: 'setup_complete' }, 409);
        }
        const session = await createSession(targetEnv, userId, c.req.header('user-agent') ?? null);
        const revision = visibilityRevisionWrite(Math.floor(Date.now() / 1000), type === 'postgres');
        await db.execute(revision.sql, revision.params);
        failure = 'database_configuration_failed';
        try { await finishDatabaseClaim(targetEnv, claim.operation, claim.lease); }
        catch { if (!await completedOperation(targetEnv, claim.operation)) throw new Error('database_configuration_failed'); }
        c.header('set-cookie', sessionCookie(session.token, session.expiresAt - Math.floor(Date.now() / 1000), isSecureRequest(c.req.url)));
        return c.json({ ok: true, user: { id: userId, username: username.trim().toLowerCase() } });
      } catch (error) {
        try {
          if (accountWriteStarted) await releaseDatabaseClaim(targetEnv, claim.operation, claim.lease);
          else await abandonDatabaseClaim(targetEnv, claim.operation, claim.lease);
        } catch { failure = 'database_configuration_failed'; }
        throw error;
      }
    });
  } catch {
    return c.json({ error: failure }, 503);
  }
});

// ---------------------------------------------------------------- login
// ---------------------------------------------------------------- 登录 / login

authRoutes.post('/api/auth/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (!isObjectBody(body)) return c.json({ error: 'invalid_request' }, 400);
  if (!iterationsConfigured(c.env)) {
    return c.json({ error: 'invalid_auth_config', message: 'PBKDF2_ITERATIONS must be an integer from 1 to 100000' }, 503);
  }

  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  // One generic failure for every cause, so the response never distinguishes
  // "no such user" from "bad password" from "locked".
  // 所有原因使用同一个通用失败响应，不区分“用户不存在”“密码错误”和“账户锁定”。
  const INVALID = { error: 'invalid_credentials' };

  if (!username || !password) return c.json(INVALID, 401);

  const accountKey = `account:${await sha256Hex(username.toLowerCase())}`;
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const ipKey = `ip:${await sha256Hex(ip)}`;
  let allowed: boolean;
  try {
    allowed = await reserveLoginAttempt(c.env, [ipKey, accountKey]);
  } catch {
    return c.json({ error: 'database_unavailable' }, 503);
  }
  if (!allowed) return c.json(INVALID, 401);

  let user: User | null = null;
  try {
    user = await findUser(c.env, username);
  } catch {
    return c.json({ error: 'database_unavailable' }, 503);
  }

  if (!user) {
    // Pay the same cost as a real verification so the response time does not
    // reveal whether the account exists.
    // 执行与真实验证相同的成本，避免响应时间泄露账户是否存在。
    await verifyPassword(password, await dummyHash(c.env), pbkdf2Iterations(c.env));
    return c.json(INVALID, 401);
  }

  if (isLocked(user)) return c.json(INVALID, 401);

  const { ok, needsRehash } = await verifyPassword(
    password,
    user.password_hash,
    pbkdf2Iterations(c.env),
  );

  if (!ok) {
    await recordFailure(c.env, user);
    return c.json(INVALID, 401);
  }

  await clearFailures(c.env, user.id);
  await clearLoginAttempts(c.env, [accountKey, ipKey]);

  // Rehash on sign-in when the stored iteration count is lower; `chosen: false` keeps the marker. / 登录时按更低成本重哈希；`chosen: false` 保留标记。
  if (needsRehash) {
    try {
      await setPassword(c.env, user.id, password);
    } catch {
      // A failed upgrade must not block a valid login.
      // 哈希升级失败不能阻止有效登录。
    }
  }

  const { token, expiresAt } = await createSession(
    c.env,
    user.id,
    c.req.header('user-agent') ?? null,
  );

  c.header(
    'set-cookie',
    sessionCookie(token, expiresAt - Math.floor(Date.now() / 1000), isSecureRequest(c.req.url)),
  );
  return c.json({
    ok: true,
    user: { id: user.id, username: user.username },
    /** Returned with login so the console can warn about default credentials without another request. / 登录响应一并返回，控制台无需再次请求即可提示默认凭据。 */
    expiresAt,
  });
});

// ---------------------------------------------------------------- logout
// ---------------------------------------------------------------- 退出登录 / logout

authRoutes.post('/api/auth/logout', async (c) => {
  const cookies = parseCookies(c.req.header('cookie'));
  const token = cookies[SESSION_COOKIE];
  if (token) await deleteSession(c.env, token);

  c.header('set-cookie', clearSessionCookie(isSecureRequest(c.req.url)));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- account
// ---------------------------------------------------------------- 账户 / account

authRoutes.get('/api/auth/avatar', async (c) => {
  const { user } = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await readAvatarInfo(c.env, user.id));
});

authRoutes.get('/api/auth/avatar/image', async (c) => {
  const { user } = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const bytes = await readAvatarImage(c.env, user.id);
  if (!bytes) return c.json({ error: 'not_found' }, 404);
  c.header('content-type', 'image/png');
  c.header('x-content-type-options', 'nosniff');
  return c.body(bytes);
});

authRoutes.post('/api/auth/avatar', async (c) => {
  const { user } = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (Number(c.req.header('content-length')) > MAX_AVATAR_BYTES) return c.json({ error: 'too_large' }, 413);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBoundedBody(c.req.raw.body, MAX_AVATAR_BYTES);
  } catch {
    return c.json({ error: 'too_large' }, 413);
  }
  if (!validAvatarImage(bytes)) return c.json({ error: 'avatar_invalid' }, 400);
  return c.json(await writeAvatar(c.env, user.id, bytes));
});

authRoutes.delete('/api/auth/avatar', async (c) => {
  const { user } = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await removeAvatar(c.env, user.id));
});


const changeAccount = async (c: Context<{ Bindings: Env }>) => {
  const { user } = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'invalid_request' }, 400);
  }
  if (!isObjectBody(body)) return c.json({ error: 'invalid_request' }, 400);
  if (!iterationsConfigured(c.env)) {
    return c.json({ error: 'invalid_auth_config', message: 'PBKDF2_ITERATIONS must be an integer from 1 to 100000' }, 503);
  }

  const current = typeof body.current === 'string' ? body.current : '';
  const next = typeof body.next === 'string' ? body.next : '';
  const requestedUsername = typeof body.username === 'string' ? body.username : '';
  const wantsPassword = next.length > 0;
  const wantsUsername = requestedUsername.trim().length > 0;

  if (!wantsPassword && !wantsUsername) return c.json({ error: 'no_change' }, 400);

  // Validate before writing so a rejected request has no side effects. / 写入前校验，拒绝请求无副作用。
  if (wantsPassword && next.length < 8) return c.json({ error: 'password_too_short' }, 400);

  let username: string | null = null;
  if (wantsUsername) {
    username = normalizeUsername(requestedUsername);
    if (!username) return c.json({ error: 'invalid_username' }, 400);
  }

  const stored = await findUser(c.env, user.username);
  if (!stored) return c.json({ error: 'unauthorized' }, 401);

  const { ok } = await verifyPassword(current, stored.password_hash, pbkdf2Iterations(c.env));
  if (!ok) return c.json({ error: 'invalid_credentials' }, 401);

  // Renaming to the current name (after normalisation) is not a conflict. / 改成当前名称（规范化后）不算冲突。
  const renaming = username !== null && username !== stored.username;

  /** Rename first, password second, so a taken name leaves the account unchanged. / 先改名后改密码，名称冲突时账号保持原状。 */
  if (renaming && username !== null) {
    const result = await renameUser(c.env, user.id, username);
    if (result === 'taken') return c.json({ error: 'username_taken' }, 409);
  }

  if (wantsPassword) {
    await setPassword(c.env, user.id, next);
    await deleteUserSessions(c.env, user.id);

    // The session that made the change is gone too, so issue a fresh one rather
    // than leaving the caller with a cookie that no longer resolves.
    // 执行修改的会话也已失效，因此重新签发会话，避免调用方持有无法解析的 Cookie。
    const { token, expiresAt } = await createSession(
      c.env,
      user.id,
      c.req.header('user-agent') ?? null,
    );
    c.header(
      'set-cookie',
      sessionCookie(token, expiresAt - Math.floor(Date.now() / 1000), isSecureRequest(c.req.url)),
    );
  }

  return c.json({
    ok: true,
    username: username ?? stored.username,
  });
};

authRoutes.post('/api/auth/account', changeAccount);
