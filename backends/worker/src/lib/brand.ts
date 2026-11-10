/** Uptime Polaris ring geometry, shared by the SVG endpoint and UI mark. / Uptime Polaris 圆环几何参数，由 SVG 端点和界面标记共用。 */

import { BRAND_BLUE, BRAND_RING_PATH, RING, INK_INSET, INK_SIZE, TIGHT_PADDING } from '../../../../shared/brand-mark';
export { BRAND_BLUE, RING, INK_INSET, INK_SIZE, TIGHT_PADDING } from '../../../../shared/brand-mark';

/**
 * Artwork version, appended to every icon URL as `?v=`.
 *
 * Bump whenever the mark changes: `max-age` means a browser will not
 * revalidate, so a redeploy alone stays invisible to returning visitors.
 * Defined once so the console, login page and status navbar cannot drift.
 * 图形变化时递增；只重新部署无法让已缓存旧图的浏览器更新。
 */
export const BRAND_ICON_VERSION = 3;

/** Icon endpoint path; build URLs from this and the version. / 图标端点路径；用它与版本号拼 URL。 */
export const BRAND_ICON_PATH = '/api/public/icon';

/** Arc path: large-arc stays 1 because the sweep is 310 degrees; tests pin the flag. / 圆弧路径：扫过 310 度，large-arc 必须为 1；测试锁定该标志。 */
export function ringPath(color: string, strokeWidth = RING.strokeWidth): string {
  return (
    `<path d="${BRAND_RING_PATH}" ` +
    `fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`
  );
}

export interface IconOptions {
  /**
   * Optional white rounded container; the mark stays brand blue.
   *
   * Only for surfaces where the icon must hold its own background (launcher/app
   * icon). Filling the container brand blue and knocking the mark out inverts
   * the approved artwork.
   * 仅用于需要自带底色的场景；反色会改变已批准的图形。
   */
  container?: boolean;
  /** Mark colour. Defaults to brand blue. / 标记颜色，默认为品牌蓝。 */
  color?: string;
  /** Container fill, when `container` is on. / `container` 启用时容器的填充色。 */
  background?: string;
  /** Rendered size in px. Omit for a scalable icon with no fixed dimensions. / 渲染尺寸（px）；省略时为无固定尺寸的可缩放图标。 */
  size?: number;
  /** Crop the viewBox to the ink for inline use; leave padding for favicons. / 内联使用时紧裁 viewBox；favicon 保留留白。 */
  tight?: boolean;
}

/** Render the mark as a standalone SVG. / 输出独立 SVG。 */
export function brandIconSvg(options: IconOptions = {}): string {
  const {
    container = false,
    color = BRAND_BLUE,
    background = '#ffffff',
    size,
    tight = false,
  } = options;

  const { size: vb, containerRadius } = RING;
  const dims = size ? ` width="${size}" height="${size}"` : '';

  /** `tight` changes the viewBox rather than transforming the path, keeping `d` byte-identical. / `tight` 改 viewBox 而不变换路径，保持 `d` 不变。 */
  const box = tight ? INK_SIZE + TIGHT_PADDING * 2 : vb;
  const offset = tight ? INK_INSET - TIGHT_PADDING : 0;
  const viewBox = tight ? `${offset} ${offset} ${box} ${box}` : `0 0 ${vb} ${vb}`;

  // A container is a fixed-size plate, so it must cover the padded canvas even
  // when the mark is cropped - otherwise the plate would be cut off.
  // 容器是固定尺寸底板，即使裁剪标记也须覆盖带留白画布，否则底板会被裁掉。
  const plate = container
    ? `<rect x="0" y="0" width="${vb}" height="${vb}" rx="${containerRadius}" fill="${background}"/>`
    : '';

  // Container wins over cropping: a plated icon has no padding to remove. / 容器优先于裁剪：带底板的图标没有留白可去。
  const finalViewBox = container ? `0 0 ${vb} ${vb}` : viewBox;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${finalViewBox}"${dims}>` +
    plate +
    ringPath(color) +
    `</svg>`
  );
}
