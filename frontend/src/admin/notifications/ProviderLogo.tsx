import { Bird, Megaphone, Webhook } from 'lucide-react';
import type { ReactNode } from 'react';
import { siDiscord, siTelegram, siWechat, type SimpleIcon } from 'simple-icons';
import type { GlyphSize } from '../../components/ui/GlyphTile';
import { GlyphTile, TILE } from '../../components/ui/GlyphTile';

/**
 * Real-world marks for the things the console lists.
 *
 * The colour on a console page should come from the world it describes - a
 * site's own favicon, a vendor's logo - rather than from tinted squares the
 * console invents. These components draw those marks on one shared white tile,
 * so a list of mixed sources still lines up as one column.
 *
 * The monitor mark itself (`SiteGlyph`) lives in `components/shared/glyphs`,
 * because the public page draws one per row: keeping it here put
 * `simple-icons` - every vendor logo in the package - plus this file's
 * `admin/api` and `admin/ui` imports into the public bundle. What remains below
 * is notification-channel branding, which only the console shows.
 *
 * 控制台的颜色来自站点 favicon 和供应商标志，而非自行指定的彩色方块；标志统一放在
 * 白色图标块中，使混合来源的列表对齐。监控标志因公开页每行都要显示而单独放置，
 * 避免公开包引入整个 simple-icons 供应商图标包及控制台模块；此处保留仅供控制台使用
 * 的通知渠道品牌。
 */

export type { GlyphType } from '../../components/monitor/MonitorGlyph';
export type { GlyphSize } from '../../components/ui/GlyphTile';

/** Relative luminance of a hex colour, to keep near-black marks visible in dark mode. / 计算十六进制颜色的相对亮度，使近黑标志在深色模式下可见。 */
function isDark(hex: string): boolean {
  const n = Number.parseInt(hex, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 60;
}

/** A simple-icons mark in its own colour (or in ink, when its colour is near black). / simple-icons 标志使用自身颜色；接近黑色时使用文字色。 */
export function SimpleMark({ icon, px, mono = false }: { icon: SimpleIcon; px: number; mono?: boolean }) {
  const ink = mono || isDark(icon.hex);
  return (
    <svg
      viewBox="0 0 24 24"
      width={px}
      height={px}
      role="img"
      aria-label={icon.title}
      className={ink ? 'text-[var(--polaris-ink)]' : undefined}
      fill={ink ? 'currentColor' : `#${icon.hex}`}
    >
      <path d={icon.path} />
    </svg>
  );
}

// -------------------------------------------------------------- providers / 服务商

/** Slack's mark is not in simple-icons; this is a four-colour pinwheel in its palette. / simple-icons 不含 Slack 标志；此处使用其配色绘制四色风车。 */
function SlackMark({ px }: { px: number }) {
  return (
    <svg viewBox="0 0 24 24" width={px} height={px} role="img" aria-label="Slack">
      <rect x="6.3" y="1.6" width="3.8" height="10.2" rx="1.9" fill="#36C5F0" />
      <rect x="12.2" y="6.3" width="10.2" height="3.8" rx="1.9" fill="#2EB67D" />
      <rect x="13.9" y="12.2" width="3.8" height="10.2" rx="1.9" fill="#ECB22E" />
      <rect x="1.6" y="13.9" width="10.2" height="3.8" rx="1.9" fill="#E01E5A" />
    </svg>
  );
}

/**
 * A notification channel's vendor, as its mark on the shared tile.
 *
 * Keyed by the channel type string so an unknown future type still renders -
 * as the generic webhook glyph - rather than as nothing.
 *
 * 按通知渠道类型显示供应商标志；未知类型回退为通用 webhook 图标。
 */
export function ProviderLogo({ type, size = 'md', className }: { type: string; size?: GlyphSize; className?: string }) {
  const px = TILE[size].px;
  let mark: ReactNode;
  switch (type) {
    case 'telegram':
      mark = <SimpleMark icon={siTelegram} px={px} />;
      break;
    case 'discord':
      mark = <SimpleMark icon={siDiscord} px={px} />;
      break;
    case 'slack':
      mark = <SlackMark px={px} />;
      break;
    case 'feishu':
      mark = <Bird size={px} className="text-[#3370FF]" strokeWidth={2} />;;
      break;
    case 'serverchan':
      mark = <SimpleMark icon={siWechat} px={px} />;
      break;
    case 'apprise':
      mark = <Megaphone size={px} className="text-[#4F46E5]" strokeWidth={2} />;
      break;
    default:
      mark = <Webhook size={px} className="text-[var(--polaris-ink-2)]" />;
  }
  return (
    <GlyphTile size={size} className={className}>
      {mark}
    </GlyphTile>
  );
}
