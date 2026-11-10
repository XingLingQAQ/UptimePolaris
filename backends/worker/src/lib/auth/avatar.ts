import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { avatarSQL } from '../db/sql/avatar';
import { bytesToBase64 } from '../http/binary';

export const MAX_AVATAR_BYTES = 384 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';

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
  const row = await db.queryOne<{ version: string }>(avatarSQL[db.type].metadata, [userId]);
  return row
    ? { uploaded: true, url: `/api/auth/avatar/image?v=${encodeURIComponent(row.version)}` }
    : { uploaded: false, url: null };
}

export async function readAvatarImage(env: Env, userId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const db = getDB(env);
  const row = await db.queryOne<{ data_url: string }>(avatarSQL[db.type].image, [userId]);
  return row ? Uint8Array.from(atob(row.data_url.slice(PNG_PREFIX.length)), (char) => char.charCodeAt(0)) : null;
}

export async function writeAvatar(env: Env, userId: string, bytes: Uint8Array) {
  if (!validAvatarImage(bytes)) throw new Error('avatar_invalid');
  const db = getDB(env);
  const version = crypto.randomUUID();
  await db.execute(avatarSQL[db.type].upsert, [userId, PNG_PREFIX + bytesToBase64(bytes), version, Math.floor(Date.now() / 1000)]);
  return { uploaded: true, url: `/api/auth/avatar/image?v=${version}` };
}

export async function removeAvatar(env: Env, userId: string) {
  const db = getDB(env);
  await db.execute(avatarSQL[db.type].remove, [userId]);
  return { uploaded: false, url: null };
}
