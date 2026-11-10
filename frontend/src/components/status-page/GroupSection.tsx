import type { MonitorGroup, MonitoringData } from '@/types/monitor';
import { usePresentationView } from '@/components/context/PresentationViewContext';
import clsx from 'clsx';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { useMotionList } from '@/lib/useMotionList';
import { MotionDisclosure } from '@/components/ui/MotionDisclosure';
import { ChevronDown } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslations } from 'use-intl';
import { MonitorRow, MonitorTile } from './MonitorItems';
import { STATUS_DOT, monitorStatus, type PublicStatus } from './status';
import type { ViewMode } from './Toolbar';

export interface PageGroup extends MonitorGroup {
  isGroupMatched?: boolean;
}

const COLLAPSED_KEY = 'uptime-polaris.status.collapsed';

function readCollapsed(): Set<number> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is number => typeof id === 'number') : []);
  } catch {
    return new Set();
  }
}

/** Which groups the visitor folded away, remembered per browser. / 按浏览器记住访客折叠的分组。 */
function useCollapsed(id: number): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().has(id));
  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      try {
        const ids = readCollapsed();
        if (next) ids.add(id);
        else ids.delete(id);
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
      } catch {
        // Private browsing: the fold lasts for this visit only. / 隐私浏览模式下折叠状态仅在本次访问中保留。
      }
      return next;
    });
  }, [id]);
  return [collapsed, toggle];
}

const ORDER: PublicStatus[] = ['down', 'warn', 'pending', 'unknown', 'up'];

/**
 * One group of monitors: its name, a small proportional bar of its states, how
 * many are fine, and the monitors as a list or a grid.
 *
 * The header folds the group away - a visitor who only cares about one part of
 * a long page can put the rest out of sight, and the page remembers. A group
 * that is searched into opens regardless, so a match is never hidden.
 *
 * 分组展示名称、小型状态比例条、正常数量以及列表或网格形式的监控项。
 * 点击页头可折叠分组，让只关注长页面一部分的访客隐藏其余内容，页面会记住选择；
 * 搜索命中的分组始终展开，避免隐藏结果。
 */
export function GroupSection({
  group,
  data,
  view,
  index = 0,
}: {
  group: PageGroup;
  data: MonitoringData;
  view: ViewMode;
  index?: number;
}) {
  const t = useTranslations();
  const list = useMotionList<HTMLUListElement>();
  const reduced = useReducedMotion();
  const presentation = usePresentationView();
  /**
   * The bucket of monitors in no group carries no name: the Worker sends
   * `isUngrouped` instead of a label, because the label is a translation. The
   * `<h2>` is rendered unconditionally, so this fallback must be non-empty.
   *
   * 未分组项由 Worker 发送 `isUngrouped` 而非名称；标题始终渲染，故使用非空本地化回退文案。
   */
  const label = group.name ?? t('node.ungrouped');
  const [folded, toggle] = useCollapsed(group.id);
  const collapsed = folded && !group.isGroupMatched;
  const statuses = group.monitorList.map((monitor) => monitorStatus(monitor, data.heartbeatList[monitor.id]));
  const up = statuses.filter((status) => status === 'up').length;
  const down = statuses.filter((status) => status === 'down').length;
  const total = statuses.length;
  const mix = ORDER.map((status) => ({ status, n: statuses.filter((s) => s === status).length })).filter((row) => row.n > 0);
  const delay = Math.min(index, 5) * 28;

  return (
    <section className="polaris-rise mb-10 last:mb-0" style={{ animationDelay: reduced ? '0ms' : `${delay}ms` }}>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="min-w-0 text-[16px] leading-6 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            className="group -ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:text-[var(--polaris-ink-2)]"
          >
            <ChevronDown
              size={16}
              className={clsx(
                'shrink-0 text-[var(--polaris-ink-4)] transition-transform duration-200 group-hover:text-[var(--polaris-ink-2)]',
                collapsed && '-rotate-90',
              )}
            />
            <span className="truncate">{label}</span>
          </button>
        </h2>
        {group.isGroupMatched ? (
          <span className="inline-flex h-5 items-center rounded-full bg-[var(--polaris-active)] px-2 text-[11px] font-medium text-[var(--polaris-ink-2)]">
            {t('node.groupMatched')}
          </span>
        ) : null}

        <span className="polaris-num ml-auto flex items-center gap-3 text-[12.5px] text-[var(--polaris-ink-3)]">
          {/* The group's states as one bar, worst first. / 分组状态汇总为一条状态条，最严重的状态排在前面。 */}
          <span aria-hidden="true" className="hidden h-1.5 w-16 gap-px overflow-hidden rounded-full bg-[var(--polaris-rail-empty)] sm:flex">
            {mix.map((row) => (
              <span
                key={row.status}
                className={clsx('h-full transition-[width] duration-500', row.status === 'up' ? 'bg-[var(--polaris-rail-up)]' : STATUS_DOT[row.status])}
                style={{ width: `${(row.n / Math.max(1, total)) * 100}%` }}
              />
            ))}
          </span>
          {down ? (
            <span className="flex items-center gap-1.5 font-medium text-danger-600">
              <span className="h-1.5 w-1.5 rounded-full bg-danger" />
              {t('node.offline')} {down}
            </span>
          ) : null}
          <span>
            {up}/{total} {t('node.online')}
          </span>
        </span>
      </div>

      <MotionDisclosure open={!collapsed} className="-mx-1 -mt-1 px-1 pt-1 pb-1">
        {view === 'list' ? (
          <ul ref={list} className="polaris-card polaris-divide overflow-hidden">
            {group.monitorList.map((monitor) => (
              <MonitorRow
                key={monitor.id}
                monitor={monitor}
                heartbeats={data.heartbeatList[monitor.id] ?? []}
                uptime24h={data.uptimeList[`${monitor.id}_24`] ?? null}
              />
            ))}
          </ul>
        ) : (
          <ul ref={list} className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(240px, calc((100% - ${((presentation?.columns ?? 3) - 1) * 16}px) / ${presentation?.columns ?? 3}))), 1fr))` }}>
            {group.monitorList.map((monitor) => (
              <MonitorTile
                key={monitor.id}
                monitor={monitor}
                heartbeats={data.heartbeatList[monitor.id] ?? []}
                uptime24h={data.uptimeList[`${monitor.id}_24`] ?? null}
              />
            ))}
          </ul>
        )}
      </MotionDisclosure>
    </section>
  );
}

/** Placeholder rows while the first response is in flight. / 首次响应返回前显示的占位行。 */
export function GroupSkeleton() {
  return (
    <div className="flex flex-col gap-10">
      {[4, 3].map((rows, index) => (
        <div key={index}>
          <div className="polaris-shimmer mb-3 h-5 w-40 rounded" />
          <div className="polaris-card polaris-divide overflow-hidden">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-4">
                <span className="polaris-shimmer h-8 w-8 rounded-[9px]" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <span className="polaris-shimmer h-3.5 w-48 max-w-full rounded" />
                  <span className="polaris-shimmer h-3 w-28 rounded" />
                </span>
                <span className="polaris-shimmer hidden h-6 w-[300px] rounded md:block" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
