/**
 * Uploaded site icon.
 *
 * The type is decided by magic bytes, never by filename or declared header:
 * an uploaded SVG can carry script and is served to anonymous visitors, so
 * only recognised raster formats are accepted. The generated mark is SVG
 * because this code writes it; uploads are not.
 * 按字节判断类型；上传的 SVG 可执行脚本，一律拒绝。
 */

import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { siteIconSQL } from '../db/sql/site-icon';

/** Max icon size, 256 KB. / 图标大小上限 256 KB。 */
export const MAX_ICON_BYTES = 256 * 1024;

/** Formats accepted for upload. Raster only; see the module note on SVG. / 可上传的格式，仅限栅格图像；SVG 说明见模块注释。 */
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

export interface StoredIcon {
  /** Pinned to ArrayBuffer; Hono's c.body rejects the widened alias. / 固定为 ArrayBuffer；Hono 的 c.body 不接受宽化后的类型。 */
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  byteSize: number;
  filename: string | null;
  updatedAt: number;
}

/** Sniff an image type from magic bytes; matches monitor-icon.ts. / 按魔术字节判断图片类型，与 monitor-icon.ts 一致。 */
export function sniffIconType(bytes: Uint8Array): string | null {
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  return null;
}

/** Validate an upload without storing it; returns the type or a reason. / 只校验上传，不存储；返回类型或原因。 */
export type IconValidation =
  | { ok: true; contentType: string }
  | { ok: false; error: 'empty' | 'too_large' | 'unsupported_type' };

export function validateIconUpload(bytes: Uint8Array): IconValidation {
  if (bytes.byteLength === 0) return { ok: false, error: 'empty' };
  if (bytes.byteLength > MAX_ICON_BYTES) return { ok: false, error: 'too_large' };
  const contentType = sniffIconType(bytes);
  if (!contentType || !ALLOWED_TYPES.has(contentType)) return { ok: false, error: 'unsupported_type' };
  return { ok: true, contentType };
}

/**
 * Normalise a BLOB to `Uint8Array`.
 *
 * D1 returns `ArrayBuffer`, Postgres a `Buffer`, and Miniflare (wrangler dev)
 * a plain array of byte values. Accepting only the first two makes uploads
 * vanish locally while working in production.
 * D1、Postgres、Miniflare 的二进制形状不同；只处理前两种会让本地上传消失。
 */
function toBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  // Copy a Postgres Buffer so the response does not retain the pool. / 复制 Postgres Buffer，避免响应持有连接池。
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // Miniflare returns a plain byte array; validate it before use. / Miniflare 返回普通字节数组；使用前校验。
  if (Array.isArray(value)) {
    if (!value.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) return null;
    return Uint8Array.from(value as number[]);
  }
  // Some drivers hand a base64 string for BYTEA when no type parser is set.
  // 某些驱动在未设置类型解析器时会将 BYTEA 返回为 base64 字符串。
  if (typeof value === 'string') {
    try {
      const binary = atob(value);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }
  return null;
}

/** The stored icon, or null when the operator has never uploaded one. / 已存储图标；管理员从未上传时为 null。 */
export async function readSiteIcon(env: Env): Promise<StoredIcon | null> {
  const db = getDB(env);
  let row: Record<string, unknown> | null;
  try {
    row = await db.queryOne<Record<string, unknown>>(siteIconSQL[db.type].read);
  } catch {
    // Missing table degrades to the generated mark, not an error. / 缺表时退回生成的图标，不报错。
    return null;
  }
  if (!row) return null;
  const bytes = toBytes(row.bytes);
  if (!bytes) return null;
  return {
    bytes,
    contentType: String(row.content_type ?? ''),
    byteSize: Number(row.byte_size ?? bytes.byteLength),
    filename: row.filename == null ? null : String(row.filename),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** Store an icon, replacing the current one; validate here too. / 存储图标并替换当前值；此处也做校验。 */
export async function writeSiteIcon(
  env: Env,
  bytes: Uint8Array<ArrayBuffer>,
  filename: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; icon: StoredIcon } | { ok: false; error: string }> {
  const checked = validateIconUpload(bytes);
  if (!checked.ok) return checked;
  const db = getDB(env);
  try {
    await db.execute(siteIconSQL[db.type].upsert, [bytes, checked.contentType, bytes.byteLength, filename, now]);
  } catch {
    return { ok: false, error: 'database_unavailable' };
  }
  return {
    ok: true,
    icon: { bytes, contentType: checked.contentType, byteSize: bytes.byteLength, filename, updatedAt: now },
  };
}

/** Remove the upload so the generated mark comes back. / 删除上传图标，使生成的图标重新显示。 */
export async function clearSiteIcon(env: Env): Promise<boolean> {
  const db = getDB(env);
  try {
    await db.execute(siteIconSQL[db.type].remove);
    return true;
  } catch {
    return false;
  }
}

/** ETag from updated_at and size; cheap and changes exactly with the bytes. / 用 updated_at 和大小生成 ETag；成本低且随字节变化。 */
export function iconEtag(icon: StoredIcon): string {
  return `"icon-${icon.updatedAt.toString(16)}-${icon.byteSize.toString(16)}"`;
}
