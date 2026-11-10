import type { Env } from '../../types';
import { getDB } from '../db/factory';

const LEASE_MS = 60 * 60 * 1000;

export async function acquireThemeLease(env: Env, id: string): Promise<{ token: string; renew: () => Promise<void>; release: () => Promise<void> } | null> {
  const db = getDB(env), token = crypto.randomUUID(), now = Date.now();
  const sql = db.type === 'postgres'
    ? 'INSERT INTO theme_operations(id,token,expires_at) VALUES ($1,$2,$3) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE theme_operations.expires_at<$4'
    : 'INSERT INTO theme_operations(id,token,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE theme_operations.expires_at<?';
  if ((await db.execute(sql,[id,token,now + LEASE_MS,now])).rowsAffected !== 1) return null;
  return {
    token,
    async renew() {
      const time = Date.now();
      const update = db.type === 'postgres'
        ? 'UPDATE theme_operations SET expires_at=$1 WHERE id=$2 AND token=$3 AND expires_at>=$4'
        : 'UPDATE theme_operations SET expires_at=? WHERE id=? AND token=? AND expires_at>=?';
      if ((await db.execute(update,[time + LEASE_MS,id,token,time])).rowsAffected !== 1) throw new Error('theme_operation_expired');
    },
    async release() {
      const remove = db.type === 'postgres' ? 'DELETE FROM theme_operations WHERE id=$1 AND token=$2' : 'DELETE FROM theme_operations WHERE id=? AND token=?';
      await db.execute(remove,[id,token]);
    },
  };
}
