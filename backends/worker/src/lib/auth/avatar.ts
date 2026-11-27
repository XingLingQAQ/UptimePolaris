import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { avatarSQL } from '../db/sql/avatar';
import { bytesToBase64 } from '../http/binary';

export const MAX_AVATAR_BYTES = 384 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';
const EXTERNAL_AVATAR_KEY_PREFIX = 'external-avatar:';

function isExternalUserId(userId: string): boolean {
  return userId.startsWith('external:');
}

export function validAvatarImage(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  if (bytes.length < 45 || bytes.length > MAX_AVATAR_BYTES || !signature.every((byte, index) => bytes[index] === byte)) return false;
  const ending = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130];
  if (!ending.every((byte, index) => bytes[bytes.length - ending.length + index] === byte)) return false;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  return width > 0 && width <= 512 && height > 0 && height <= 512;
}

export async function readAvatarInfo(env: Env, userId: string) {
  const db = getDB(env);
  if (isExternalUserId(userId)) {
    const row = await db.queryOne<{ json: string }>(
      db.type === 'postgres' ? 'SELECT json FROM live_state WHERE id = $1' : 'SELECT json FROM live_state WHERE id = ?',
      [`${EXTERNAL_AVATAR_KEY_PREFIX}${userId}`],
    );
    if (!row) return { uploaded: false, url: null };
    const parsed = JSON.parse(row.json) as { version?: string };
    return parsed.version
      ? { uploaded: true, url: `/api/auth/avatar/image?v=${encodeURIComponent(parsed.version)}` }
      : { uploaded: false, url: null };
  }
  const row = await db.queryOne<{ version: string }>(avatarSQL[db.type].metadata, [userId]);
  return row
    ? { uploaded: true, url: `/api/auth/avatar/image?v=${encodeURIComponent(row.version)}` }
    : { uploaded: false, url: null };
}

export async function readAvatarImage(env: Env, userId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const db = getDB(env);
  if (isExternalUserId(userId)) {
    const row = await db.queryOne<{ json: string }>(
      db.type === 'postgres' ? 'SELECT json FROM live_state WHERE id = $1' : 'SELECT json FROM live_state WHERE id = ?',
      [`${EXTERNAL_AVATAR_KEY_PREFIX}${userId}`],
    );
    if (!row) return null;
    const parsed = JSON.parse(row.json) as { data_url?: string };
    return typeof parsed.data_url === 'string' && parsed.data_url.startsWith(PNG_PREFIX)
      ? Uint8Array.from(atob(parsed.data_url.slice(PNG_PREFIX.length)), (char) => char.charCodeAt(0))
      : null;
  }
  const row = await db.queryOne<{ data_url: string }>(avatarSQL[db.type].image, [userId]);
  return row ? Uint8Array.from(atob(row.data_url.slice(PNG_PREFIX.length)), (char) => char.charCodeAt(0)) : null;
}

export async function writeAvatar(env: Env, userId: string, bytes: Uint8Array) {
  if (!validAvatarImage(bytes)) throw new Error('avatar_invalid');
  const db = getDB(env);
  const version = crypto.randomUUID();
  const dataUrl = PNG_PREFIX + bytesToBase64(bytes);
  const now = Math.floor(Date.now() / 1000);
  if (isExternalUserId(userId)) {
    await db.execute(
      db.type === 'postgres'
        ? 'INSERT INTO live_state (id, json, updated_at) VALUES ($1, $2, $3) ON CONFLICT(id) DO UPDATE SET json = EXCLUDED.json, updated_at = EXCLUDED.updated_at'
        : 'INSERT INTO live_state (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      [`${EXTERNAL_AVATAR_KEY_PREFIX}${userId}`, JSON.stringify({ data_url: dataUrl, version }), now],
    );
    return { uploaded: true, url: `/api/auth/avatar/image?v=${version}` };
  }
  await db.execute(avatarSQL[db.type].upsert, [userId, dataUrl, version, now]);
  return { uploaded: true, url: `/api/auth/avatar/image?v=${version}` };
}

export async function removeAvatar(env: Env, userId: string) {
  const db = getDB(env);
  if (isExternalUserId(userId)) {
    await db.execute(
      db.type === 'postgres' ? 'DELETE FROM live_state WHERE id = $1' : 'DELETE FROM live_state WHERE id = ?',
      [`${EXTERNAL_AVATAR_KEY_PREFIX}${userId}`],
    );
    return { uploaded: false, url: null };
  }
  await db.execute(avatarSQL[db.type].remove, [userId]);
  return { uploaded: false, url: null };
}
