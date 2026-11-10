/**
 * Fetch a monitored site's icon: `/favicon.ico`, then `<link rel=icon>`.
 *
 * Redirects are followed manually and re-checked, because an internal host is
 * a valid monitor but its redirect must not reach metadata endpoints. The
 * `href` is used verbatim (no HTML entity decoding), and SVG is refused because
 * third-party SVG is a scripting surface.
 * 手动跟随并复查重定向；不解码 HTML 实体；拒绝第三方 SVG。
 */
import { isPrivateHost } from '../http/private-host';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4000;

const RASTER_TYPES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export interface SiteIcon {
  bytes: ArrayBuffer;
  contentType: string;
}

function absolutize(href: string, base: URL): URL | null {
  try {
    const resolved = new URL(href, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (isPrivateHost(resolved.hostname)) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Follows at most two redirects, re-checking the host at each hop. / 最多跟随两次重定向，并逐跳重新检查主机。 */
async function fetchGuarded(url: URL): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/*,*/*;q=0.5' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      const next = absolutize(location, current);
      if (!next) return null;
      current = next;
      continue;
    }
    return response.ok ? response : null;
  }
  return null;
}

function sniffType(bytes: Uint8Array): string | null {
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  return null;
}

async function readImage(response: Response): Promise<SiteIcon | null> {
  const declared = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  // Anything that is not an image at all - an HTML error page served with 200 -
  // is not worth reading. The exact type is decided from the bytes below.
  // 完全不是图片的响应（如返回 200 的 HTML 错误页面）无需读取；具体类型由下方字节判断。
  if (declared && !declared.startsWith('image/')) return null;
  const length = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_BYTES) return null;
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return null;
  const contentType = sniffType(new Uint8Array(buffer));
  if (!contentType) return null;
  return { bytes: buffer, contentType };
}

const LINK_TAG = /<link\b[^>]*>/gi;
const REL_ATTR = /\brel\s*=\s*["']([^"']*)["']/i;
const HREF_ATTR = /\bhref\s*=\s*["']([^"']*)["']/i;

/** The first <link rel="...icon..."> on a page, if any. / 页面中首个 <link rel="...icon...">，若存在。 */
function iconHref(html: string, base: URL): URL | null {
  for (const tag of html.match(LINK_TAG) ?? []) {
    const rel = REL_ATTR.exec(tag)?.[1] ?? '';
    if (!/\bicon\b/i.test(rel)) continue;
    const href = HREF_ATTR.exec(tag)?.[1];
    if (!href) continue;
    const resolved = absolutize(href, base);
    if (resolved) return resolved;
  }
  return null;
}

export async function fetchSiteIcon(site: URL): Promise<SiteIcon | null> {
  // 1. The conventional path. Cheap, and right for most sites.
  // 1. 常规路径；成本低，适用于大多数网站。
  const conventional = absolutize('/favicon.ico', site);
  if (conventional) {
    try {
      const response = await fetchGuarded(conventional);
      const icon = response ? await readImage(response) : null;
      if (icon) return icon;
    } catch {
      // Fall through to the page.
      // 继续尝试页面声明。
    }
  }

  // 2. The page's own declaration - covers `/assets/icon-32.png` layouts.
  // 2. 页面自身声明，覆盖 `/assets/icon-32.png` 等布局。
  try {
    const page = await fetchGuarded(site);
    if (!page) return null;
    const contentType = (page.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/html')) return null;
    const html = (await page.text()).slice(0, 96 * 1024);
    const href = iconHref(html, site);
    if (!href) return null;
    const response = await fetchGuarded(href);
    return response ? await readImage(response) : null;
  } catch {
    return null;
  }
}
