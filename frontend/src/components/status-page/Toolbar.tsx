import { useMonitorFilters } from '@/components/status-page/MonitorFilterContext';
import { Segmented } from '@/components/ui/Segmented';
import type { MonitorStatusCounts } from '@/lib/monitor-status';
import type { MonitorFilterStatus } from '@/types/monitor';
import clsx from 'clsx';
import { Folders, LayoutGrid, LayoutList, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

export type ViewMode = 'list' | 'grid';

/**
 * Finding and narrowing: the search, the status filter with its counts, the
 * group-name switch and the view toggle, in one row above the groups.
 *
 * ⌘K / Ctrl+K focuses the search from anywhere on the page.
 *
 * 搜索、带数量的状态筛选、按分组名称搜索开关和视图切换位于分组上方同一行；
 * ⌘K / Ctrl+K 可从页面任意位置聚焦搜索框。
 */
export function Toolbar({
  counts,
  view,
  onView,
  matched,
}: {
  counts: MonitorStatusCounts;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  matched: number;
}) {
  const t = useTranslations();
  const { inputValue, setInputValue, clearSearch, isFiltering, filterStatus, setFilterStatus, searchInGroup, setSearchInGroup } =
    useMonitorFilters();
  const input = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  // Pinned under the header once the hero scrolls away: draw a rule and a soft shadow then, not before.
  // 概览区域滚出视野后工具栏固定在页头下方，此时才显示分隔线和柔和阴影。
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting), {
      rootMargin: '-57px 0px 0px 0px',
      threshold: 0,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const options: Array<{ value: MonitorFilterStatus; label: string; count?: number }> = [
    { value: 'all', label: t('node.allStatus'), count: counts.total },
    { value: 'up', label: t('node.statusFilter.up'), count: counts.up },
    { value: 'down', label: t('node.statusFilter.down'), count: counts.down },
    { value: 'warn', label: t('common.status.warn'), count: counts.warn },
    { value: 'pending', label: t('node.statusFilter.pending'), count: counts.pending },
  ];
  const shown = options.filter((option) => option.value === 'all' || (option.count ?? 0) > 0 || option.value === filterStatus);

  return (
    <>
    <div ref={sentinel} aria-hidden="true" className="h-px" />
    <div
      className={clsx(
        'sticky top-14 z-30 -mx-4 mb-6 border-b bg-[var(--polaris-canvas)]/88 px-4 py-2.5 backdrop-blur-md transition-[border-color,box-shadow] duration-300 sm:-mx-6 sm:px-6',
        stuck ? 'border-[var(--polaris-line)] shadow-[0_10px_20px_-18px_rgb(0_0_0/0.4)]' : 'border-transparent',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-[var(--polaris-line-strong)] bg-[var(--polaris-card)] px-2.5 shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-shadow focus-within:border-[var(--polaris-field-focus)] focus-within:shadow-[0_0_0_3px_var(--polaris-ring)] sm:w-64">
          <Search size={14} className="shrink-0 text-[var(--polaris-ink-4)]" aria-hidden="true" />
          <input
            ref={input}
            type="search"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder={t('node.search')}
            aria-label={t('navbar.search')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--polaris-ink)] outline-none placeholder:text-[var(--polaris-ink-4)] [&::-webkit-search-cancel-button]:hidden"
          />
          {inputValue ? (
            <button
              type="button"
              onClick={() => {
                setInputValue('');
                input.current?.focus();
              }}
              aria-label={t('node.clearSearch')}
              className="text-[var(--polaris-ink-4)] transition-colors hover:text-[var(--polaris-ink)]"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="polaris-kbd hidden sm:inline-flex">Ctrl K</kbd>
          )}
        </label>

        <div className="tab-scroll-list max-w-full overflow-x-auto">
          <Segmented
            label={t('node.filterByStatus')}
            value={filterStatus}
            onChange={setFilterStatus}
            options={shown}
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-pressed={searchInGroup}
            onClick={() => setSearchInGroup(!searchInGroup)}
            title={t('node.filterTooltip')}
            className={clsx(
              'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors',
              searchInGroup
                ? 'border-[var(--polaris-ink)]/40 bg-[var(--polaris-active)] font-medium text-[var(--polaris-ink)]'
                : 'border-[var(--polaris-line)] text-[var(--polaris-ink-3)] hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink)]',
            )}
          >
            <Folders size={14} />
            <span className="hidden sm:inline">{t('node.searchInGroups')}</span>
          </button>

          <div
            role="group"
            aria-label={view === 'list' ? t('view.switchToFull') : t('view.switchToLite')}
            className="inline-flex items-center gap-0.5 rounded-[9px] bg-[var(--polaris-active)] p-[3px]"
          >
            {(
              [
                ['list', <LayoutList key="list" size={14} />, t('view.switchToLite')],
                ['grid', <LayoutGrid key="grid" size={14} />, t('view.switchToFull')],
              ] as const
            ).map(([mode, icon, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                aria-label={label}
                title={label}
                onClick={() => onView(mode)}
                className={clsx(
                  'flex h-[26px] w-[30px] items-center justify-center rounded-[6px] transition-colors',
                  view === mode
                    ? 'bg-[var(--polaris-card)] text-[var(--polaris-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_rgb(0_0_0/0.04)] dark:bg-[#2a2a2e]'
                    : 'text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)]',
                )}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isFiltering ? (
        <div className="polaris-rise mt-2.5 flex items-center gap-3 text-[12.5px] text-[var(--polaris-ink-3)]">
          <span className="polaris-num">{t('node.filterResults', { count: matched })}</span>
          <button
            type="button"
            onClick={clearSearch}
            className="font-medium text-[var(--polaris-ink-2)] underline-offset-2 hover:text-[var(--polaris-ink)] hover:underline"
          >
            {t('node.clearFilter')}
          </button>
        </div>
      ) : null}
    </div>
    </>
  );
}
