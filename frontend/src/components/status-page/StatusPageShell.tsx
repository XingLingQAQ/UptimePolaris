
import { usePageConfig } from '@/components/context/PageConfigContext';
import { usePresentationView } from '@/components/context/PresentationViewContext';
import { Footer } from '@/components/status-page/Footer';
import { useConfig } from '@/components/status-page/useStatusPageData';
import { ThemeSwitch } from '@/components/ui/ThemeSwitch';
import { LocaleSwitch } from '@/i18n/LocaleSwitch';
import { useLocale } from '@/i18n/IntlProvider';
import { resolveSiteIconUrl } from '@/lib/icon-proxy';
import { statusPagePath } from '@/lib/public-navigation';
import { applyDefaultTheme } from '@/lib/browser-preferences';
import { CONTENT_TRANSITION } from '@/lib/motion';
import type { SiteConfig } from '@/types/config';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Link as RouterLink, useLocation } from 'react-router';
import { useTranslations } from 'use-intl';

interface StatusPageShellProps {
  children: React.ReactNode;
  footerConfig?: SiteConfig;
}

/** Public page frame: header, content and footer. / 公开页面框架：页头、内容与页脚。 */
export function StatusPageShell({ children, footerConfig }: StatusPageShellProps) {
  const { pageId } = usePageConfig();
  const { pathname } = useLocation();
  const { setTheme } = useTheme();
  const { applyDefaultLocale } = useLocale();
  const { config: liveConfig } = useConfig();
  const presentation = usePresentationView();
  const resolvedFooterConfig = liveConfig?.config ?? footerConfig;

  // The site's configured theme applies until the visitor picks one of their own. / 访客自行选择主题前使用站点配置的主题。
  useEffect(() => {
    if (liveConfig?.config.theme) applyDefaultTheme(liveConfig.config.theme, setTheme);
  }, [liveConfig?.config.theme, setTheme]);

  useEffect(() => {
    if (!presentation) return;
    const controller = new AbortController();
    void applyDefaultLocale(presentation.locale, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [presentation?.locale, applyDefaultLocale]);

  /**
   * Apply `site.icon` to the tab icon once config arrives.
   *
   * `index.html` is static and can only ship the generated mark. Only
   * `link[rel=icon]` is touched, and React state is not involved, so this cannot
   * re-render or flicker the page.
   * `index.html` 只能带内置图标；运行时只改 `link[rel=icon]`，不触发重渲染。
   */
  useEffect(() => {
    const configured = liveConfig?.config.icon;
    if (!configured) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const href = resolveSiteIconUrl({ icon: configured });
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }, [liveConfig?.config.icon]);

  return (
    <div className="polaris relative flex min-h-dvh flex-col bg-[var(--polaris-canvas)] text-[var(--polaris-ink)]" style={presentation ? { '--polaris-accent': presentation.accent, '--polaris-chart': presentation.accent, '--polaris-page-width': `${presentation.width}px` } as React.CSSProperties : undefined}>
      <SiteHeader />
      <motion.main
        key={`${pageId}:${pathname}`}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={CONTENT_TRANSITION}
        className="mx-auto w-full max-w-[var(--polaris-page-width,1120px)] grow px-4 sm:px-6"
      >
        {children}
      </motion.main>
      <Footer config={resolvedFooterConfig} />
    </div>
  );
}

/** Whether the page has scrolled past its top, for chrome that should only draw a rule once it floats. / 判断页面是否已向下滚动，以便浮动栏出现时显示分隔线。 */
function useScrolled(threshold = 4): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}

/** The bar: the site's mark and title on the left, the visitor's own switches on the right. / 页头左侧显示站点标记与标题，右侧显示访客设置开关。 */
function SiteHeader() {
  const t = useTranslations();
  const pageConfig = usePageConfig();
  const { search } = useLocation();
  const { config: globalConfig } = useConfig();
  const title = globalConfig?.config.title || pageConfig.siteMeta.title;
  const homeHref = statusPagePath(pageConfig.pageId, pageConfig.defaultPageId, search);
  /** Header mark: configured icon, else generated brand; `tight` only applies to the generated mark. / 页头图标：优先配置图标，否则内置品牌；`tight` 仅用于内置图标。 */
  const icon = resolveSiteIconUrl(
    { icon: globalConfig?.config.icon ?? pageConfig.siteMeta.icon, iconCandidates: pageConfig.siteMeta.iconCandidates },
    pageConfig.pageId,
    { tight: true },
  ) || '/icon.svg';
  const scrolled = useScrolled();

  return (
    <header
      className={clsx(
        'sticky top-0 z-40 border-b bg-[var(--polaris-canvas)]/85 backdrop-blur-md transition-[border-color,box-shadow] duration-300',
        scrolled ? 'border-[var(--polaris-line)] shadow-[0_6px_16px_-14px_rgb(0_0_0/0.35)]' : 'border-transparent',
      )}
    >
      <div className="mx-auto flex h-14 w-full max-w-[var(--polaris-page-width,1120px)] items-center gap-3 px-4 sm:px-6">
        <RouterLink to={homeHref} className="flex min-w-0 items-center gap-2.5 rounded-lg py-1 pr-1.5">
          <img src={icon} alt="" width={24} height={24} className="shrink-0 transition-transform duration-300 hover:rotate-[-8deg]" />
          <span className="truncate text-[15px] font-semibold tracking-[-0.02em]">{title}</span>
        </RouterLink>
        <nav aria-label={t('navbar.mobileNav')} className="ml-auto flex items-center gap-0.5 text-[var(--polaris-ink-3)] [&_button]:h-8 [&_button]:w-8 [&_button]:min-w-8 [&_svg]:h-[17px] [&_svg]:w-[17px]">
          <ThemeSwitch radius="md" />
          <LocaleSwitch />
        </nav>
      </div>
    </header>
  );
}
