import type { HistoryStatus } from '../../../../shared/contracts';
import { useTranslations } from 'use-intl';

export function HistoryNotice({ status, sampled, onRetry }: { status?: HistoryStatus; sampled?: boolean; onRetry?: () => void }) {
  const t = useTranslations();
  const failed = status === 'unconfigured' || status === 'unavailable';
  if (!failed && !sampled) return null;
  return (
    <div role={failed ? 'alert' : 'status'} className="mb-4 rounded-lg bg-[var(--polaris-well)] px-4 py-3 text-[13px] leading-relaxed text-[var(--polaris-ink-2)]">
      <p>{t(status === 'unconfigured' ? 'detail.historyUnconfigured' : status === 'unavailable' ? 'detail.historyUnavailable' : 'detail.historySampled')}</p>
      {failed && onRetry ? <button type="button" className="mt-2 underline underline-offset-4" onClick={onRetry}>{t('timer.refreshNow')}</button> : null}
    </div>
  );
}
