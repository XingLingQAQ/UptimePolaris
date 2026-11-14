import type { SetupDatabaseOptions } from '../../../../../shared/setup';
import type { Env } from '../../types';
import { getDB } from './factory';
import { readDatabaseConfiguration, saveDatabaseConfiguration } from './setup-configuration';

export type DatabaseType = 'd1' | 'postgres';
export interface ControlRow {
  type: DatabaseType;
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

export function databaseType(env: Pick<Env, 'DATABASE_TYPE' | 'DB'>): DatabaseType {
  return env.DATABASE_TYPE ?? (env.DB ? 'd1' : 'postgres');
}

export function deployedDatabaseType(env: Env): DatabaseType {
  return databaseType(deploymentEnv(env));
}

export function databaseIdentity(env: Env): string | D1Database {
  return databaseType(env) === 'postgres' ? `postgres:${env.DATABASE_URL ?? ''}` : env.DB;
}

async function databaseControlRow(env: Env): Promise<ControlRow | null> {
  const pg = databaseType(env) === 'postgres';
  if (pg ? !env.DATABASE_URL : !env.DB) return null;
  const db = getDB(env);
  const exists = await db.queryOne(pg
    ? "SELECT 1 AS n WHERE to_regclass(format('%I._polaris_database', current_schema())) IS NOT NULL"
    : "SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = '_polaris_database'");
  if (!exists) return null;
  return db.queryOne<ControlRow>(`SELECT type, source, operation, phase, lease_id, lease_until, account_started FROM ${table} WHERE id = 1`);
}

// 加密密钥依赖 ADMIN_TOKEN。 / Encryption depends on ADMIN_TOKEN.
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

export async function encryptUrl(url: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(token), encoder.encode(url));
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}

export async function decryptUrl(value: string, token: string): Promise<string> {
  try {
    const [version, iv, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !iv || !ciphertext || extra !== undefined) throw new Error();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) }, await encryptionKey(token), unbase64(ciphertext));
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new DatabaseConfigurationError();
  }
}


export async function resolveDatabase(env: Env): Promise<Pick<Env, 'DATABASE_TYPE' | 'DATABASE_URL'>> {
  const saved = await readDatabaseConfiguration(env);
  if (!saved) return deployedDatabase(env);
  return { DATABASE_TYPE: saved.type, DATABASE_URL: saved.type === 'postgres' ? await decryptUrl(saved.encrypted_url!, env.ADMIN_TOKEN) : undefined };
}

export async function requireReadyDatabase(env: Env): Promise<void> {
  if (await pendingDatabase(env)) throw new DatabaseConfigurationError();
}

export async function pendingDatabase(env: Env): Promise<boolean> {
  return (await databaseControlRow(env))?.phase === 'pending';
}

export async function pendingDatabaseUrl(env: Env): Promise<string | undefined> {
  return databaseType(env) === 'postgres' && await pendingDatabase(env) ? env.DATABASE_URL : undefined;
}

export async function databaseClaimActive(env: Env): Promise<boolean> {
  return (await databaseControlRow(env))?.phase === 'active';
}

export async function completedOperation(env: Env, operation: string): Promise<boolean> {
  if (!operation) return false;
  const row = await databaseControlRow(env);
  return row?.phase === 'active' && row.operation === operation;
}

export async function d1HasUsers(env: Env): Promise<boolean> {
  if (!env.DB) return false;
  const exists = await env.DB.prepare("SELECT 1 AS n FROM sqlite_schema WHERE type = 'table' AND name = 'users'").first();
  if (!exists) return false;
  return Boolean(await env.DB.prepare('SELECT 1 AS n FROM users LIMIT 1').first());
}

export async function setupDatabaseOptions(env: Env): Promise<SetupDatabaseOptions> {
  const row = await databaseControlRow(env);
  const locked = row?.phase === 'pending' && row.account_started === 1;
  const saved = await readDatabaseConfiguration(env);
  return {
    types: locked ? [databaseType(env)] : env.DB ? ['d1', 'postgres'] : ['postgres'],
    defaultType: databaseType(env),
    postgresConfigured: databaseType(env) === 'postgres' && Boolean(env.DATABASE_URL),
    postgresUrlEditable: Boolean(env.CONFIG) && !locked,
    ...(saved ? { configurationId: saved.id } : {}),
  };
}

export { saveDatabaseConfiguration };

// KV 只存配置；租约在目标数据库中原子更新。 / Keep leases atomic in the target database, not KV.
export async function claimDatabase(env: Env, type: DatabaseType, url: string | undefined): Promise<{ operation: string; lease: string; accountStarted: boolean; source: 'deployment' | 'selected' } | null> {
  const db = getDB(env);
  const pg = type === 'postgres';
  const bind = (n: number) => pg ? '$' + n : '?';
  await db.execute(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY CHECK (id = 1), type TEXT NOT NULL, source TEXT NOT NULL, operation TEXT NOT NULL, phase TEXT NOT NULL, lease_id TEXT, lease_until BIGINT NOT NULL, account_started INTEGER NOT NULL DEFAULT 0)`);
  const operation = crypto.randomUUID();
  const lease = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const deployed = deployedDatabase(env);
  const source = type === deployedDatabaseType(env) && (type === 'd1' || deployed.DATABASE_URL === url) ? 'deployment' : 'selected';
  await db.execute(`INSERT INTO ${table} (id, type, source, operation, phase, lease_id, lease_until) SELECT 1, ${bind(1)}, ${bind(2)}, ${bind(3)}, 'pending', ${bind(4)}, ${bind(5)} WHERE NOT EXISTS (SELECT 1 FROM users) AND NOT EXISTS (SELECT 1 FROM auth_setup_state WHERE completed = 1) ON CONFLICT (id) DO NOTHING`, [type, source, operation, lease, now + 600]);
  let row = await databaseControlRow(env);
  if (!row || row.phase === 'active' || row.type !== type) return null;
  if (row.lease_id !== lease) {
    const claimed = await db.execute(`UPDATE ${table} SET lease_id = ${bind(1)}, lease_until = ${bind(2)} WHERE id = 1 AND phase = 'pending' AND (lease_id IS NULL OR lease_until <= ${bind(3)})`, [lease, now + 600, now]);
    if (claimed.rowsAffected !== 1) return null;
    row = await databaseControlRow(env);
    if (!row || row.lease_id !== lease) return null;
  }
  return { operation: row.operation, lease, accountStarted: row.account_started === 1, source: row.source };
}

async function updateClaim(env: Env, operation: string, lease: string, changes: string, requireChange = false): Promise<void> {
  const pg = databaseType(env) === 'postgres';
  const result = await getDB(env).execute(`UPDATE ${table} SET ${changes} WHERE id = 1 AND operation = ${pg ? '$1' : '?'} AND lease_id = ${pg ? '$2' : '?'} AND phase = 'pending'`, [operation, lease]);
  if (requireChange && result.rowsAffected !== 1) throw new DatabaseConfigurationError();
}

export async function markAccountStarted(env: Env, operation: string, lease: string): Promise<void> {
  await updateClaim(env, operation, lease, 'account_started = 1', true);
}

export async function finishDatabaseClaim(env: Env, operation: string, lease: string): Promise<void> {
  await updateClaim(env, operation, lease, "phase = 'active', lease_id = NULL, lease_until = 0", true);
}

export async function releaseDatabaseClaim(env: Env, operation: string, lease: string): Promise<void> {
  await updateClaim(env, operation, lease, 'lease_id = NULL, lease_until = 0');
}

export async function resetAccountStarted(env: Env, operation: string, lease: string): Promise<void> {
  await updateClaim(env, operation, lease, 'account_started = 0', true);
}

export async function abandonDatabaseClaim(env: Env, operation: string, lease: string): Promise<void> {
  const pg = databaseType(env) === 'postgres';
  await getDB(env).execute(`DELETE FROM ${table} WHERE id = 1 AND operation = ${pg ? '$1' : '?'} AND lease_id = ${pg ? '$2' : '?'} AND phase = 'pending' AND account_started = 0`, [operation, lease]);
}

export async function discardPendingDatabase(env: Env): Promise<boolean> {
  const pg = databaseType(env) === 'postgres';
  const result = await getDB(env).execute(`DELETE FROM ${table} WHERE id = 1 AND phase = 'pending' AND account_started = 0 AND (lease_id IS NULL OR lease_until <= ${pg ? '$1' : '?'})`, [Math.floor(Date.now() / 1000)]);
  return result.rowsAffected === 1;
}
