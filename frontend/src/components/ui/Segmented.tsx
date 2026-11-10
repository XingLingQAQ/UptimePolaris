import clsx from 'clsx';
import { NAV_TRANSITION } from '@/lib/motion';
import { LayoutGroup, motion } from 'framer-motion';
import { useId } from 'react';

/**
 * A two-option-or-more switch for a view, not a filter. The thumb slides between
 * options, so the change of view reads as one motion.
 *
 * Buttons with `aria-pressed` rather than a tab list: the options swap what one
 * block draws, and nothing about a tab panel's keyboard model applies to that.
 *
 * Shared rather than console-only: the public page's toolbar is its main user,
 * and keeping it in `admin/kit.tsx` put that file - and HeroUI with it - in the
 * public bundle.
 *
 * 用于切换视图而非筛选；滑块在选项间移动。按钮使用 `aria-pressed`，
 * 因为这里不适用标签页面板的键盘交互。组件供公开页面和控制台共用，
 * 避免公开页面通过 `admin/kit.tsx` 引入 HeroUI。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  size = 'sm',
}: {
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const group = useId();
  return (
    <LayoutGroup id={group}>
      <div
        role="group"
        aria-label={label}
        className={clsx('inline-flex items-center gap-0.5 rounded-[9px] bg-[var(--polaris-active)] p-[3px]', className)}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={clsx(
                'polaris-segmented-option relative rounded-[6px] font-medium whitespace-nowrap transition-colors',
                size === 'md' ? 'h-7 px-3 text-[13px]' : 'h-6 px-2.5 text-[12px]',
                active ? 'text-[var(--polaris-ink)]' : 'text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)]',
              )}
            >
              {active ? (
                <motion.span
                  aria-hidden="true"
                  initial={false}
                  layoutId="thumb"
                  className="absolute inset-0 rounded-[6px] bg-[var(--polaris-card)] shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_rgb(0_0_0/0.04)] dark:bg-[#2a2a2e]"
                  transition={NAV_TRANSITION}
                />
              ) : null}
              <span className="relative inline-flex items-center gap-1.5">
                {option.label}
                {option.count !== undefined ? (
                  <span className="polaris-num text-[11px] text-[var(--polaris-ink-4)]">{option.count}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
