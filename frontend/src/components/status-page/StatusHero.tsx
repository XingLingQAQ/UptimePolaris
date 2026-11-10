import { AnimatedNumber } from '@/components/ui/MetricFigures';
import type { MonitorStatusCounts, SystemStatus } from '@/lib/monitor-status';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Loader2, Pause, Play, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { useFormatter, useTranslations } from 'use-intl';
import { uptimeInk } from './status';
import type { RefreshTimer } from './useRefreshTimer';

const ORB: Record<SystemStatus | 'loading', { tone: string; icon: typeof Check; ring: string }> = {
  normal: { tone: 'text-success', icon: Check, ring: 'bg-success/10' },
  warning: { tone: 'text-warning', icon: TriangleAlert, ring: 'bg-warning/12' },
  error: { tone: 'text-danger', icon: X, ring: 'bg-danger/10' },
  unknown: { tone: 'text-default-400', icon: TriangleAlert, ring: 'bg-default-100' },
  loading: { tone: 'text-default-400', icon: Loader2, ring: 'bg-default-100' },
};

const HEADLINE: Record<SystemStatus, string> = {
  normal: 'status.systemNormal',
  warning: 'status.systemWarning',
  error: 'status.systemError',
  unknown: 'status.systemUnknown',
};

/** The countdown to the next refresh as a ring around the refresh glyph. / 刷新图标周围的圆环表示距下次刷新的倒计时。 */
function CountdownRing({ progress, spinning }: { progress: number; spinning: boolean }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex h-[18px] w-[18px] items-center justify-center">
      <svg viewBox="0 0 18 18" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="1.5" className="stroke-[var(--polaris-line-strong)]" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - progress)}
          className="stroke-[var(--polaris-ink-2)] transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <RefreshCw size={9} strokeWidth={2.5} className={clsx('relative', spinning && 'animate-spin')} />
    </span>
  );
}

/**
 * The top of the page: one sentence about the whole system, the counts behind
 * it, the day's availability, and the refresh clock.
 *
 * The orb is the only large colour on the page, and it is the colour of the
 * worst thing on it - the reader knows the answer before reading a word. When
 * the answer changes while the page is open, the orb settles into its new
 * colour and the sentence slides over, so the change is seen, not just shown.
 *
 * 页面顶部以一句话概括系统，并显示相关统计数量、当日可用率和刷新时间。
 * 状态球是页面唯一的大面积颜色，使用最严重状态的颜色，让访客读文字之前就能了解情况。
 * 页面打开期间状态变化时，状态球过渡到新颜色、文字滑动，直观提示变化。
 */
export function StatusHero({
  counts,
  status,
  loading,
  timer,
  uptime24h,
}: {
  counts: MonitorStatusCounts;
  status: SystemStatus;
  loading: boolean;
  timer: RefreshTimer;
  uptime24h: number | null;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const state = loading ? 'loading' : status;
  const orb = ORB[state];
  const Icon = orb.icon;

  const parts: Array<{ key: string; dot: string; label: string; n: number }> = [];
  if (!loading) {
    if (counts.down) parts.push({ key: 'down', dot: 'bg-danger', label: t('node.offline'), n: counts.down });
    if (counts.warn) parts.push({ key: 'warn', dot: 'bg-warning', label: t('common.status.warn'), n: counts.warn });
    if (counts.pending) parts.push({ key: 'pending', dot: 'bg-warning', label: t('node.pending'), n: counts.pending });
    if (counts.unknown) parts.push({ key: 'unknown', dot: 'bg-default-300', label: t('common.status.unknown'), n: counts.unknown });
    parts.push({ key: 'up', dot: 'bg-success', label: t('node.online'), n: counts.up });
  }

  return (
    <section className="pt-10 pb-7 sm:pt-14">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-4 sm:gap-5">
          <span
            key={state}
            className={clsx('polaris-pop relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full transition-colors duration-500', orb.ring, orb.tone)}
          >
            {!loading && status !== 'unknown' ? (
              <span aria-hidden="true" className="polaris-ripple absolute inset-2 rounded-full opacity-60" />
            ) : null}
            <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-current shadow-[0_6px_16px_-6px_currentColor]">
              <Icon size={17} strokeWidth={2.5} className={clsx('text-white', loading && 'animate-spin')} />
            </span>
          </span>
          <div className="min-w-0">
            {/* The page's one <h1>: the answer the visitor came for. / 页面唯一的 <h1>：展示访客关注的总体状态。 */}
            <div className="relative overflow-hidden">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.h1
                  key={state}
                  initial={{ y: '60%', opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: '-60%', opacity: 0 }}
                  transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                  className="text-[24px] leading-tight font-semibold tracking-[-0.025em] text-[var(--polaris-ink)] sm:text-[30px]"
                >
                  {loading ? t('status.loading') : t(HEADLINE[status])}
                </motion.h1>
              </AnimatePresence>
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--polaris-ink-3)]">
              {loading ? (
                <span className="polaris-shimmer h-4 w-48 rounded" />
              ) : (
                <>
                  <span className="polaris-num">{t('common.island.monitors', { n: counts.total })}</span>
                  {parts.map((part) => (
                    <span key={part.key} className="polaris-num flex items-center gap-1.5">
                      <span className={clsx('h-1.5 w-1.5 rounded-full', part.dot, part.key === 'down' && 'polaris-halo')} />
                      {part.label} <AnimatedNumber value={part.n} />
                    </span>
                  ))}
                  {uptime24h !== null ? (
                    <span className="polaris-num flex items-center gap-1.5">
                      <span className="text-[var(--polaris-ink-4)]">·</span>
                      {t('common.col.uptime')}
                      <span className={clsx('font-medium', uptimeInk(uptime24h))}>
                        <AnimatedNumber value={Math.min(100, uptime24h * 100)} decimals={2} suffix="%" />
                      </span>
                      <span className="text-[11px] text-[var(--polaris-ink-4)]">24h</span>
                    </span>
                  ) : null}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 sm:ml-auto sm:items-end">
          <div className="inline-flex h-8 w-max items-center rounded-full border border-[var(--polaris-line)] bg-[var(--polaris-card)] p-0.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
            <button
              type="button"
              onClick={timer.togglePause}
              aria-label={timer.paused ? t('timer.paused') : t('timer.pause')}
              title={timer.paused ? t('timer.paused') : t('timer.pause')}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]"
            >
              {timer.paused ? <Play size={13} /> : <Pause size={13} />}
            </button>
            <span className="mx-0.5 h-4 w-px bg-[var(--polaris-line)]" />
            <button
              type="button"
              onClick={timer.refresh}
              disabled={timer.refreshing}
              title={t('timer.refreshNow')}
              className="flex h-7 items-center gap-2 rounded-full pr-3 pl-2 text-[12px] font-medium text-[var(--polaris-ink-2)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)] disabled:opacity-60"
            >
              <CountdownRing progress={timer.paused ? 0 : timer.progress} spinning={timer.refreshing} />
              {timer.refreshing ? (
                t('timer.refreshing')
              ) : timer.paused ? (
                t('timer.refreshNow')
              ) : (
                <span className="polaris-num">{t('timer.nextTime', { sec: timer.secondsLeft })}</span>
              )}
            </button>
          </div>
          {/* Re-keyed on every refresh, so the time settles in when it changes. / 每次刷新时更新键，让时间变化时播放入场动效。 */}
          {timer.lastRefresh !== null ? <span key={timer.lastRefresh} className="polaris-rise polaris-num flex items-center gap-1.5 text-[11.5px] text-[var(--polaris-ink-3)]">
            <span className={clsx('h-1.5 w-1.5 rounded-full', timer.paused ? 'bg-default-300' : 'polaris-live bg-success')} />
            {t('timer.lastTime', {
              time: format.dateTime(new Date(timer.lastRefresh), { hour: 'numeric', minute: 'numeric', second: 'numeric' }),
            })}
          </span> : null}
        </div>
      </div>

      {/* The countdown as a hairline: it fills toward the next refresh. / 细线显示倒计时进度，临近下次刷新时逐渐填满。 */}
      <div className="relative mt-7 h-px overflow-hidden bg-[var(--polaris-line)]">
        <span
          className="absolute inset-y-0 left-0 bg-[var(--polaris-ink)] opacity-25 transition-[width] duration-1000 ease-linear"
          style={{ width: `${Math.round(timer.progress * 100)}%` }}
        />
      </div>
    </section>
  );
}
