import type { SetupDatabaseOptions } from '../../../../../shared/setup';
import type { Env } from '../../types';

type DatabaseType = 'd1' | 'postgres';
interface ControlRow {
  type: DatabaseType;
  encrypted_url: string | null;
  source: 'deployment' | 'selected';
  operation: string;
  phase: 'pending' | 'active';
  lease_id: string | null;
  lease_until: number;
  account_started: number;
}

export class DatabaseConfigurationError extends Error {
  constructor() { super('database_configuration_failed'); }
}

const table = '_polaris_database';
const encoder = new TextEncoder();
const deployments = new WeakMap<Env, Env>();

// 保留原部署配置，避免把请求内解析出的选库结果当作部署默认值。
// Retain deployment settings rather than treating a request's resolved selection as deployment defaults.
export function rememberDeployment(scoped: Env, source: Env): void {
  deployments.set(scoped, deployments.get(source) ?? source);
}

export function deploymentEnv(env: Env): Env {
  return deployments.get(env) ?? env;
}

export function deployedDatabase(env: Env): Pick<Env, 'DATABASE_TYPE' | 'DATABASE_URL'> {
  const original = deploymentEnv(env);
  return { DATABASE_TYPE: original.DATABASE_TYPE, DATABASE_URL: original.DATABASE_URL };
}

export function databaseIdentity(env: Env): string | D1Database {
  return (env.DATABASE_TYPE ?? 'd1') === 'postgres' ? `postgres:${env.DATABASE_URL ?? ''}` : env.DB;
}

async function controlRow(db: D1Database): Promise<ControlRow | null> {
  const exists = await db.prepare("SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = ?").bind(table).first();
  if (!exists) return null;
  return db.prepare(`SELECT type, encrypted_url, source, operation, phase, lease_id, lease_until, account_started FROM ${table} WHERE id = 1`).first<ControlRow>();
}

// 选库 URL 的密钥依赖 ADMIN_TOKEN；轮换 Token 时须处理已保存的密文。
// The saved URL's key depends on ADMIN_TOKEN; token rotation must account for existing ciphertext.
async function encryptionKey(token: string): Promise<CryptoKey> {
  if (!token) throw new DatabaseConfigurationError();
  const input = await crypto.subtle.importKey('raw', encoder.encode(token), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('uptime-polaris-worker-database-v1'), info: encoder.encode('postgres-url') },
    input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function encryptUrl(url: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(token), encoder.encode(url));
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}

async function decryptUrl(value: string, token: string): Promise<string> {
  try {
    const [version, iv, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !iv || !ciphertext || extra !== undefined) throw new Error();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) }, await encryptionKey(token), unbase64(ciphertext));
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new DatabaseConfigurationError();
  }
}

/** 已保存的选择优先；pending 阶段不提供 PostgreSQL URL。 / Saved selections take priority; pending claims expose no PostgreSQL URL. */
export async function resolveDatabase(env: Env): Promise<Pick<Env, 'DATABASE_TYPE' | 'DATABASE_URL'>> {
  if (!env.DB) return { DATABASE_TYPE: env.DATABASE_TYPE, DATABASE_URL: env.DATABASE_URL };
  try {
    const row = await controlRow(env.DB);
    if (!row) return { DATABASE_TYPE: env.DATABASE_TYPE, DATABASE_URL: env.DATABASE_URL };
    if (row.phase !== 'pending' && row.phase !== 'active' || row.source !== 'deployment' && row.source !== 'selected') throw new DatabaseConfigurationError();
    if (row.type === 'd1') return { DATABASE_TYPE: 'd1', DATABASE_URL: undefined };
    if (row.type !== 'postgres') throw new DatabaseConfigurationError();
    if (!row.encrypted_url) throw new DatabaseConfigurationError();
    return { DATABASE_TYPE: 'postgres', DATABASE_URL: row.phase === 'pending' ? undefined : await decryptUrl(row.encrypted_url, env.ADMIN_TOKEN) };
  } catch {
    throw new DatabaseConfigurationError();
  }
}

export async function requireReadyDatabase(env: Env): Promise<void> {
  if (await pendingDatabase(env)) throw new DatabaseConfigurationError();
}

export async function pendingDatabase(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  return (await controlRow(env.DB))?.phase === 'pending';
}

export async function pendingDatabaseUrl(env: Env): Promise<string | undefined> {
  if (!env.DB) return undefined;
  try {
    const row = await controlRow(env.DB);
    if (row?.phase !== 'pending' || row.type !== 'postgres' || !row.encrypted_url) return undefined;
    return await decryptUrl(row.encrypted_url, env.ADMIN_TOKEN);
  } catch {
    throw new DatabaseConfigurationError();
  }
}

export async function databaseClaimActive(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  return (await controlRow(env.DB))?.phase === 'active';
}

export async function completedOperation(env: Env, operation: string): Promise<boolean> {
  if (!env.DB || !operation) return false;
  const row = await controlRow(env.DB);
  return row?.phase === 'active' && row.operation === operation;
}

export async function d1HasUsers(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  const exists = await env.DB.prepare("SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = 'users'").first();
  if (!exists) return false;
  return Boolean(await env.DB.prepare('SELECT 1 AS n FROM users LIMIT 1').first());
}

export async function setupDatabaseOptions(env: Env): Promise<SetupDatabaseOptions> {
  const deployed = deployedDatabase(env);
  const pending = await pendingDatabase(env);
  const configured = pending ? env.DATABASE_TYPE === 'postgres' : (deployed.DATABASE_TYPE ?? 'd1') === 'postgres' && Boolean(deployed.DATABASE_URL);
  return {
    types: pending ? [(env.DATABASE_TYPE ?? 'd1')] : env.DB ? ['d1', 'postgres'] : ['postgres'],
    defaultType: (env.DATABASE_TYPE ?? 'd1') === 'postgres' ? 'postgres' : 'd1',
    postgresConfigured: configured,
    postgresUrlEditable: Boolean(env.DB) && !pending,
  };
}

/** 过期租约只允许恢复同一目标的初始化，不允许改选数据库。 / An expired lease permits resuming setup for the same target, not selecting another database. */
export async function claimDatabase(env: Env, type: DatabaseType, url: string | undefined): Promise<{ operation: string; lease: string; accountStarted: boolean; source: 'deployment' | 'selected' } | null> {
  if (!env.DB) return { operation: '', lease: '', accountStarted: false, source: 'deployment' };
  const db = env.DB;
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY CHECK (id = 1), type TEXT NOT NULL, encrypted_url TEXT, source TEXT NOT NULL, operation TEXT NOT NULL, phase TEXT NOT NULL, lease_id TEXT, lease_until INTEGER NOT NULL, account_started INTEGER NOT NULL DEFAULT 0)`).run();
  const operation = crypto.randomUUID();
  const lease = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const deployed = deployedDatabase(env);
  const source = type === (deployed.DATABASE_TYPE ?? 'd1') && (type === 'd1' || deployed.DATABASE_URL === url) ? 'deployment' : 'selected';
  const encrypted = type === 'postgres' && url ? await encryptUrl(url, env.ADMIN_TOKEN) : null;
  const users = await db.prepare("SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = 'users'").first();
  const setupState = await db.prepare("SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = 'auth_setup_state'").first();
  const eligible = `${users ? ' AND NOT EXISTS (SELECT 1 FROM users)' : ''}${setupState ? ' AND NOT EXISTS (SELECT 1 FROM auth_setup_state WHERE completed = 1)' : ''}`;
  await db.prepare(`INSERT OR IGNORE INTO ${table} (id, type, encrypted_url, source, operation, phase, lease_id, lease_until) SELECT 1, ?, ?, ?, ?, 'pending', ?, ? WHERE 1 = 1${eligible}`).bind(type, encrypted, source, operation, lease, now + 600).run();
  let row = await controlRow(db);
  if (!row || row.phase === 'active') return null;
  if (row.type !== type || (type === 'postgres' && (!row.encrypted_url || await decryptUrl(row.encrypted_url, env.ADMIN_TOKEN) !== url))) return null;
  if (row.lease_id !== lease) {
    const claimed = await db.prepare(`UPDATE ${table} SET lease_id = ?, lease_until = ? WHERE id = 1 AND phase = 'pending' AND (lease_id IS NULL OR lease_until <= ?)`).bind(lease, now + 600, now).run();
    if (claimed.meta.changes !== 1) return null;
    row = await controlRow(db);
    if (!row || row.lease_id !== lease) return null;
  }
  return { operation: row.operation, lease, accountStarted: row.account_started === 1, source: row.source };
}

export async function markAccountStarted(env: Env, operation: string, lease: string): Promise<void> {
  if (!env.DB) return;
  const result = await env.DB.prepare(`UPDATE ${table} SET account_started = 1 WHERE id = 1 AND operation = ? AND lease_id = ? AND phase = 'pending'`).bind(operation, lease).run();
  if (result.meta.changes !== 1) throw new DatabaseConfigurationError();
}

// 默认 D1 完成后移除控制记录；PostgreSQL 和显式改选仍需保留活动记录。
// Remove the control row for default D1; PostgreSQL and explicit selections retain an active row.
export async function finishDatabaseClaim(env: Env, operation: string, lease: string): Promise<void> {
  if (!env.DB) return;
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${table} WHERE id = 1 AND source = 'deployment' AND type = 'd1' AND operation = ? AND lease_id = ? AND phase = 'pending'`).bind(operation, lease),
    env.DB.prepare(`UPDATE ${table} SET phase = 'active', lease_id = NULL, lease_until = 0 WHERE id = 1 AND source = 'deployment' AND type = 'postgres' AND operation = ? AND lease_id = ? AND phase = 'pending'`).bind(operation, lease),
    env.DB.prepare(`UPDATE ${table} SET phase = 'active', lease_id = NULL, lease_until = 0 WHERE id = 1 AND source = 'selected' AND operation = ? AND lease_id = ? AND phase = 'pending'`).bind(operation, lease),
  ]);
  if (results.reduce((count, result) => count + (result.meta.changes ?? 0), 0) !== 1) throw new DatabaseConfigurationError();
}

export async function releaseDatabaseClaim(env: Env, operation: string, lease: string): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(`UPDATE ${table} SET lease_id = NULL, lease_until = 0 WHERE id = 1 AND operation = ? AND lease_id = ? AND phase = 'pending'`).bind(operation, lease).run();
}

export async function resetAccountStarted(env: Env, operation: string, lease: string): Promise<void> {
  if (!env.DB) return;
  const result = await env.DB.prepare(`UPDATE ${table} SET account_started = 0 WHERE id = 1 AND operation = ? AND lease_id = ? AND phase = 'pending'`).bind(operation, lease).run();
  if (result.meta.changes !== 1) throw new DatabaseConfigurationError();
}

// 创建账号开始后保留选库记录，供失败重试继续使用原数据库。
// Retain the selection once account creation starts so retries use the same database.
export async function abandonDatabaseClaim(env: Env, operation: string, lease: string): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(`DELETE FROM ${table} WHERE id = 1 AND operation = ? AND lease_id = ? AND phase = 'pending' AND account_started = 0`).bind(operation, lease).run();
}
