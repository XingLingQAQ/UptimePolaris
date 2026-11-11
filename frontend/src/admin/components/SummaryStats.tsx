import clsx from 'clsx';

import type { ReactNode } from 'react';
import type { Tone } from '../../types/tone';

/**
 * A row of figures in one frame, split by hairlines.
 *
 * One container rather than a card per number: the figures are read across as
 * one sentence about the page, and separate cards would make each a destination.
 *
 * 一排指标由细线分隔并放在同一框架中；横向阅读时它们共同概括页面，
 * 若拆成独立卡片则会让每个指标显得像单独的目的地。
 */
export function StatBand({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // Each cell draws its own top and left hairline, shifted out by a pixel; the
    // frame clips the ones on the outer edge. That keeps the rules right however
    // many rows the grid wraps into, which `divide-x` does not.
    // 各格绘制向外偏移 1px 的上边和左边细线，框架裁掉外缘；
    // 无论网格换成多少行都能保持分隔线正确，`divide-x` 无法做到。
    <div className={clsx('polaris-card grid overflow-hidden', className)}>{children}</div>
  );
}

/** One figure in a `StatBand`. / `StatBand` 中的一个指标。 */
export function StatCell({
  label,
  icon,
  value,
  sub,
  aside,
  onPress,
  active,
  tone,
  children,
}: {
  label: string;
  icon?: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  onPress?: () => void;
  active?: boolean;
  tone?: Tone;
  children?: ReactNode;
}) {
  const Tag = onPress ? 'button' : 'div';
  return (
    <Tag
      type={onPress ? 'button' : undefined}
      onClick={onPress}
      aria-pressed={onPress ? Boolean(active) : undefined}
      className={clsx(
        'relative -mt-px -ml-px flex min-w-0 flex-col gap-1 border-t border-l border-[var(--polaris-line-soft)] px-5 py-4 text-left transition-colors',
        onPress && 'cursor-pointer hover:bg-[var(--polaris-hover)]',
        active && 'bg-[var(--polaris-hover)]',
      )}
    >
      {active ? <span aria-hidden="true" className="absolute inset-x-5 bottom-0 h-0.5 rounded-full bg-[var(--polaris-ink)]" /> : null}
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
        {icon ? (
          <span aria-hidden="true" className="inline-flex text-[var(--polaris-ink-4)] [&>svg]:h-3.5 [&>svg]:w-3.5">
            {icon}
          </span>
        ) : null}
        <span className="truncate">{label}</span>
        {aside ? <span className="ml-auto flex shrink-0 items-center">{aside}</span> : null}
      </span>
      <span className="flex min-w-0 items-end justify-between gap-3">
        <span
          className={clsx(
            'polaris-num truncate text-[26px] leading-[1.15] font-semibold tracking-[-0.02em]',
            tone === 'down'
              ? 'text-danger-600'
              : tone === 'warn'
                ? 'text-warning-700'
                : tone === 'pending'
                  ? 'text-orange-700 dark:text-orange-400'
                  : 'text-[var(--polaris-ink)]',
          )}
        >
          {value}
        </span>
        {children ? <span className="mb-1 flex w-24 shrink-0 items-end">{children}</span> : null}
      </span>
      {sub ? <span className="block min-w-0 truncate text-[12px] text-[var(--polaris-ink-3)]">{sub}</span> : null}
    </Tag>
  );
}
