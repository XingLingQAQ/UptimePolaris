import { AnimatePresence, motion } from 'framer-motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { AlertCircle, CircleCheck, FlaskConical, Loader2, TriangleAlert, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { formatMs } from '../format';
import type { CheckResult } from './types';

export function MonitorCheckFeedback({ pending, result, error, onDismiss }: {
  pending: boolean;
  result: CheckResult | null;
  error: string | null;
  onDismiss: () => void;
}) {
  const t = useTranslations('admin');
  const reducedMotion = useReducedMotion();
  const failed = Boolean(error) || result?.status === 0;
  const warning = result?.status === 2;
  const Icon = pending ? Loader2 : failed ? AlertCircle : warning ? TriangleAlert : CircleCheck;
  const title = pending ? 'checkRunning' : error ? 'feedbackError' : failed ? 'checkFailed' : warning ? 'checkWarning' : 'checkPassed';
  const tone = pending ? 'text-[var(--polaris-chart)]' : failed ? 'text-danger-600' : warning ? 'text-warning-700' : 'text-success-700';

  return <AnimatePresence initial={false}>
    {pending || result || error ? <motion.div
      key="feedback"
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
      transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.2, 0, 0, 1] }}
      className="px-6 pt-4"
    >
      <div role={failed && !pending ? 'alert' : 'status'} aria-atomic="true" className="polaris-card flex items-start gap-3 rounded-xl px-3.5 py-3 shadow-[0_2px_6px_-3px_rgb(0_0_0/0.12)]">
        <span className={`mt-px flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--polaris-well)] ${tone}`}><Icon size={17} className={pending && !reducedMotion ? 'animate-spin' : undefined} aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] font-semibold ${tone}`}>{t(`form.${title}`)}</p>
          {pending ? <p className="mt-1 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t('form.checkRunningHint')}</p> : null}
          {result && !pending && !error ? <div className="polaris-num mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--polaris-ink-2)]"><span className="inline-flex items-center gap-1 rounded-md bg-[var(--polaris-well)] px-2 py-0.5"><FlaskConical size={11} aria-hidden="true" />{formatMs(result.latencyMs)}</span>{result.statusCode > 0 ? <span className="rounded-md bg-[var(--polaris-well)] px-2 py-0.5">HTTP {result.statusCode}</span> : null}</div> : null}
          {!pending && (error || result?.message) ? <p className="mt-1.5 max-h-28 overflow-y-auto break-words text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{error ?? result?.message}</p> : null}
        </div>
        {!pending ? <button type="button" onClick={onDismiss} aria-label={t('form.dismissFeedback')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--polaris-ink-4)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]"><X size={14} /></button> : null}
      </div>
    </motion.div> : null}
  </AnimatePresence>;
}
