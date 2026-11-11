import type { Env } from '../../types';
import { isSafeThemePath } from './manifest';

export interface ThemeFile {
  body: ReadableStream | string;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
};

export function contentTypeFor(file: string): string {
  const extension = file.includes('.') ? file.split('.').pop()!.toLowerCase() : '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export function themeStoragePrefix(id: string): string | null {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? `themes/${id}/` : null;
}

export async function deleteThemeFiles(bucket: R2Bucket, prefix: string, renew: () => Promise<void>): Promise<void> {
  if (!/^themes\/[a-z0-9][a-z0-9-]{0,62}\/$/.test(prefix)) throw new Error('invalid_theme_storage_prefix');
  for (;;) {
    await renew();
    const page = await bucket.list({ prefix, limit: 1000 });
    await renew();
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    if (!page.truncated) return;
  }
}

export async function themeVersionEntryAvailable(env: Env, prefix: string, entry: string): Promise<boolean> {
  if (!env.THEMES || !/^themes\/[a-z0-9-]+\/[0-9A-Za-z.+-]+\/[a-f0-9]{64}\/[0-9a-f-]{36}$/.test(prefix) || !isSafeThemePath(entry)) return false;
  try { return (await env.THEMES.head(prefix + '/' + entry)) !== null; }
  catch { return false; }
}

export async function readVersionedThemeFile(env: Env, prefix: string, file: string): Promise<ThemeFile | null> {
  if (!env.THEMES || !/^themes\/[a-z0-9-]+\/[0-9A-Za-z.+-]+\/[a-f0-9]{64}\/[0-9a-f-]{36}$/.test(prefix) || !isSafeThemePath(file)) return null;
  try {
    const object = await env.THEMES.get(prefix + '/' + file);
    if (!object) return null;
    return { body: object.body as unknown as ReadableStream, contentType: object.httpMetadata?.contentType ?? contentTypeFor(file) };
  } catch (error) {
    console.error(JSON.stringify({ event: 'theme_read_failed', file, err: String(error) }));
    return null;
  }
}
