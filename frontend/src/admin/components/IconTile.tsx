import clsx from 'clsx';

import type { ReactNode } from 'react';
import type { Hue } from '../../types/tone';

/* Identity hues are ignored; only status colours carry meaning. / 忽略身份色；只有状态色有意义。 */
const HUE_TILE: Record<Hue, string> = {
  primary: 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)]',
  success: 'border-success/25 bg-success/[0.07] text-success-700',
  warning: 'border-warning/30 bg-warning/[0.08] text-warning-700',
  danger: 'border-danger/25 bg-danger/[0.06] text-danger-600',
  amber: 'border-orange-500/25 bg-orange-500/[0.07] text-orange-700 dark:text-orange-400',
  violet: 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)]',
  cyan: 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)]',
  indigo: 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)]',
  pink: 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)]',
  default: 'border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-3)]',
};

const TILE_SIZE = {
  xs: 'h-6 w-6 rounded-md [&>svg]:h-3.5 [&>svg]:w-3.5',
  sm: 'h-7 w-7 rounded-lg [&>svg]:h-3.5 [&>svg]:w-3.5',
  md: 'h-8 w-8 rounded-lg [&>svg]:h-4 [&>svg]:w-4',
  lg: 'h-10 w-10 rounded-xl [&>svg]:h-[18px] [&>svg]:w-[18px]',
} as const;

/** An icon in a small framed square. The svg is sized by the tile, so callers pass a bare icon. / 小型方框图标；方框负责 SVG 尺寸，调用方只需传入图标。 */
export function IconTile({
  icon,
  hue = 'primary',
  size = 'md',
  className,
}: {
  icon: ReactNode;
  hue?: Hue;
  size?: keyof typeof TILE_SIZE;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center border shadow-[0_1px_1px_rgb(0_0_0/0.03)]',
        TILE_SIZE[size],
        HUE_TILE[hue],
        className,
      )}
    >
      {icon}
    </span>
  );
}
