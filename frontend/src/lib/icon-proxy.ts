/** 图标 URL 的版本号与后端和静态入口保持一致。 / Keep icon URL versions aligned with the backend and static entry. */

/** 与 backends/worker/src/lib/brand.ts 的 BRAND_ICON_VERSION 一致。 / Match BRAND_ICON_VERSION in backends/worker/src/lib/brand.ts. */
export const ICON_VERSION = 3;

/** 与 backends/worker/src/lib/brand.ts 的 BRAND_ICON_PATH 一致。 / Match BRAND_ICON_PATH in backends/worker/src/lib/brand.ts. */
export const ICON_PATH = '/api/public/icon';

/**
 * Build an icon URL for display.
 *
 * `tight` crops the mark to its ink, for use inline next to text where the
 * padded canvas would make it look undersized. Omit it for favicons.
 *
 * 构造展示图标 URL；`tight` 裁去留白，适合文字旁的图标，favicon 不使用此参数。
 */
export const buildIconProxyUrl = (pageId?: string, opts: { tight?: boolean } = {}): string => {
  const params = new URLSearchParams();
  // Version first, so URLs read consistently and two call sites are easy to diff. / 版本参数放在最前，保持 URL 一致并便于比较调用结果。
  params.set('v', String(ICON_VERSION));
  if (pageId) params.set('pageId', pageId);
  if (opts.tight) params.set('tight', '1');
  return `${ICON_PATH}?${params.toString()}`;
};

/** 优先使用非空的配置图标；内置图标路径重建版本参数，无配置时使用默认标记。 / Prefer a nonempty configured icon; rebuild version parameters for the built-in path and otherwise fall back to the default mark. */
export const resolveSiteIconUrl = (
  siteMeta: { icon?: string | null; iconCandidates?: Array<string | null | undefined> | null } | undefined,
  pageId?: string,
  opts: { tight?: boolean } = {},
): string => {
  const fallback = buildIconProxyUrl(pageId, opts);
  const candidates = [siteMeta?.icon, ...(siteMeta?.iconCandidates ?? [])];
  for (const candidate of candidates) {
    const raw = typeof candidate === 'string' ? candidate.trim() : '';
    if (!raw) continue;
    if (raw === ICON_PATH || raw.startsWith(`${ICON_PATH}?`)) {
      // Rebuild rather than splice: the stored value may carry a stale `v`. / 重新构造 URL，不直接拼接：存储值可能含旧版本号。
      const params = new URLSearchParams();
      params.set('v', String(ICON_VERSION));
      if (pageId) params.set('pageId', pageId);
      if (opts.tight) params.set('tight', '1');
      return `${ICON_PATH}?${params.toString()}`;
    }
    return raw;
  }
  return fallback;
};

/** The favicon / app-icon form: padded, optionally with its own surface. / favicon 或应用图标版本：保留留白，可选底板。 */
export const buildIconAssetUrl = (opts: { size?: number; container?: boolean } = {}): string => {
  const params = new URLSearchParams();
  params.set('v', String(ICON_VERSION));
  if (opts.size) params.set('size', String(opts.size));
  if (opts.container) params.set('container', '1');
  return `${ICON_PATH}?${params.toString()}`;
};
