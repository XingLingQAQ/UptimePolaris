import type { Env } from '../../types';
import { DatabaseConfigurationError, databaseType, decryptUrl, deploymentEnv, encryptUrl, type DatabaseType } from './setup-control';

interface DatabaseConfiguration {
  id: string;
  type: DatabaseType;
  encrypted_url: string | null;
}

const key = 'database';
const snapshots = new WeakMap<Env, Promise<DatabaseConfiguration | null>>();

export function readDatabaseConfiguration(env: Env): Promise<DatabaseConfiguration | null> {
  const scoped = deploymentEnv(env) !== env;
  const snapshot = scoped && snapshots.get(env);
  if (snapshot) return snapshot;
  const result = loadDatabaseConfiguration(env);
  if (scoped) snapshots.set(env, result);
  return result;
}

async function loadDatabaseConfiguration(env: Env): Promise<DatabaseConfiguration | null> {
  const namespace = deploymentEnv(env).CONFIG;
  if (!namespace) return null;
  try {
    const value = await namespace.get<DatabaseConfiguration>(key, 'json');
    if (!value) return null;
    if (typeof value.id !== 'string' || !value.id || value.type !== 'd1' && value.type !== 'postgres' || value.type === 'postgres' && typeof value.encrypted_url !== 'string') throw new Error();
    return value;
  } catch { throw new DatabaseConfigurationError(); }
}

export async function saveDatabaseConfiguration(env: Env): Promise<string | undefined> {
  const original = deploymentEnv(env);
  if (!original.CONFIG) {
    if (databaseType(env) !== databaseType(original) || databaseType(env) === 'postgres' && env.DATABASE_URL !== original.DATABASE_URL) throw new DatabaseConfigurationError();
    return undefined;
  }
  const saved = await readDatabaseConfiguration(env);
  const type = databaseType(env);
  if (saved?.type === type && (type === 'd1' || await decryptUrl(saved.encrypted_url!, env.ADMIN_TOKEN) === env.DATABASE_URL)) return saved.id;
  const value: DatabaseConfiguration = {
    id: crypto.randomUUID(), type,
    encrypted_url: type === 'postgres' ? await encryptUrl(env.DATABASE_URL!, env.ADMIN_TOKEN) : null,
  };
  try { await original.CONFIG.put(key, JSON.stringify(value)); }
  catch { throw new DatabaseConfigurationError(); }
  snapshots.set(env, Promise.resolve(value));
  return value.id;
}
