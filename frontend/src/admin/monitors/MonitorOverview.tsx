import { Activity, CalendarClock, Gauge, ShieldAlert, Zap } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { AnimatedNumber, SparkLine } from '../../components/ui/MetricFigures';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import { incidentsToday } from '../components/event-presentation';
import { StatBand, StatCell } from '../components/SummaryStats';
import { formatAvailability, formatMs } from '../format';
import { useEvents } from '../useConsoleData';
import { currentLatency, expiries, fleetDays, meanUptime, recentLatency, seriesStats } from './insights';
import type { OverviewCounts, OverviewMonitor } from './types';

/**
 * The monitor fleet in one line of figures.
 *
 * Five figures in one frame, each answering one question an operator opens the
 * page with: how available, how fast, what needs me, what is about to lapse, and
 * how today has gone. The figures that can be drilled into are buttons - "2 need
 * attention" filters the list below to those two.
 *
 * 通过五个指标展示可用率、速度、待处理项、即将到期项及今日情况；可深入查看的指标
 * 使用按钮，例如“2 项需关注”会将下方列表筛选为这两项。
 */
interface MonitorOverviewProps {
  counts: OverviewCounts;
  monitors: OverviewMonitor[];
  stateFilter: string | null;
  onFilter: (bucket: string) => void;
}

/** Thirty days, the horizon a certificate or a domain renewal is worth flagging inside. / 证书或域名续期的提醒窗口为 30 天。 */
const EXPIRY_HORIZON = 30;

/**
 * Memoised for the same reason as `MonitorInsights`: the page re-renders on
 * unrelated state (opening the monitor drawer), and this card draws a chart
 * plus a set of derived statistics that do not depend on that state.
 *
 * `onFilter` must be stable at the call site or the memo is pointless.
 *
 * 与 `MonitorInsights` 一样使用 memo：打开监控抽屉等无关状态会使页面重新渲染，
 * 而此卡片的图表和派生统计不依赖这些状态。调用方必须保持 `onFilter` 稳定，
 * 否则缓存无效。
 */
export const MonitorOverview = memo(function MonitorOverview({ counts, monitors, stateFilter, onFilter }: MonitorOverviewProps) {
  const t = useTranslations('admin');
  const ago = useTimeAgo();
  const events = useEvents(30);

  const derived = useMemo(() => {
    const active = counts.total - counts.paused;
    const uptime = meanUptime(monitors);
    const days = fleetDays(monitors).slice(-30);
    const recent = recentLatency(monitors);
    const latencySeries = recent.map((bucket) => bucket.avg);
    const latency = currentLatency(monitors);
    const p95 = seriesStats(latencySeries).p95;
    const issues = monitors.filter((m) => m.active && (m.st === 0 || m.st === 4 || m.st === 2));
    const lapsing = expiries(monitors).filter((item) => item.days !== null && item.days <= EXPIRY_HORIZON);
    return {
      active,
      uptime,
      availabilitySeries: days.map((day) => day.availability),
      latency,
      latencySeries,
      p95,
      issues,
      lapsing,
    };
  }, [counts, monitors]);

  const today = incidentsToday(events.data?.events ?? []);
  const lastEvent = (events.data?.events ?? []).reduce((max, event) => Math.max(max, event.created_at), 0);
  const attention = counts.down + counts.pending + counts.warn;
  const worst = counts.down ? 'down' : counts.pending ? 'pending' : counts.warn ? 'warn' : null;
  const nextLapse = derived.lapsing[0];

  return (
    <StatBand className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
      <StatCell
        icon={<Activity />}
        label={t('col.uptime')}
        value={formatAvailability(derived.uptime)}
        sub={t('kpi.availabilitySub', { n: derived.active })}
      >
        <SparkLine values={derived.availabilitySeries} height={30} className="text-success" />
      </StatCell>

      <StatCell
        icon={<Zap />}
        label={t('quick.avgLatency')}
        value={formatMs(derived.latency)}
        sub={derived.p95 !== null ? `P95 ${formatMs(derived.p95)}` : t('insights.noLatency')}
      >
        <SparkLine values={derived.latencySeries} height={30} className="text-[var(--polaris-chart)]" />
      </StatCell>

      <StatCell
        icon={<ShieldAlert />}
        label={t('stat.attention')}
        value={<AnimatedNumber value={attention} />}
        tone={worst ?? undefined}
        onPress={attention ? () => onFilter(worst ?? 'down') : undefined}
        active={Boolean(stateFilter) && stateFilter === worst}
        sub={
          attention ? (
            <span title={derived.issues.map((m) => m.name).join(', ')}>
              {derived.issues
                .slice(0, 2)
                .map((m) => m.name)
                .join(', ')}
              {derived.issues.length > 2 ? ` +${derived.issues.length - 2}` : ''}
            </span>
          ) : (
            t('stat.allClear')
          )
        }
      />

      <StatCell
        icon={<CalendarClock />}
        label={t('kpi.expiring')}
        value={<AnimatedNumber value={derived.lapsing.length} />}
        tone={nextLapse && nextLapse.days !== null && nextLapse.days <= 7 ? 'down' : derived.lapsing.length ? 'warn' : undefined}
        sub={
          nextLapse
            ? t('kpi.expiringNext', { name: nextLapse.monitor.name, n: Math.max(0, Math.round(nextLapse.days ?? 0)) })
            : t('kpi.expiringNone', { n: EXPIRY_HORIZON })
        }
      />

      <StatCell
        icon={<Gauge />}
        label={t('kpi.events')}
        value={<AnimatedNumber value={today} />}
        tone={today > 0 ? 'down' : undefined}
        sub={lastEvent ? t('kpi.lastEvent', { ago: ago(lastEvent) }) : t('console.eventsEmpty')}
      />
    </StatBand>
  );
});
