import type { Agent, Env } from '../../types';
import { getDB } from '../db/factory';

export async function findAgentByToken(env: Env, token: string): Promise<Agent | null> {
  if (!token) return null;
  const db = getDB(env);
  return db.queryOne<Agent>(`SELECT * FROM agents WHERE token=${db.type === 'postgres' ? '$1' : '?'}`, [token]);
}

export async function findAgent(env: Env, id: string): Promise<Agent | null> {
  const db = getDB(env);
  return db.queryOne<Agent>(`SELECT * FROM agents WHERE id=${db.type === 'postgres' ? '$1' : '?'}`, [id]);
}

export async function deleteAgent(env: Env, id: string): Promise<'deleted' | 'missing' | 'in_use'> {
  const db = getDB(env);
  if (!await findAgent(env, id)) return 'missing';
  const references = await db.queryOne(`SELECT id FROM monitors WHERE agent_id=${db.type === 'postgres' ? '$1' : '?'} LIMIT 1`, [id]);
  if (references) return 'in_use';
  const param = db.type === 'postgres' ? '$1' : '?';
  try {
    await db.commit([
      { sql: `DELETE FROM agents WHERE id=${param}`, params: [id] },
      { sql: `DELETE FROM agent_commands WHERE agent_id=${param}`, params: [id] },
      { sql: `DELETE FROM agent_probe_jobs WHERE agent_id=${param}`, params: [id] },
    ]);
  } catch (error) {
    if (/foreign key/i.test(String(error))) return 'in_use';
    throw error;
  }
  return 'deleted';
}
