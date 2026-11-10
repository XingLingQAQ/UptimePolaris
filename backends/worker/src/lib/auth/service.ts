/** Account passwords use PBKDF2-SHA256; session tokens are stored as hashes. Machine clients may use ADMIN_TOKEN. / 账户密码使用 PBKDF2-SHA256；会话令牌以哈希保存。机器客户端可使用 ADMIN_TOKEN。 */

import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { authSQL } from '../db/sql/auth';
import { readAll } from '../settings/store';
import { postgresIsEmpty } from '../db/setup-postgres';

// ---------------------------------------------------------------- constants
// ---------------------------------------------------------------- 常量 / constants

/** Local timings do not establish production CPU capacity. / 本地耗时不能证明生产环境的 CPU 容量。 */
const DEFAULT_PBKDF2_ITERATIONS = 3_000;

const MAX_PBKDF2_ITERATIONS = 100_000;

export function pbkdf2Iterations(env: Partial<Env>): number {
  const configured = (env as { PBKDF2_ITERATIONS?: string }).PBKDF2_ITERATIONS;
  if (configured === undefined) return DEFAULT_PBKDF2_ITERATIONS;
  const raw = Number(configured);
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2_ITERATIONS must be an integer from 1 to ${MAX_PBKDF2_ITERATIONS}`);
  }
  return raw;
}

/** Default for callers without worker bindings. / 没有 Worker 绑定的调用方使用的默认值。 */
export const PBKDF2_ITERATIONS = DEFAULT_PBKDF2_ITERATIONS;

/** Default session TTL; security.sessionTtlDays controls newly issued sessions. / 默认会话 TTL；security.sessionTtlDays 控制新签发的会话。 */
export const SESSION_TTL_SEC = 60 * 60 * 24 * 14;

export const SESSION_COOKIE = 'polaris_session';

/** Login throttle defaults; keep aligned with security.loginMaxAttempts and security.loginWindowSec in settings.ts. / 登录限流默认值；须与 settings.ts 中的 security.loginMaxAttempts 和 security.loginWindowSec 保持一致。 */
const MAX_FAILED = 8;
const LOCKOUT_SEC = 5 * 60;
const LOGIN_LIMIT_TTL_SEC = 15 * 60;
const LOGIN_LIMIT_PRUNE_INTERVAL_SEC = 5 * 60;
let lastLoginLimitPruneAt = Number.NEGATIVE_INFINITY;

// ---------------------------------------------------------------- encoding
// ---------------------------------------------------------------- 编码 / encoding

const enc = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Hex digest as lowercase base16. / 小写十六进制摘要。 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A 256-bit random token, base64url-safe. / 适用于 base64url 的 256 位随机令牌。 */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- passwords
// ---------------------------------------------------------------- 密码 / passwords

/** Storage format: pbkdf2$<iterations>$<salt-b64>$<hash-b64>; verification uses the embedded parameters. / 存储格式：pbkdf2$<iterations>$<salt-b64>$<hash-b64>；验证使用内嵌参数。 */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );

  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(new Uint8Array(bits))}`;
}

/** Verify with the stored iteration count; currentIterations determines whether the hash needs an upgrade. / 使用存储的迭代次数验证；currentIterations 决定是否需要升级哈希。 */
export async function verifyPassword(
  password: string,
  stored: string,
  currentIterations = PBKDF2_ITERATIONS,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return { ok: false, needsRehash: false };

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return { ok: false, needsRehash: false };

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return { ok: false, needsRehash: false };
  }

  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      expected.length * 8,
    ),
  );

  // Length is public (it is the hash size), so comparing it first is safe.
  // 长度是公开信息（即哈希大小），因此先比较长度是安全的。
  if (bits.length !== expected.length) return { ok: false, needsRehash: false };

  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];

  return { ok: diff === 0, needsRehash: iterations < currentIterations };
}

// ---------------------------------------------------------------- users
// ---------------------------------------------------------------- 用户 / users

export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
  failed_count: number;
  locked_until: number;
}

/** Keep username validation aligned with scripts/db/create-user.mjs. / 用户名验证须与 scripts/db/create-user.mjs 保持一致。 */
export const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;

/** Return a lowercase username, or null when it fails validation. / 返回小写用户名；验证失败时返回 null。 */
export function normalizeUsername(username: string): string | null {
  const normalized = username.trim().toLowerCase();
  return USERNAME_RE.test(normalized) ? normalized : null;
}

/** Usernames are stored and queried in lowercase. / 用户名以小写存储和查询。 */
export async function findUser(env: Env, username: string): Promise<User | null> {
  const db = getDB(env);
  return db.queryOne<User>(authSQL[db.type].findUserByName, [username.trim().toLowerCase()]);
}

export async function countUsers(env: Env): Promise<number> {
  const db = getDB(env);
  const row = await db.queryOne<{ n: number }>(authSQL[db.type].countUsers);
  return row?.n ?? 0;
}

export async function isSetupRequired(env: Env): Promise<boolean> {
  const db = getDB(env);
  if (db.type === 'postgres' && await postgresIsEmpty(env)) return true;
  const row = await db.queryOne<{ completed: number }>(authSQL[db.type].getSetupState);
  return row?.completed === 0 && await countUsers(env) === 0;
}

export async function finishSetup(env: Env, username: string, password: string, operation?: string): Promise<string | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error('invalid_username');
  const id = operation || crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const hash = await hashPassword(password, pbkdf2Iterations(env));
  const db = getDB(env);
  const sql = authSQL[db.type];
  if (db.type === 'd1') {
    const changes = await db.commit([
      { sql: sql.claimSetup, params: [id] },
      { sql: sql.insertFirstUser, params: [id, normalized, hash, now, now, id] },
      { sql: sql.finishSetup, params: [id, id] },
    ]);
    if (changes[0] !== 1 || changes[2] !== 1) return null;
  } else {
    const claimed = await db.transaction(async (tx) => {
      const claim = await tx.execute(sql.claimSetup, [id]);
      if (claim.rowsAffected !== 1) return false;
      const inserted = await tx.execute(sql.insertFirstUser, [id, normalized, hash, now, now]);
      if (inserted.rowsAffected !== 1) throw new Error('setup_conflict');
      await tx.execute(sql.finishSetup, [id]);
      return true;
    });
    if (!claimed) return null;
  }
  return id;
}

export async function createUser(
  env: Env,
  username: string,
  password: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const normalized = normalizeUsername(username);
  if (!normalized) throw new Error('invalid_username');

  const db = getDB(env);
  await db.execute(authSQL[db.type].insertUser, [
    id,
    normalized,
    await hashPassword(password, pbkdf2Iterations(env)),
    now,
    now,
  ]);
  return id;
}

export async function setPassword(
  env: Env,
  userId: string,
  password: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  await db.execute(authSQL[db.type].updatePassword, [
    await hashPassword(password, pbkdf2Iterations(env)),
    now,
    userId,
  ]);
}

/** Recognize unique-constraint errors so concurrent writes can report a taken username. / 识别唯一约束错误，使并发写入能报告用户名已被使用。 */
function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as { message?: string })?.message ?? e));
}

/** Return ok or taken; the database constraint arbitrates concurrent renames. / 返回 ok 或 taken；并发重命名由数据库约束裁决。 */
export async function renameUser(
  env: Env,
  userId: string,
  username: string,
): Promise<'ok' | 'taken'> {
  const normalized = normalizeUsername(username);
  if (!normalized) return 'taken';

  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  try {
    await db.execute(authSQL[db.type].renameUser, [normalized, now, userId]);
  } catch (e) {
    if (isUniqueViolation(e)) return 'taken';
    throw e;
  }
  return 'ok';
}

// ---------------------------------------------------------------- sessions
// ---------------------------------------------------------------- 会话 / sessions

export interface SessionUser {
  id: string;
  username: string;
  /** Include the seeded-password marker in the existing session/user lookup. / 在现有会话和用户查询中包含种子密码标记。 */
}

/** Return a session token and persist only its hash. / 返回会话令牌，仅持久化其哈希。 */
export async function createSession(
  env: Env,
  userId: string,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  /** Read the configured lifetime when issuing each session. / 每次签发会话时读取配置的有效期。 */
  const ttlDays = (await readAll(env)).values['security.sessionTtlDays'] as number;
  const expiresAt = now + (Number.isInteger(ttlDays) && ttlDays > 0 ? ttlDays * 86_400 : SESSION_TTL_SEC);

  const db = getDB(env);
  await db.execute(authSQL[db.type].insertSession, [
    await sha256Hex(token),
    userId,
    now,
    expiresAt,
    userAgent?.slice(0, 200) ?? null,
  ]);

  return { token, expiresAt };
}

/** Resolve the token hash; delete expired sessions encountered by lookup. / 通过令牌哈希查找会话；删除查找时遇到的过期会话。 */
export async function resolveSession(env: Env, token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);

  const db = getDB(env);
  const row = await db.queryOne<{
    expires_at: number;
    id: string;
    username: string;
  }>(authSQL[db.type].resolveSession, [hash]);

  if (!row) return null;

  if (row.expires_at <= now) {
    await db.execute(authSQL[db.type].deleteSessionByHash, [hash]);
    return null;
  }


  return { id: row.id, username: row.username };
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  if (!token) return;
  const db = getDB(env);
  await db.execute(authSQL[db.type].deleteSessionByHash, [await sha256Hex(token)]);
}

/** Drop every session for a user, e.g. after a password change. / 删除用户的所有会话，例如修改密码后。 */
export async function deleteUserSessions(env: Env, userId: string): Promise<void> {
  const db = getDB(env);
  await db.execute(authSQL[db.type].deleteSessionsForUser, [userId]);
}

export async function listSessions(
  env: Env,
  userId: string,
): Promise<Array<{ created_at: number; expires_at: number; user_agent: string | null }>> {
  const db = getDB(env);
  return db.query<{ created_at: number; expires_at: number; user_agent: string | null }>(
    authSQL[db.type].listSessionsForUser,
    [userId],
  );
}

// ---------------------------------------------------------------- throttle
// ---------------------------------------------------------------- 限流 / throttle

/** Increment in SQL so concurrent failures do not lose counter updates. / 在 SQL 中递增，避免并发失败丢失计数更新。 */
export async function recordFailure(env: Env, user: User): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  /** Account lockout and reserveLoginAttempt must use the same throttle settings. / 账户锁定和 reserveLoginAttempt 必须使用相同的限流设置。 */
  const maxAttempts = (await readAll(env)).values['security.loginMaxAttempts'] as number;
  await db.execute(authSQL[db.type].recordFailure, [maxAttempts, now + LOCKOUT_SEC, user.id]);
}

export async function reserveLoginAttempt(env: Env, keys: string[]): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const db = getDB(env);
  /** Read both throttle settings from one registry snapshot. / 从同一注册表快照读取两个限流设置。 */
  const values = (await readAll(env)).values;
  const maxAttempts = values['security.loginMaxAttempts'] as number;
  const windowSec = values['security.loginWindowSec'] as number;

  if (now - lastLoginLimitPruneAt >= LOGIN_LIMIT_PRUNE_INTERVAL_SEC) {
    lastLoginLimitPruneAt = now;
    /** Keep counter rows at least as long as the configured throttle window. / 计数记录至少保留配置的限流窗口时长。 */
    const pruneAfterSec = Math.max(LOGIN_LIMIT_TTL_SEC, windowSec);
    try {
      await db.execute(authSQL[db.type].pruneLoginLimits, [now - pruneAfterSec]);
    } catch (e) {
      lastLoginLimitPruneAt = Number.NEGATIVE_INFINITY;
      throw e;
    }
  }
  for (const key of keys) {
    /** Parameter order must match both dialects; the configured window also sets the lockout duration. / 参数顺序须与两种方言一致；配置窗口同时决定锁定时长。 */
    const row = await db.queryOne<{ locked_until: number }>(authSQL[db.type].reserveLoginAttempt, [
      key,
      now,
      now, windowSec,
      now, windowSec, now,
      now,
      now, windowSec,
      maxAttempts,
      now + windowSec,
    ]);
    if ((row?.locked_until ?? 0) > now) return false;
  }
  return true;
}

export async function clearFailures(env: Env, userId: string): Promise<void> {
  const db = getDB(env);
  await db.execute(authSQL[db.type].clearFailures, [userId]);
}

export async function clearLoginAttempts(env: Env, keys: string[]): Promise<void> {
  const db = getDB(env);
  for (const key of keys) await db.execute(authSQL[db.type].clearLoginAttempts, [key]);
}

export function isLocked(user: User, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return user.locked_until > nowSec;
}

// ---------------------------------------------------------------- cookies
// ---------------------------------------------------------------- Cookie / cookies

/** Parse cookie values without letting a malformed escape discard the other cookies. / 解析 Cookie 值，避免格式错误的转义导致其他 Cookie 被丢弃。 */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed escape sequence must not throw on every later cookie.
      // 格式错误的转义序列不能导致后续所有 Cookie 解析抛错。
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** HttpOnly prevents direct script reads, not XSS actions; SameSite=Lax limits cross-site sending, and HTTPS enables Secure. / HttpOnly 阻止脚本直接读取，但不能阻止 XSS 操作；SameSite=Lax 限制跨站发送，HTTPS 启用 Secure。 */
export function sessionCookie(
  token: string,
  maxAgeSec: number,
  secure: boolean,
): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Whether the request arrived over https, so `Secure` can be set correctly. / 判断请求是否通过 HTTPS 到达，以正确设置 `Secure`。 */
export function isSecureRequest(url: string): boolean {
  return new URL(url).protocol === 'https:';
}

/** Compare equal-length strings without returning early on a mismatched character. / 比较等长字符串时，不因某个字符不匹配而提前返回。 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
