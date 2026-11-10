import clsx from 'clsx';

import { Check, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { FEEDBACK_TRANSITION, NAV_TRANSITION } from '@/lib/motion';
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
 * A command to paste into a shell, drawn as the terminal it is going into.
 * Dark in both themes on purpose: a light code box reads as documentation
 * rather than as something to run.
 *
 * 显示要粘贴到 shell 的命令，外观模仿目标终端。两种主题下均使用深色，
 * 因为浅色代码框更像文档，而不像需要执行的命令。
 */
export function CodeBlock({
  code,
  onCopy,
  copied = false,
  copyLabel,
  copiedLabel,
  prompt = true,
  className,
}: {
  code: string;
  onCopy?: () => void;
  copied?: boolean;
  copyLabel: string;
  copiedLabel?: string;
  prompt?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <div
      className={clsx(
        'group relative overflow-hidden rounded-[10px] bg-[#0c0c0d] ring-1 ring-black/5 dark:ring-white/10',
        className,
      )}
    >
      <pre className="overflow-x-auto px-4 py-3 pr-24 font-mono text-[12px] leading-relaxed text-zinc-200">
        {prompt ? <span className="mr-2 select-none text-zinc-500">$</span> : null}
        <code className="break-all whitespace-pre-wrap">{code}</code>
      </pre>
      {onCopy ? (
        <motion.button
          layout={reduced ? false : 'size'}
          transition={NAV_TRANSITION}
          type="button"
          onClick={onCopy}
          className={clsx(
            'absolute top-2 right-2 inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium transition-colors',
            copied ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/[0.08] text-zinc-300 hover:bg-white/15',
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span key={copied ? 'copied' : 'copy'}
              className="inline-flex items-center gap-1.5"
              initial={{ opacity: 0, y: reduced ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduced ? 0 : -4 }}
              transition={FEEDBACK_TRANSITION}>
              {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              {copied ? (copiedLabel ?? copyLabel) : copyLabel}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      ) : null}
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

/** A dotted rule, label on the left and a figure on the right. / 点状分隔行，左侧为标签，右侧为数值。 */
export function SectionTitle({
  title,
  hint,
  actions,
  className,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('mb-3 flex flex-wrap items-end gap-x-3 gap-y-1', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">{title}</h2>
        {hint ? <p className="text-[12.5px] text-[var(--polaris-ink-3)]">{hint}</p> : null}
      </div>
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
