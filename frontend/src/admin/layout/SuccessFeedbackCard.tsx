import { dismissSuccessFeedback, pauseSuccessFeedback, type SuccessFeedback } from '@/components/ui/success-feedback';
import { motion } from 'framer-motion';
import { CircleCheck, X } from 'lucide-react';
import { useEffect, type MouseEvent, type ReactNode } from 'react';
import type { Action } from 'sonner';
import { useTranslations } from 'use-intl';

export function SuccessFeedbackCard({ feedback, compact = false, onOpen, onDismiss }: {
  feedback: SuccessFeedback;
  compact?: boolean;
  onOpen?: () => void;
  onDismiss?: () => void;
}) {
  const t = useTranslations('admin');
  const { options } = feedback;
  const title = typeof feedback.title === 'function' ? feedback.title() : feedback.title;
  const description = typeof options.description === 'function' ? options.description() : options.description;

  useEffect(() => () => {
    pauseSuccessFeedback(feedback.id, 'pointer', false);
    pauseSuccessFeedback(feedback.id, 'focus', false);
  }, [feedback.id]);

  function dismiss() {
    dismissSuccessFeedback(feedback.id, 'manual');
    onDismiss?.();
  }

  return <motion.div
    layout="position"
    role="status"
    aria-live="polite"
    aria-atomic="true"
    data-island-success=""
    onPointerEnter={() => pauseSuccessFeedback(feedback.id, 'pointer', true)}
    onPointerLeave={() => pauseSuccessFeedback(feedback.id, 'pointer', false)}
    onFocusCapture={() => pauseSuccessFeedback(feedback.id, 'focus', true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) pauseSuccessFeedback(feedback.id, 'focus', false); }}
    className={compact ? 'flex min-h-14 items-center gap-3 px-4 py-3' : 'mx-4 mb-3 flex items-start gap-3 rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.055] px-3.5 py-3'}
  >
    <motion.span initial={{ scale: 0.75, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', duration: 0.45, bounce: 0.25, delay: 0.1 }} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-300/10 text-emerald-300">{options.icon ?? <CircleCheck size={19} strokeWidth={1.8} />}</motion.span>
    <div className="min-w-0 flex-1">
      {onOpen ? <button type="button" onClick={onOpen} className="block w-full text-left text-[13px] leading-relaxed font-medium text-zinc-100" aria-haspopup="dialog">{title}</button> : <p className="break-words text-[13px] leading-relaxed font-medium text-zinc-100">{title}</p>}
      {description ? <div className="mt-0.5 max-h-24 overflow-y-auto break-words text-[12px] leading-relaxed text-zinc-400">{description}</div> : null}
      {options.action || options.cancel ? <div className="mt-2 flex flex-wrap gap-2"><FeedbackAction action={options.action} onDone={dismiss} /><FeedbackAction action={options.cancel} onDone={dismiss} /></div> : null}
    </div>
    {options.dismissible !== false ? <button type="button" aria-label={t('agents.close')} onClick={dismiss} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"><X size={14} /></button> : null}
  </motion.div>;
}

function FeedbackAction({ action, onDone }: { action: Action | ReactNode; onDone: () => void }) {
  if (!action) return null;
  if (typeof action === 'object' && 'label' in action && 'onClick' in action) {
    if (typeof action.onClick !== 'function') return null;
    const item = action as Action;
    return <button type="button" onClick={(event: MouseEvent<HTMLButtonElement>) => { item.onClick(event); if (!event.defaultPrevented) onDone(); }} className="rounded-lg bg-white/10 px-2.5 py-1 text-[11.5px] font-medium text-zinc-100 transition-colors hover:bg-white/15">{item.label}</button>;
  }
  return <>{action as ReactNode}</>;
}
