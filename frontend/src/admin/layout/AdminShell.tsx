import { Popover, Dropdown } from '@/components/ui/MotionOverlays';
import { UnauthorizedError } from '@/api/errors';
import { useAuth } from '@/auth/AuthContext';
import { AccountAvatar } from '@/auth/AccountAvatar';
import { useAccountAvatar } from '@/auth/useAccountAvatar';
import { ThemeSwitch } from '@/components/ui/ThemeSwitch';
import { LocaleSwitch } from '@/i18n/LocaleSwitch';
import { buildIconProxyUrl } from '@/lib/icon-proxy';
import { NAV_TRANSITION } from '@/lib/motion';
import { PROJECT_NAME } from '@/lib/project';
import { APP_VERSION } from '@/lib/version';
import '@/styles/console.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import {
  Button,
  DropdownItem,
  DropdownMenu,
  DropdownSection,
  DropdownTrigger,
  PopoverContent,
  PopoverTrigger,
} from '@heroui/react';
import clsx from 'clsx';
import { LayoutGroup, motion } from 'framer-motion';
import { ArrowUpRight, Bell, Loader2, LogOut, Search, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import { joinEvents } from '../components/event-presentation';
import { EventList } from '../components/EventList';
import { TimelineArt } from '../components/illustrations';
import { useEvents, useFleet, useOverview } from '../useConsoleData';
import { ADMIN_PAGE_LOADERS, prefetchAdminPage } from '../page-loaders';
import { CommandPalette } from './CommandPalette';
import { ConsoleStatus } from './ConsoleStatus';
import { useConsoleNotifications } from './useConsoleNotifications';
import { NAV, navFor, type NavEntry } from './nav';

/** Brand mark URL, cropped to its ink - built through the shared, versioned helper. / 品牌标记 URL 裁去留白，由共享版本化辅助函数生成。 */
const BRAND_ICON = buildIconProxyUrl(undefined, { tight: true });

/**
 * Console chrome: white canvas, top bar, nav column, and one inset page sheet.
 *
 * Chrome and content are separated by a single hairline edge rather than a grey
 * background, so the console stays white without its regions running together.
 * 以一条细线区分外壳和内容，而不是灰底。
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const t = useTranslations('admin');
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const current = navFor(pathname);

  useEffect(() => setPaletteOpen(false), [pathname]);

  const overview = useOverview();
  const fleet = useFleet();

  /** A 401 from shared reads means the session ended; the guard only checks navigation. / 共享读取返回 401 表示会话结束；守卫只在导航时检查。 */
  useEffect(() => {
    const error = overview.error ?? fleet.error;
    if (error instanceof UnauthorizedError) {
      navigate('/login', { replace: true, state: { from: pathname } });
    }
  }, [overview.error, fleet.error, navigate, pathname]);

  // Ctrl/⌘+K from anywhere in the console. / 在控制台任意位置使用 Ctrl/⌘+K。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Warm other console pages after this one settles. / 当前页面稳定后预热其他控制台页面。 */
  useEffect(() => {
    const warm = () => {
      void Promise.allSettled(Object.values(ADMIN_PAGE_LOADERS).map((load) => load()));
    };
    if (window.requestIdleCallback) {
      const handle = window.requestIdleCallback(warm, { timeout: 1800 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(warm, 1200);
    return () => window.clearTimeout(handle);
  }, []);

  const counts = overview.data?.counts;
  const summary = fleet.data?.summary;
  const meta: Record<string, { n: number; alert: boolean } | undefined> = {
    '/admin': counts
      ? counts.down + counts.pending > 0
        ? { n: counts.down + counts.pending, alert: true }
        : { n: counts.total, alert: false }
      : undefined,
    '/admin/agents': summary
      ? summary.offline > 0
        ? { n: summary.offline, alert: true }
        : { n: summary.total, alert: false }
      : undefined,
  };

  return (
    <div className="polaris flex min-h-dvh flex-col bg-[var(--polaris-canvas)] text-[var(--polaris-ink)] lg:h-dvh lg:overflow-hidden">
      <TopBar onSearch={() => setPaletteOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[232px] shrink-0 flex-col lg:flex">
          <nav aria-label={t('brand')} className="polaris-scrollbar flex-1 overflow-y-auto px-3 pt-1 pb-3">
            <RailLinks current={current} meta={meta} />
          </nav>
          <RailFooter lastCheck={overview.data?.monitors} />
        </aside>

        <main data-console-scroll className="polaris-sheet polaris-scrollbar relative flex min-w-0 flex-1 flex-col lg:mr-2 lg:mb-2 lg:overflow-y-auto lg:rounded-2xl">
          {children}
        </main>
      </div>

      <nav aria-label={t('brand')} className="polaris-mobile-nav fixed inset-x-0 bottom-0 z-40 border-t border-[var(--polaris-line)] bg-[var(--polaris-canvas)]/95 px-2 pt-2 backdrop-blur-md lg:hidden">
        <LayoutGroup id="console-mobile-nav">
        <ul className="mx-auto grid w-full max-w-screen-sm grid-cols-6 gap-1">
          {NAV.map((entry) => {
            const active = current?.href === entry.href;
            const Icon = entry.icon;
            const badge = meta[entry.href];
            return (
              <li key={entry.href} className="min-w-0">
                <Link
                  to={entry.href}
                  title={t(entry.labelKey)}
                  aria-current={active ? 'page' : undefined}
                  onPointerEnter={() => prefetchAdminPage(entry.href)}
                  onFocus={() => prefetchAdminPage(entry.href)}
                  onTouchStart={() => prefetchAdminPage(entry.href)}
                  className={clsx(
                    'polaris-nav-link relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] leading-4 transition-colors',
                    active ? 'font-semibold text-[var(--polaris-ink)]' : 'text-[var(--polaris-ink-3)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]',
                  )}
                >
                  {active ? (
                    <motion.span
                      aria-hidden="true"
                      initial={false}
                      layoutId="console-mobile-active"
                      transition={NAV_TRANSITION}
                      className="absolute inset-0 rounded-xl bg-[var(--polaris-active)]"
                    />
                  ) : null}
                  <span className="relative flex h-5 w-5 items-center justify-center">
                    <Icon size={19} strokeWidth={active ? 2.1 : 1.7} aria-hidden="true" />
                    {badge?.alert ? <span className="polaris-num absolute -top-1 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] leading-none font-semibold text-white">{badge.n > 99 ? '99+' : badge.n}</span> : null}
                  </span>
                  <span className="relative w-full truncate text-center">{t(entry.labelKey)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        </LayoutGroup>
      </nav>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/** Top bar: mark, system state, operator controls. / 顶栏：图标、系统状态、操作控件。 */
function TopBar({ onSearch }: { onSearch: () => void }) {
  const t = useTranslations('admin');
  /*
    One row everywhere. Below `lg` the status island is not rendered at all:
    a phone has no room for it beside the wordmark and five controls, and the
    console's own Monitors page already leads with what is wrong. Above `lg`
    the bar is the original three-column grid with the island in the middle.

    所有尺寸均为一行；小于 lg 时不渲染状态岛，因为手机上的字标和五个控件旁无足够空间，
    而监控页已优先展示故障。lg 及以上使用三列网格，状态岛位于中间。
  */
  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 bg-[var(--polaris-canvas)]/90 px-3 backdrop-blur-md sm:px-4 lg:static lg:grid lg:grid-cols-[1fr_auto_1fr] lg:gap-3 lg:bg-transparent lg:backdrop-blur-none">
      <Link to="/admin" className="flex shrink-0 items-center gap-2.5 justify-self-start rounded-lg px-1.5 py-1 lg:w-[208px]">
        <img src={BRAND_ICON} alt="" width={22} height={22} className="shrink-0" />
        <span className="truncate text-[15px] font-semibold tracking-[-0.02em]">{PROJECT_NAME}</span>
        <span className="hidden font-mono text-[10.5px] text-[var(--polaris-ink-4)] sm:inline">v{APP_VERSION}</span>
      </Link>

      <div className="hidden min-w-0 justify-center lg:flex">
        <ConsoleStatus />
      </div>

      <div className="ml-auto flex items-center justify-self-end gap-1 lg:ml-0">
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-8 w-56 items-center gap-2 rounded-lg border border-[var(--polaris-line)] bg-[var(--polaris-card)] pr-1.5 pl-2.5 text-left text-[12.5px] text-[var(--polaris-ink-4)] shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-colors hover:border-[var(--polaris-line-strong)] hover:text-[var(--polaris-ink-3)] xl:flex"
        >
          <Search size={14} aria-hidden="true" />
          <span className="flex-1 truncate">{t('console.search')}</span>
          <kbd className="polaris-kbd">Ctrl K</kbd>
        </button>
        <Button
          isIconOnly
          variant="light"
          radius="md"
          className="h-8 w-8 min-w-8 text-[var(--polaris-ink-3)] xl:hidden"
          aria-label={t('console.search')}
          onPress={onSearch}
        >
          <Search size={17} />
        </Button>
        <EventsBell />
        {/* Scale the shared switches to fit the console header. / 调整共用开关尺寸，使其适合控制台页头。 */}
        <span className="flex items-center text-[var(--polaris-ink-3)] [&_button]:h-8 [&_button]:w-8 [&_button]:min-w-8 [&_svg]:h-[17px] [&_svg]:w-[17px]">
          <ThemeSwitch radius="md" />
          <LocaleSwitch />
        </span>
        <span className="mx-1 hidden h-5 w-px bg-[var(--polaris-line)] sm:block" />
        <AccountMenu />
      </div>
    </header>
  );
}

/** Nav sections; the active fill slides and the right edge may carry a count. / 导航分区；活动填充滑动，右侧可显示计数。 */
function RailLinks({
  current,
  meta,
}: {
  current: NavEntry | undefined;
  meta: Record<string, { n: number; alert: boolean } | undefined>;
}) {
  const t = useTranslations('admin');
  const sections: Array<NavEntry['section']> = ['monitor', 'configure'];

  return (
    <LayoutGroup id="console-rail">
      {sections.map((section) => (
        <div key={section} className="mb-1">
          <p className="px-2.5 pt-4 pb-1.5 text-[12px] text-[var(--polaris-ink-4)]">
            {t(section === 'monitor' ? 'console.sectionMonitor' : 'console.sectionConfigure')}
          </p>
          <ul className="flex flex-col gap-px">
            {NAV.filter((entry) => entry.section === section).map((entry) => {
              const active = current?.href === entry.href;
              const Icon = entry.icon;
              const badge = meta[entry.href];
              return (
                <li key={entry.href}>
                  <Link
                    to={entry.href}
                    aria-current={active ? 'page' : undefined}
                    onPointerEnter={() => prefetchAdminPage(entry.href)}
                    onFocus={() => prefetchAdminPage(entry.href)}
                    className={clsx(
                      'polaris-nav-link group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
                      active
                        ? 'font-medium text-[var(--polaris-ink)]'
                        : 'text-[var(--polaris-ink-2)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]',
                    )}
                  >
                    {active ? (
                      <motion.span
                        aria-hidden="true"
                        initial={false}
                        layoutId="console-rail-active"
                        className="absolute inset-0 rounded-lg bg-[var(--polaris-active)]"
                        transition={NAV_TRANSITION}
                      />
                    ) : null}
                    <Icon
                      size={16}
                      className={clsx(
                        'relative shrink-0 transition-colors',
                        active ? 'text-[var(--polaris-ink)]' : 'text-[var(--polaris-ink-4)] group-hover:text-[var(--polaris-ink-2)]',
                      )}
                    />
                    <span className="relative truncate">{t(entry.labelKey)}</span>
                    {badge ? (
                      <span
                        className={clsx(
                          'polaris-num relative ml-auto flex items-center gap-1.5 text-[12px]',
                          badge.alert ? 'font-semibold text-danger-600' : 'text-[var(--polaris-ink-4)]',
                        )}
                      >
                        {badge.alert ? <span className="h-1.5 w-1.5 rounded-full bg-danger" /> : null}
                        {badge.n}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </LayoutGroup>
  );
}

/** The foot of the column: the cadence, the last check, and the way out to the public page. / 导航列底部显示检查间隔、上次检查以及通往公开页面的入口。 */
function RailFooter({ lastCheck }: { lastCheck: Array<{ checked_at: number }> | undefined }) {
  const t = useTranslations('admin');
  const ago = useTimeAgo();
  const newest = useMemo(
    () => (lastCheck ?? []).reduce((max, row) => Math.max(max, row.checked_at || 0), 0),
    [lastCheck],
  );

  return (
    <div className="flex flex-col gap-0.5 px-3 pb-4">
      <Link
        to="/"
        className="group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-[var(--polaris-ink-2)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]"
      >
        <ArrowUpRight size={16} className="text-[var(--polaris-ink-4)] group-hover:text-[var(--polaris-ink-2)]" />
        {t('nav.viewStatus')}
      </Link>
      <div className="mt-2 flex items-center gap-2 px-2.5 text-[11.5px] text-[var(--polaris-ink-4)]">
        <span className="polaris-live h-1.5 w-1.5 rounded-full bg-success" />
        <span className="truncate">
          {t('console.cadence')}
          {newest ? ` · ${ago(newest)}` : ''}
        </span>
      </div>
    </div>
  );
}

/** Bell: latest status changes; the dot tracks the newest seen event per browser. / 铃铛：最新状态变化；圆点按浏览器记录最新已读事件。 */
function EventsBell() {
  const t = useTranslations('admin');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const events = useEvents(30);
  const overview = useOverview();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const notifications = useConsoleNotifications();

  const rows = useMemo(
    () => joinEvents(events.data?.events ?? [], overview.data?.monitors ?? []).slice(0, 8),
    [events.data, overview.data],
  );
  const newest = rows.reduce((max, row) => Math.max(max, row.id), 0);
  const unread = newest > notifications.seen && !notifications.muted;

  const markSeen = () => {
    notifications.markSeen(newest);
  };

  return (
    <Popover
      placement="bottom-end"
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) markSeen();
      }}
      offset={10}
    >
      <PopoverTrigger>
        <Button
          isIconOnly
          variant="light"
          radius="md"
          className="relative h-8 w-8 min-w-8 text-[var(--polaris-ink-3)]"
          aria-label={unread ? t('console.eventsUnread') : t('console.events')}
        >
          <Bell size={17} />
          {unread ? (
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-[var(--polaris-accent)] ring-2 ring-[var(--polaris-canvas)]" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[23rem] max-w-[calc(100vw-2rem)] p-0">
        <div className="w-full">
          <div className="flex items-center gap-2 border-b border-[var(--polaris-line)] px-4 py-3">
            <p className="text-[13px] font-semibold">{t('console.events')}</p>
            <span className="polaris-num text-[12px] text-[var(--polaris-ink-4)]">{rows.length || ''}</span>
            <button
              type="button"
              onClick={() => {
                markSeen();
                setOpen(false);
                const target = document.getElementById('settings-events');
                if (target) target.scrollIntoView({ block: 'start' });
                void navigate('/admin/settings#settings-events');
              }}
              className="ml-auto text-[12px] font-medium text-[var(--polaris-ink-2)] hover:text-[var(--polaris-ink)] hover:underline"
            >
              {t('console.viewAll')}
            </button>
          </div>
          {events.data === undefined && !events.error ? (
            <div className="flex justify-center py-8">
              <Loader2 size={18} className="animate-spin text-[var(--polaris-ink-4)]" />
            </div>
          ) : events.error && events.data === undefined ? (
            <div role="alert" className="space-y-2 px-4 py-5 text-small text-danger">
              <p>{t('settings.eventsLoadFailed')}</p>
              <Button size="sm" variant="light" onPress={() => void events.mutate()}>{t('action.retry')}</Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-8 text-center">
              <TimelineArt />
              <p className="mt-3 text-[12.5px] text-[var(--polaris-ink-3)]">{t('console.eventsEmpty')}</p>
            </div>
          ) : (
            <EventList
              dense
              rows={rows}
              className="max-h-[22rem] overflow-y-auto p-1.5"
              onPick={(row) => {
                setOpen(false);
                if (row.monitor) navigate(`/admin?monitor=${encodeURIComponent(row.monitor_id)}`);
              }}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Account menu: identity and sign-out. / 账号菜单：身份和退出。 */
function AccountMenu() {
  const t = useTranslations('admin');
  const navigate = useNavigate();
  const { session, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const { data: avatar } = useAccountAvatar();

  const username = session?.user?.username ?? '';

  async function handleLogout() {
    setBusy(true);
    try {
      await logout();
      // A full navigation: it discards every cached response and all in-memory
      // state belonging to the signed-out session.
      // 完整页面导航会丢弃已退出会话的全部缓存响应和内存状态。
      window.location.href = '/login';
    } catch {
      toast.error(t('account.logoutFailed'));
      setBusy(false);
    }
  }

  if (!username) return null;

  return (
    <Dropdown placement="bottom-end">
      <DropdownTrigger>
        <button
          type="button"
          aria-label={t('account.signedInAs', { name: username })}
          className="flex h-8 items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-[var(--polaris-hover)] sm:pr-2.5"
        >
          <AccountAvatar username={username} src={avatar?.url} size="sm" className="ring-2 ring-[var(--polaris-canvas)]" />
          <span className="hidden max-w-[7rem] truncate text-[13px] font-medium sm:block">{username}</span>
        </button>
      </DropdownTrigger>
      <DropdownMenu aria-label={t('account.signedInAs', { name: username })} variant="flat" itemClasses={{ base: 'gap-3 px-3', wrapper: 'flex-1' }}>
        <DropdownSection showDivider>
          <DropdownItem
            key="identity"
            isReadOnly
            className="cursor-default opacity-100"
            startContent={<UserRound size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
            description={t('console.role')}
          >
            {username}
          </DropdownItem>
        </DropdownSection>
        <DropdownSection>
          <DropdownItem
            key="avatar"
            startContent={<UserRound size={15} className="shrink-0 text-[var(--polaris-ink-4)]" />}
            onPress={() => {
              const account = document.getElementById('settings-account');
              if (account) account.scrollIntoView({ block: 'start' });
              else void navigate('/admin/settings#settings-account');
            }}
          >
            {t('account.avatarChange')}
          </DropdownItem>
          <DropdownItem
            key="logout"
            className="text-danger"
            color="danger"
            startContent={busy ? <Loader2 className="shrink-0 animate-spin" size={15} /> : <LogOut className="shrink-0" size={15} />}
            onPress={() => void handleLogout()}
            isDisabled={busy}
          >
            {busy ? t('account.loggingOut') : t('account.logout')}
          </DropdownItem>
        </DropdownSection>
      </DropdownMenu>
    </Dropdown>
  );
}

