import clsx from 'clsx';

import type { ReactNode } from 'react';
import type { Tone } from '../../types/tone';
import { StatusDot } from './StatusDot';

/** Tile dimensions per size. Exported so the console's vendor logos share one scale. / 各尺寸的图标块规格，供控制台供应商标志共用。 */
export const TILE: Record<'xs' | 'sm' | 'md' | 'lg', { box: string; px: number }> = {
  xs: { box: 'h-6 w-6 rounded-md', px: 13 },
  sm: { box: 'h-7 w-7 rounded-lg', px: 15 },
  md: { box: 'h-8 w-8 rounded-[9px]', px: 17 },
  lg: { box: 'h-10 w-10 rounded-xl', px: 21 },
};

export type GlyphSize = keyof typeof TILE;

/** The white tile every mark sits on. / 承载标志的白色方块。 */
export function GlyphTile({
  size = 'md',
  className,
  children,
  badge,
}: {
  size?: GlyphSize;
  className?: string;
  children: ReactNode;
  /** A status light on the tile's corner, like a presence dot on an avatar. / 方块角落的状态灯，类似头像上的在线状态圆点。 */
  badge?: Tone | 'maintenance';
}) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'relative inline-flex shrink-0 items-center justify-center border border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-3)] shadow-[0_1px_1px_rgb(0_0_0/0.04)]',
        TILE[size].box,
        className,
      )}
    >
      {children}
      {badge ? (
        <span className="absolute -right-[3px] -bottom-[3px] inline-flex rounded-full ring-[2.5px] ring-[var(--polaris-panel)]">
          {badge === 'maintenance' ? (
            <span className="inline-block h-2 w-2 rounded-full bg-[#3b82f6]" />
          ) : (
            <StatusDot tone={badge} pulse={badge === 'down'} />
          )}
        </span>
      ) : null}
    </span>
  );
}
