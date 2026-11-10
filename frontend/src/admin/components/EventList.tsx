import { useLocale } from '@/i18n/IntlProvider';
import clsx from 'clsx';
import { useTranslations } from 'use-intl';
import { StatusDot } from '../../components/ui/StatusDot';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import type { Tone } from '../../types/tone';
import type { EventRow } from './event-presentation';

const KIND: Record<number, { tone: Tone; verb: string }> = {
  0: { tone: 'down', verb: 'eventDown' },
  1: { tone: 'up', verb: 'eventUp' },
  2: { tone: 'warn', verb: 'eventWarn' },
  4: { tone: 'pending', verb: 'eventPending' },
};

const VERB_INK: Record<Tone, string> = {
  down: 'text-danger-600',
  up: 'text-success-700',
  warn: 'text-warning-700',
  pending: 'text-orange-700 dark:text-orange-400',
  idle: 'text-[var(--polaris-ink-3)]',
};

/**
 * A status-change feed, drawn as a timeline: a light per event on one thin
 * line, the monitor's name, what happened to it in words, and when.
 *
 * One component for every place the console shows transitions - the bar's
 * bell, the monitor page's activity block and the settings log - so a down
 * event looks the same wherever it is met. The verb carries the meaning; the
 * colour only speeds up finding it.
 *
 * 状态变化以时间线展示：细线上每个事件一个状态灯，并列出监控项名称、事件文字和时间。
 * 导航栏铃铛、监控页活动区及设置日志共用此组件，使故障事件处处一致；动词承载含义，
 * 颜色只用于加快查找。
 */
export function EventList({
  rows,
  dense = false,
  absolute = false,
  onPick,
  className,
}: {
  rows: EventRow[];
  dense?: boolean;
  /** Show the full timestamp under the relative one, for a log rather than a glance. / 在相对时间下显示完整时间戳，适用于日志而非快速概览。 */
  absolute?: boolean;
  onPick?: (row: EventRow) => void;
  className?: string;
}) {
  const t = useTranslations('admin.insights');
  const { locale } = useLocale();
  const ago = useTimeAgo();

  return (
    <ul className={clsx('flex flex-col', className)}>
      {rows.map((row, index) => {
        const kind = KIND[row.status] ?? KIND[0];
        const stamp = new Date(row.created_at * 1000);
        const Inner = onPick ? 'button' : 'div';
        const last = index === rows.length - 1;
        return (
          <li key={row.id} className="relative">
            {!last ? (
              <span
                aria-hidden="true"
                className={clsx('absolute left-[19px] w-px bg-[var(--polaris-line)]', dense ? 'top-[26px] bottom-[-6px]' : 'top-[30px] bottom-[-8px]')}
              />
            ) : null}
            <Inner
              {...(onPick ? { type: 'button' as const, onClick: () => onPick(row) } : {})}
              className={clsx(
                'relative flex w-full items-start gap-3 rounded-lg px-3 text-left',
                dense ? 'py-2' : 'py-2.5',
                onPick && 'transition-colors hover:bg-[var(--polaris-hover)]',
              )}
            >
              <span className="mt-[5px] flex h-3 w-3.5 shrink-0 items-center justify-center">
                <StatusDot tone={kind.tone} pulse={row.status === 0 && index === 0} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className={clsx('truncate font-medium text-[var(--polaris-ink)]', dense ? 'text-[13px]' : 'text-[13.5px]')}>
                    {row.name ?? t('deletedMonitor')}
                  </span>
                  <span className={clsx('shrink-0 text-[12px]', VERB_INK[kind.tone])}>{t(kind.verb)}</span>
                </span>
                {row.message ? (
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--polaris-ink-3)]" title={row.message}>
                    {row.message}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 flex-col items-end pt-px text-right">
                <time
                  dateTime={stamp.toISOString()}
                  /* `locale`, not the default: without it the title follows the
                     browser's language rather than the one the console is in,
                     so a reader on an English browser saw English dates in a
                     Chinese console.
                     使用控制台的 `locale` 而非浏览器默认语言；否则英文浏览器中的中文控制台
                     会在标题中显示英文日期。 */
                  title={stamp.toLocaleString(locale)}
                  className="polaris-num text-[11.5px] whitespace-nowrap text-[var(--polaris-ink-4)]"
                >
                  {ago(row.created_at)}
                </time>
                {absolute ? (
                  <span className="font-mono text-[10.5px] text-[var(--polaris-ink-4)]">
                    {stamp.toISOString().replace('T', ' ').slice(5, 16)} UTC
                  </span>
                ) : null}
              </span>
            </Inner>
          </li>
        );
      })}
    </ul>
  );
}
