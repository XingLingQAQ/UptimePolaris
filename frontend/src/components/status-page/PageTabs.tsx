
import clsx from 'clsx';
import { useMemo } from 'react';
import { Link as RouterLink } from 'react-router';
import { useTranslations } from 'use-intl';

import { usePageConfig } from '@/components/context/PageConfigContext';
import { SWR_KEYS, useIntentPrefetch } from '@/components/status-page/useStatusPageData';
import { buildIconProxyUrl } from '@/lib/icon-proxy';
import { statusPagePath } from '@/lib/public-navigation';
import { useLocation } from 'react-router';
import type { PageHealthStatus, PageTabMeta } from '@/types/page';

interface PageTabsProps {
  tabs?: PageTabMeta[];
}

interface ResolvedPageTab {
  id: string;
  title: string;
  description?: string;
  icon: string;
  health: PageHealthStatus;
  href: string;
  isActive: boolean;
}

const HEALTH_DOT: Record<PageHealthStatus, string> = {
  healthy: 'bg-success',
  unavailable: 'bg-danger animate-pulse',
};

function PageTabItem({ tab }: { tab: ResolvedPageTab }) {
  const { defaultPageId } = usePageConfig();
  const { search } = useLocation();

  const prefetchKeys = useMemo(
    () => [SWR_KEYS.MONITOR(tab.id), SWR_KEYS.CONFIG(tab.id === defaultPageId ? undefined : tab.id)] as const,
    [tab.id, defaultPageId, search]
  );

  const { schedulePrefetch, cancelPrefetch } = useIntentPrefetch(prefetchKeys, {
    disabled: tab.isActive,
  });

  return (
    <li className="shrink-0">
      <RouterLink
        to={tab.href}
        aria-current={tab.isActive ? 'page' : undefined}
        onPointerEnter={schedulePrefetch}
        onPointerLeave={cancelPrefetch}
        onFocus={schedulePrefetch}
        onBlur={cancelPrefetch}
        className={clsx(
          'group inline-flex h-10 items-center gap-2.5 rounded-lg pr-3.5 pl-1.5 text-[13px] transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--polaris-ink)]/30',
          tab.isActive
            ? 'bg-[var(--polaris-active)] font-medium text-[var(--polaris-ink)]'
            : 'text-[var(--polaris-ink-3)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]',
          tab.health === 'unavailable' && !tab.isActive && 'text-danger-600'
        )}
      >
        <span className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--polaris-line)] bg-[var(--polaris-card)]">
          <img loading="lazy" decoding="async" src={tab.icon} alt="" width={18} height={18} />
          {/* health dot / 健康状态圆点 */}
          <span
            aria-hidden="true"
            className={clsx(
              'absolute -right-[3px] -bottom-[3px] h-2 w-2 rounded-full ring-2 ring-[var(--polaris-canvas)]',
              HEALTH_DOT[tab.health]
            )}
          />
        </span>
        <span className="flex min-w-0 flex-col text-left">
          <span className="max-w-[12rem] truncate" title={tab.description ? `${tab.title} · ${tab.description}` : tab.title}>
            {tab.title}
          </span>
        </span>
      </RouterLink>
    </li>
  );
}

export function PageTabs({ tabs: providedTabs }: PageTabsProps) {
  const pageConfig = usePageConfig();
  const { search } = useLocation();
  const t = useTranslations('navbar');

  if (!Array.isArray(pageConfig.pageIds) || pageConfig.pageIds.length <= 1) {
    return null;
  }

  const providedMeta = new Map(providedTabs?.map(tab => [tab.id, tab]));

  const resolvedTabs = pageConfig.pageIds.map<ResolvedPageTab>(id => {
    const metaFromPreload = providedMeta.get(id);
    const fallbackSiteMeta = pageConfig.pages.find(page => page.id === id)?.siteMeta;

    const title = metaFromPreload?.title?.trim() || fallbackSiteMeta?.title?.trim() || id;
    const description =
      metaFromPreload?.description?.trim() || fallbackSiteMeta?.description?.trim();
    const icon = buildIconProxyUrl(id);
    const health = metaFromPreload?.health ?? 'healthy';

    const href = statusPagePath(id, pageConfig.defaultPageId, search);
    const isActive = pageConfig.pageId === id;

    return {
      id,
      title,
      description,
      icon,
      health,
      href,
      isActive,
    };
  });

  return (
    <nav aria-label={t('pageTabs')} className="border-b border-[var(--polaris-line)]">
      <div className="relative mx-auto w-full max-w-[var(--polaris-page-width,1120px)]">
        <ul className="tab-scroll-list flex gap-1 overflow-x-auto px-4 py-2 sm:px-6">
          {resolvedTabs.map(tab => (
            <PageTabItem key={tab.id} tab={tab} />
          ))}
        </ul>
        {/* right fade gradient when list overflows / 列表溢出时显示右侧渐隐 */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--polaris-canvas)] to-transparent"
        />
      </div>
    </nav>
  );
}
