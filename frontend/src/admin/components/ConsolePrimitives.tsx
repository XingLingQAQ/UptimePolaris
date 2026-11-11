import clsx from 'clsx';

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

/** An empty state that says what belongs here, with the art for its kind. / 说明此处应有内容的空状态，并展示对应类型的插图。 */
export function EmptyState({
  art,
  title,
  hint,
  action,
  className,
}: {
  art?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center px-6 py-14 text-center', className)}>
      {art ? <div className="mb-5 opacity-90">{art}</div> : null}
      <p className="text-[14px] font-semibold text-[var(--polaris-ink)]">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">{hint}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * A numbered step, for a procedure that has to happen in order. The steps share
 * one vertical line, so the procedure reads as a sequence rather than as cards.
 *
 * 有顺序的操作步骤使用编号，并共用一条竖线，让流程看起来是连续步骤而非独立卡片。
 */
export function Step({
  n,
  title,
  hint,
  done = false,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="relative pb-6 pl-10 last:pb-0 [&:last-child>.polaris-step-line]:hidden">
      <span aria-hidden="true" className="polaris-step-line absolute top-8 bottom-0 left-[13px] w-px bg-[var(--polaris-line)]" />
      <span
        className={clsx(
          'absolute top-0 left-0 inline-flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-semibold',
          done
            ? 'bg-success/10 text-success-700 ring-1 ring-success/30'
            : 'bg-[var(--polaris-ink)] text-[var(--polaris-canvas)]',
        )}
      >
        {done ? <Check size={14} strokeWidth={2.5} aria-hidden="true" /> : n}
      </span>
      <div className="mb-3 pt-0.5">
        <h3 className="text-[14px] font-semibold text-[var(--polaris-ink)]">{title}</h3>
        {hint ? <p className="mt-0.5 text-[12.5px] text-[var(--polaris-ink-3)]">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Label/value rows, for a detail view. / 详情页使用的标签与值列表。 */
export function KeyValueList({
  items,
  className,
}: {
  items: Array<{ label: string; value: ReactNode; mono?: boolean; title?: string }>;
  className?: string;
}) {
  return (
    <dl className={clsx('polaris-card polaris-divide overflow-hidden', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-4 px-4 py-2.5">
          <dt className="shrink-0 text-[12.5px] text-[var(--polaris-ink-3)]">{item.label}</dt>
          <dd
            className={clsx(
              'ml-auto min-w-0 truncate text-right text-[13px] text-[var(--polaris-ink)]',
              item.mono && 'font-mono text-[12px]',
            )}
            title={item.title ?? (typeof item.value === 'string' ? item.value : undefined)}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
