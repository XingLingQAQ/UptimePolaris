import { UnauthorizedError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { getDesktopViewport, getServerDesktopViewport, getServerSuccessFeedback, getSuccessFeedback, subscribeDesktopViewport, subscribeSuccessFeedback } from '@/components/ui/success-feedback';
import clsx from 'clsx';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { ArrowRight, Bell, BellOff, CheckCheck, ChevronDown, CircleCheck, Copy, Loader2, Pause, Pin, PinOff, Play, Plus, RefreshCw, Server, ShieldCheck, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { toast } from '@/components/ui/toast';
import { mutate } from 'swr';
import { useTranslations } from 'use-intl';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import { joinEvents } from '../components/event-presentation';
import { monitorsApi } from '../monitors/api';
import type { OverviewMonitor } from '../monitors/types';
import { OVERVIEW_KEY, useEvents, useFleet, useOverview } from '../useConsoleData';
import { useConsoleNotifications } from './useConsoleNotifications';
import { SuccessFeedbackCard } from './SuccessFeedbackCard';

type Severity = 'down' | 'pending' | 'warn';
type Worst = Severity | 'up' | 'idle';

const DOT: Record<Worst, string> = {
  down: 'bg-[#ff5a5f]',
  pending: 'bg-[#ff9f43]',
  warn: 'bg-[#ffd166]',
  up: 'bg-[#34d399]',
  idle: 'bg-zinc-500',
};

function severityOf(monitor: OverviewMonitor): Severity | null {
  if (!monitor.active || monitor.st === null) return null;
  if (monitor.st === 0) return 'down';
  if (monitor.st === 4) return 'pending';
  if (monitor.st === 2) return 'warn';
  return null;
}

/** Worse first, both for the issue list's order and for the bounce comparison. / 严重状态排在前面，同时用于问题列表排序和弹跳比较。 */
const SEVERITY_ORDER: Record<Worst, number> = { down: 0, pending: 1, warn: 2, up: 3, idle: 4 };

/** Icon buttons stay square and quiet until hovered; the global focus ring still applies. / 图标按钮保持方形和低调样式，悬停时响应；仍使用全局焦点环。 */
const ICON_BUTTON =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-white';

export function ConsoleStatus() {
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const navigate = useNavigate();
  const ago = useTimeAgo();
  const overview = useOverview();
  const fleet = useFleet();
  const events = useEvents(30);
  const notifications = useConsoleNotifications();
  const desktop = useSyncExternalStore(subscribeDesktopViewport, getDesktopViewport, getServerDesktopViewport);
  const successQueue = useSyncExternalStore(subscribeSuccessFeedback, getSuccessFeedback, getServerSuccessFeedback);
  const success = desktop ? successQueue[0] ?? null : null;
  const [open, setOpen] = useState(false);
  const islandId = useId();
  const [capsuleWidth, setCapsuleWidth] = useState(160);
  const islandSpring = { type: 'spring' as const, duration: open ? 0.82 : 0.62, bounce: 0.12 };
  const contentMotion = {
    closed: { opacity: 0, y: -6, transition: { duration: 0.14 } },
    open: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const } },
  };
  const [tab, setTab] = useState<'issues' | 'activity'>('issues');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshLock = useRef(false);
  const [pinned, setPinned] = useState(false);
  const [bouncing, setBouncing] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ id: string; action: 'toggle' | 'check' } | null>(null);
  const actionLock = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  /** Set when a press outside the panel closed it, so focus is not yanked back. / 面板被外部点击关闭时设置，避免焦点被强制拉回。 */
  const closedByPointer = useRef(false);

  const counts = overview.data?.counts;
  const monitors = useMemo(() => overview.data?.monitors ?? [], [overview.data]);

  const issues = useMemo(
    () =>
      monitors
        .map((monitor) => ({ monitor, severity: severityOf(monitor) }))
        .filter((row): row is { monitor: OverviewMonitor; severity: Severity } => row.severity !== null)
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.monitor.checked_at - a.monitor.checked_at),
    [monitors],
  );
  const offline = useMemo(
    () => (fleet.data?.agents ?? []).filter((agent) => agent.active && agent.online === false),
    [fleet.data],
  );
  const lastCheck = useMemo(() => monitors.reduce((max, m) => Math.max(max, m.checked_at || 0), 0), [monitors]);

  const down = counts?.down ?? 0;
  const pending = counts?.pending ?? 0;
  const warn = counts?.warn ?? 0;
  const up = counts?.up ?? 0;
  const paused = counts?.paused ?? 0;
  const active = counts ? counts.total - counts.paused : 0;
  const empty = counts !== undefined && counts.total === 0;
  const inactive = counts !== undefined && counts.total > 0 && active === 0;
  const loadError = overview.error ?? fleet.error;
  const activity = useMemo(() => joinEvents(events.data?.events ?? [], monitors), [events.data, monitors]);
  const newestEvent = activity.reduce((max, row) => Math.max(max, row.id), 0);
  const unread = activity.filter(row => row.id > notifications.seen).length;
  const shownEvents = unreadOnly ? activity.filter(row => row.id > notifications.seen) : activity;
  const markSeen = notifications.markSeen;
  const worst: Worst = !counts || empty || inactive || loadError && down + pending + warn + offline.length === 0
    ? 'idle'
    : down > 0
      ? 'down'
      : pending > 0
        ? 'pending'
        : warn > 0 || offline.length > 0
          ? 'warn'
          : 'up';

  /** All clear can include paused monitors; pausing is deliberate. / 全部正常可以包含暂停监控；暂停是主动行为。 */
  const allClear = Boolean(counts) && Boolean(fleet.data) && active > 0 && !loadError && down === 0 && pending === 0 && warn === 0 && offline.length === 0;

  const segments: Array<{ key: string; dot: string; text: string }> = [];
  if (counts) {
    if (down) segments.push({ key: 'down', dot: DOT.down, text: t('island.down', { n: down }) });
    if (pending) segments.push({ key: 'pending', dot: DOT.pending, text: t('island.pending', { n: pending }) });
    if (warn) segments.push({ key: 'warn', dot: DOT.warn, text: t('island.warn', { n: warn }) });
    if (offline.length) segments.push({ key: 'offline', dot: DOT.down, text: t('island.offline', { n: offline.length }) });
  }

  /** The whole state as one sentence, for the capsule's label and the clipboard. / 将整体状态整理成一句话，用于胶囊标签和剪贴板。 */
  const summaryText = !counts
    ? t(loadError ? 'island.loadFailed' : 'console.statusLoading')
    : !fleet.data && !fleet.error ? t('console.statusLoading')
    : empty ? t('island.noMonitorsTitle')
    : inactive ? t('island.inactiveTitle')
    : loadError && segments.length === 0 ? t('island.loadFailed')
    : segments.length === 0
      ? `${t('island.allClear')} · ${t('island.monitors', { n: active })}`
      : `${segments.map((segment) => segment.text).join(' · ')} · ${t('island.up', { n: up })}`;

  /**
   * Bounce only when the fleet gets worse.
   *
   * Compare against the previous severity order and anomaly total; recovery
   * never matches, and a first load has no previous value so it must not animate.
   * 只在严重度变差时跳动；首次加载没有前次值，不能动。
   */
  const anomalyTotal = down + pending + warn + offline.length;
  const previous = useRef<{ order: number; total: number } | null>(null);
  useEffect(() => {
    // Wait for both counts and fleet; the first fleet response is not an incident. / 等计数和机器列表都完成；首次列表不是新事件。
    if (!counts || (!fleet.data && !fleet.error)) return;
    const order = SEVERITY_ORDER[worst];
    const prior = previous.current;
    previous.current = { order, total: anomalyTotal };
    if (!prior) return;
    if (worst !== 'up' && worst !== 'idle' && !notifications.muted && (order < prior.order || (prior.total === 0 && anomalyTotal > 0))) setBouncing(true);
  }, [counts, fleet.data, fleet.error, worst, anomalyTotal, notifications.muted]);
  const previousEvent = useRef<number | null>(null);
  useEffect(() => {
    if (!events.data) return;
    const prior = previousEvent.current;
    previousEvent.current = newestEvent;
    if (prior !== null && newestEvent > prior && newestEvent > notifications.seen && !notifications.muted) setBouncing(true);
  }, [events.data, newestEvent, notifications.seen, notifications.muted]);
  useEffect(() => {
    if (!bouncing) return;
    const id = window.setTimeout(() => setBouncing(false), 220);
    return () => window.clearTimeout(id);
  }, [bouncing]);

  // 固定时忽略外部点击；未被其他控件处理的 Escape 仍关闭浮层。
  // Ignore outside clicks while pinned; Escape dismisses the panel unless another control handles it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (pinned) return;
      if (root.current && !root.current.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node) && !successRef.current?.contains(event.target as Node)) {
        // A press elsewhere is the operator moving to another control, not a
        // keyboard dismissal; focus should stay where they pressed.
        // 点击其他位置表示转向另一个控件，而非键盘关闭；焦点应留在点击位置。
        closedByPointer.current = true;
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, pinned]);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  /**
   * Move focus into the panel on open and back to the capsule on close.
   *
   * The panel is `fixed` over the bar, so the capsule is hidden and drops out of
   * the focus order; without this, Escape closes with focus on `<body>` and the
   * next Tab starts at the top of the page.
   * 面板覆盖顶栏时胶囊会失去焦点；不迁移焦点，关闭后 Tab 会从页首开始。
   */
  const capsuleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // The panel mounts inside AnimatePresence on the next paint. / 面板在下一次绘制时挂载到 AnimatePresence 内。
    const id = window.requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>('button, [href]');
      first?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  /** Trap Tab inside the overlay so focus cannot reach the page behind. / 将 Tab 限制在浮层内，避免焦点跑到后方页面。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (pinned || event.key !== 'Tab' || !panelRef.current) return;
      const items = [
        ...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      ].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, pinned]);
  /** Restore focus only if the panel was open and the closing click did not land elsewhere. / 仅在面板曾打开且关闭点击未落在其他控件时恢复焦点。 */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      if (closedByPointer.current) {
        closedByPointer.current = false;
        return;
      }
      (successRef.current?.querySelector<HTMLButtonElement>('button') ?? capsuleRef.current)?.focus({ preventScroll: true });
    }
  }, [open]);

  const errorText = (error: unknown) => (apiErrorMessage(error));

  /** Mutate the shared overview cache so every surface updates together; one action at a time. / 修改共享概览缓存，所有界面同步更新；一次只允许一个操作。 */
  async function runAction(monitor: OverviewMonitor, action: 'toggle' | 'check') {
    if (actionLock.current) return;
    actionLock.current = true;
    setPendingAction({ id: monitor.id, action });
    try {
      if (action === 'toggle') {
        const next = monitor.active ? 0 : 1;
        await monitorsApi.updateMonitor(monitor.id, { active: next });
        await mutate(OVERVIEW_KEY);
        toast.success(t(next ? 'toast.resumed' : 'toast.paused', { name: monitor.name }));
      } else {
        await monitorsApi.checkMonitor(monitor.id);
        await mutate(OVERVIEW_KEY);
        toast.success(t('island.checkedAgo', { ago: ago(Math.floor(Date.now() / 1000)) }));
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        navigate('/login', { replace: true, state: { from: '/admin' } });
        return;
      }
      toast.error(t('island.error'), { description: errorText(error) });
    } finally {
      actionLock.current = false;
      setPendingAction(null);
    }
  }

  async function copySummary() {
    const lines: string[] = [summaryText];
    if (issues.length > 0) {
      lines.push('', t('island.issues'));
      for (const { monitor } of issues.slice(0, 6)) {
        const when = monitor.checked_at ? ` (${ago(monitor.checked_at)})` : '';
        lines.push(`- ${monitor.name}${monitor.msg ? ` — ${monitor.msg}` : ''}${when}`);
      }
      if (issues.length > 6) lines.push(`… +${issues.length - 6}`);
    }
    if (offline.length > 0) {
      lines.push('', t('island.agents'));
      for (const agent of offline.slice(0, 4)) {
        const when = agent.last_reported_at ? ` (${ago(agent.last_reported_at)})` : '';
        lines.push(`- ${agent.name}${when}`);
      }
      if (offline.length > 4) lines.push(`… +${offline.length - 4}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success(t('island.copied'));
    } catch (error) {
      toast.error(t('action.copy'), { description: apiErrorMessage('clipboard_copy_failed') });
    }
  }

  async function refreshStatus() {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    try { await Promise.all([overview.mutate(), fleet.mutate(), events.mutate()]); }
    catch (error) { toast.error(apiErrorMessage(error)); }
    finally { refreshLock.current = false; setRefreshing(false); }
  }

  function openEvents() {
    markSeen(newestEvent);
    go('/admin/settings#settings-events');
  }

  function restoreFeedbackFocus() {
    window.requestAnimationFrame(() => {
      const target = open ? panelRef.current?.querySelector<HTMLButtonElement>('button') : successRef.current?.querySelector<HTMLButtonElement>('button');
      (target ?? capsuleRef.current)?.focus({ preventScroll: true });
    });
  }

  return (
    <div ref={root} className="relative flex h-8 justify-center" style={open || success ? { width: capsuleWidth } : undefined}>
      <LayoutGroup id={islandId}>
      <AnimatePresence initial={false}>
      {!open && !success ? <motion.button
        ref={capsuleRef}
        type="button"
        layout
        layoutId="island-surface"
        style={{ borderRadius: 20, boxShadow: '0px 6px 16px -6px rgba(0,0,0,0.45)' }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${summaryText}${notifications.muted ? ` · ${t('island.muted')}` : unread ? ` · ${t('island.unreadCount', { n: unread })}` : ''}`}
        data-status-island=""
        onClick={() => { setCapsuleWidth(capsuleRef.current?.offsetWidth ?? 160); setOpen(true); }}
        animate={{ opacity: 1, y: bouncing ? [0, -3, 0] : 0 }}
        exit={{ opacity: 0, transition: { duration: 0.08 } }}
        transition={{ duration: 0.22, ease: [0.2, 0, 0, 1], layout: islandSpring }}
        whileHover={{ scale: 1.025 }}
        whileTap={{ scale: 0.98 }}
        className={clsx(
          'group relative flex h-8 w-fit max-w-full items-center gap-2 overflow-hidden border border-white/[0.08] bg-[var(--polaris-island)] pr-3 pl-3 text-[12px] font-medium text-[var(--polaris-island-ink)] lg:max-w-[min(560px,50vw)]',
        )}
      >
        {bouncing ? <motion.span aria-hidden="true" initial={{ x: '-160%' }} animate={{ x: '300%' }} transition={{ duration: 0.22, ease: 'easeOut' }} className="pointer-events-none absolute inset-y-0 left-0 w-1/2" style={{ background: 'linear-gradient(110deg,transparent,rgba(255,255,255,.16),transparent)' }} /> : null}
        <motion.span layout="position" className="relative flex min-w-0 items-center gap-2">
        {allClear ? <CircleCheck size={13} className="shrink-0 text-emerald-400" /> : <span className={clsx('h-2 w-2 shrink-0 rounded-full', DOT[worst])} />}
        <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
          {segments.length ? <>
            {segments.map((segment, index) => <span key={segment.key} className="flex items-center gap-1.5">{index > 0 ? <span className={clsx('h-1 w-1 shrink-0 rounded-full', segment.dot)} /> : null}<span className="polaris-num">{segment.text}</span></span>)}
            <span className="h-3 w-px shrink-0 bg-white/15" />
            <span className="polaris-num text-zinc-400">{t('island.up', { n: up })}</span>
          </> : <span className="truncate">{summaryText}</span>}
        </span>
        {notifications.muted ? <BellOff size={12} className="shrink-0 text-zinc-400" /> : unread ? <span className="polaris-num flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-full bg-white/12 px-1.5 text-[10.5px]"><Bell size={10} />{unread > 9 ? '9+' : unread}</span> : null}
        <ChevronDown size={11} className="shrink-0 text-zinc-500 transition-colors group-hover:text-zinc-300" />
        </motion.span>
      </motion.button> : null}
      </AnimatePresence>

      {createPortal(<AnimatePresence>
        {!open && success ? (
          <div className="polaris pointer-events-none fixed inset-x-0 top-3 z-[1000] flex justify-center px-4" data-react-aria-top-layer="true">
            <motion.div ref={successRef} layout layoutId="island-surface" initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }} transition={{ layout: islandSpring, opacity: { duration: 0.18 } }} style={{ borderRadius: 22, boxShadow: '0px 12px 32px -10px rgba(0,0,0,0.45)' }} className="pointer-events-auto w-fit min-w-[min(320px,calc(100vw-2rem))] max-w-[min(560px,calc(100vw-2rem))] overflow-hidden border border-white/[0.08] bg-[var(--polaris-island)] text-[var(--polaris-island-ink)]">
              <SuccessFeedbackCard key={success.id} feedback={success} compact onOpen={() => setOpen(true)} onDismiss={restoreFeedbackFocus} />
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>, document.body, 'island-success')}

      {createPortal(<AnimatePresence>
        {open && desktop ? <div className="polaris pointer-events-none fixed inset-x-0 top-2 z-[1000] flex justify-center" data-react-aria-top-layer="true">
        <motion.div
          layout
          layoutId="island-surface"
          ref={panelRef}
          role="dialog"
          aria-modal={!pinned}
          aria-label={t('island.title')}
          data-status-island-panel=""
          initial={false}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.24 } }}
          transition={{ layout: islandSpring, opacity: { duration: 0.18 } }}
          style={{ borderRadius: 26, boxShadow: '0px 24px 60px -16px rgba(0,0,0,0.55)', transformOrigin: 'top center' }}
          className="polaris-island-panel pointer-events-auto w-[440px] max-w-[calc(100vw-1rem)] overflow-hidden border border-white/[0.08] bg-[var(--polaris-island)] text-[var(--polaris-island-ink)]"
        >
          <motion.div layout="position" initial="closed" animate="open" exit="closed" variants={{ closed: { opacity: 0, transition: { staggerChildren: 0.025, staggerDirection: -1 } }, open: { opacity: 1, transition: { delayChildren: 0.16, staggerChildren: 0.055 } } }}>
            <motion.div layout="position" variants={contentMotion} className="flex items-center gap-2 px-4 pt-4 pb-3">
              <span className={clsx('h-2 w-2 shrink-0 rounded-full', DOT[worst])} />
              <div className="min-w-0 flex-1"><h2 className="truncate text-[13px] font-semibold">{t('island.title')}</h2>{lastCheck ? <p className="mt-0.5 truncate text-[10.5px] text-zinc-500">{t('island.checkedAgo', { ago: ago(lastCheck) })}</p> : null}</div>
              <button type="button" onClick={() => void refreshStatus()} disabled={refreshing} aria-label={t('island.refresh')} title={t('island.refresh')} className={ICON_BUTTON}><RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} /></button>
              <button type="button" onClick={() => void copySummary()} aria-label={t('island.copySummary')} title={t('island.copySummary')} className={ICON_BUTTON}><Copy size={14} /></button>
              <button type="button" onClick={() => setPinned(value => !value)} aria-label={t(pinned ? 'island.unpin' : 'island.pin')} title={t(pinned ? 'island.unpin' : 'island.pin')} aria-pressed={pinned} className={clsx(ICON_BUTTON, pinned && 'bg-white/10 text-white')}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
              <button type="button" onClick={() => setOpen(false)} aria-label={t('island.close')} title={t('island.close')} className={ICON_BUTTON}><X size={15} /></button>
            </motion.div>

            <AnimatePresence initial={false}>
              {success ? <motion.div key={success.id} layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}><SuccessFeedbackCard feedback={success} onDismiss={restoreFeedbackFocus} /></motion.div> : null}
            </AnimatePresence>

            {counts && !empty ? <motion.div layout="position" variants={contentMotion} className="mx-4 grid grid-cols-5 divide-x divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.045]">
              {([
                ['up', up, t('stat.up')], ['down', down, t('stat.down')], ['pending', pending, t('stat.pending')], ['warn', warn, t('stat.warn')], ['idle', paused, t('island.paused')],
              ] as const).map(([key, value, label]) => <div key={key} className="flex min-w-0 flex-col gap-2 px-2.5 py-3">
                <span className="flex items-center gap-1.5 text-[10.5px] leading-tight text-zinc-400"><span className={clsx('h-1 w-1 shrink-0 rounded-full', DOT[key])} /><span className="min-w-0 break-words">{label}</span></span>
                <motion.span key={value} initial={{ opacity: 0.5, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className={clsx('polaris-num text-[20px] leading-none font-semibold', value === 0 && 'text-zinc-500')}>{value}</motion.span>
              </div>)}
            </motion.div> : null}

            <motion.div layout="position" variants={contentMotion} role="tablist" aria-label={t('island.title')} className="mx-4 mt-3 flex gap-1 rounded-full bg-white/[0.04] p-0.5">
              {(['issues', 'activity'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} aria-controls={`island-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 'issues' : event.key === 'End' ? 'activity' : value === 'issues' ? 'activity' : 'issues';
                setTab(next);
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[aria-controls="island-${next}"]`)?.focus();
              }} className={clsx('relative flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors', tab === value ? 'text-white' : 'text-zinc-400 hover:text-zinc-200')}>
                {tab === value ? <motion.span layoutId="island-tab" transition={islandSpring} className="absolute inset-0 rounded-full bg-white/10 shadow-sm" /> : null}
                <span className="relative flex items-center gap-1.5">{value === 'issues' ? <ShieldCheck size={12} /> : <Bell size={12} />}
                {t(value === 'issues' ? 'island.issues' : 'island.activity')}
                {value === 'activity' && unread > 0 ? <span className="polaris-num rounded-full bg-white/10 px-1.5 text-[10px]">{unread}</span> : null}</span>
              </button>)}
            </motion.div>

            {loadError ? <div role="alert" className="mx-4 mt-3 rounded-xl bg-white/[0.045] px-3 py-2 text-[12px] leading-relaxed text-amber-300">{apiErrorMessage(loadError)}</div> : null}

            <motion.div layout="position" variants={contentMotion} id={`island-${tab}`} role="tabpanel" aria-label={t(tab === 'issues' ? 'island.issues' : 'island.activity')} className="polaris-scrollbar relative max-h-[min(380px,52dvh)] overflow-y-auto overscroll-contain px-2 py-2">
              <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={tab} layout="position" initial={{ opacity: 0, x: tab === 'activity' ? 8 : -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: tab === 'activity' ? 8 : -8, transition: { duration: 0.1 } }} transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}>
                {tab === 'issues' ? <>
                  {!counts ? <div role="status" className="flex items-center justify-center gap-2 py-10 text-[12px] text-zinc-400">{!loadError ? <Loader2 size={15} className="animate-spin" /> : null}{t(loadError ? 'island.loadFailed' : 'console.statusLoading')}</div> : null}
                  {empty ? <IslandEmpty kind="monitors" onAdd={() => go('/admin')} /> : inactive ? <IslandEmpty kind="inactive" onAdd={() => go('/admin')} /> : counts && issues.length === 0 && offline.length === 0 && !loadError ? <IslandEmpty kind="healthy" /> : null}
                  <IssueList issues={issues} offline={offline} pendingAction={pendingAction} go={go} runAction={runAction} />
                </> : <>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-1 pb-2">
                    <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(value => !value)} className={clsx('rounded-full px-2.5 py-1 text-[11px] transition-colors', unreadOnly ? 'bg-white/12 text-white' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200')}>{t('island.unreadOnly')}</button>
                    <button type="button" disabled={unread === 0} onClick={() => markSeen(newestEvent)} className="flex items-center gap-1 text-[11px] text-zinc-300 hover:text-white disabled:text-zinc-600"><CheckCheck size={13} />{t('island.markAllRead')}</button>
                  </div>
                  {events.error ? <p role="alert" className="px-3 py-2 text-[12px] text-amber-300">{t('settings.eventsLoadFailed')}</p> : null}
                  {!events.data && !events.error ? <div role="status" className="flex justify-center py-10"><Loader2 size={17} className="animate-spin text-zinc-400" /></div> : shownEvents.length === 0 && !events.error ? <IslandEmpty kind="activity" /> : null}
                  <ActivityList shownEvents={shownEvents} seen={notifications.seen} islandSpring={islandSpring} markSeen={markSeen} go={go} />
                </>}
              </motion.div>
              </AnimatePresence>
            </motion.div>

            <motion.div layout="position" variants={contentMotion} className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] px-4 py-2.5 text-[11.5px]">
              <IslandFooter muted={notifications.muted} onMute={notifications.muted ? notifications.resume : notifications.snooze} onOpen={tab === 'activity' ? openEvents : () => go(down ? '/admin?state=down' : pending ? '/admin?state=pending' : warn ? '/admin?state=warn' : '/admin')} openLabel={t(tab === 'activity' ? 'island.viewEvents' : 'island.openMonitors')} />
            </motion.div>
            <p role="status" className="sr-only">{summaryText}{unread > 0 ? ` · ${t('island.unreadCount', { n: unread })}` : ''}</p>
          </motion.div>
        </motion.div></div> : null}
      </AnimatePresence>, document.body, 'island-panel')}
      </LayoutGroup>
    </div>
  );
}

function IslandEmpty({ kind, onAdd }: { kind: 'healthy' | 'activity' | 'monitors' | 'inactive'; onAdd?: () => void }) {
  const t = useTranslations('admin');
  const Icon = kind === 'healthy' ? ShieldCheck : kind === 'activity' ? Bell : kind === 'inactive' ? Pause : Plus;
  const title = kind === 'healthy' ? 'quietTitle' : kind === 'activity' ? 'activityEmptyTitle' : kind === 'inactive' ? 'inactiveTitle' : 'noMonitorsTitle';
  const hint = kind === 'healthy' ? 'quietHint' : kind === 'activity' ? 'activityEmptyHint' : kind === 'inactive' ? 'inactiveHint' : 'noMonitorsHint';
  return <div className="flex flex-col items-center px-5 py-7 text-center">
    <motion.div initial={{ scale: 0.9, y: 4 }} animate={{ scale: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.2, 0, 0, 1] }} className="relative flex h-16 w-16 items-center justify-center">
      <motion.span aria-hidden="true" initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.45, delay: 0.05 }} className="absolute inset-0 rounded-full border border-white/[0.06]" />
      <span className="absolute inset-2 rounded-full border border-white/[0.08] bg-white/[0.035]" />
      <Icon size={23} strokeWidth={1.5} className={clsx('relative', kind === 'healthy' ? 'text-emerald-300' : 'text-zinc-300')} />
      {kind === 'healthy' ? <motion.span aria-hidden="true" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.2, delay: 0.12 }} className="absolute right-0 bottom-1 flex h-5 w-5 items-center justify-center rounded-full border-[3px] border-[var(--polaris-island)] bg-emerald-400"><CircleCheck size={11} className="text-emerald-950" /></motion.span> : null}
    </motion.div>
    <h3 className="mt-3 text-[13px] font-semibold text-zinc-100">{t(`island.${title}`)}</h3>
    <p className="mt-1.5 max-w-[17rem] text-[12px] leading-relaxed text-zinc-400">{t(`island.${hint}`)}</p>
    {onAdd ? <button type="button" onClick={onAdd} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-full border border-white/15 px-3 text-[11.5px] font-medium text-zinc-200 transition-colors hover:bg-white/[0.07]">{t('island.openMonitors')}<ArrowRight size={12} /></button> : null}
  </div>;
}

function IssueList({ issues, offline, pendingAction, go, runAction }: {
  issues: Array<{
    monitor: OverviewMonitor;
    severity: Severity;
  }>;
  offline: NonNullable<ReturnType<typeof useFleet>['data']>['agents'];
  pendingAction: {
    id: string;
    action: 'toggle' | 'check';
  } | null;
  go: (path: string) => void;
  runAction: (monitor: OverviewMonitor, action: 'toggle' | 'check') => Promise<void>;
}) {
  const t = useTranslations('admin');
  const ago = useTimeAgo();
  return <>
    {issues.slice(0, 6).map(({ monitor, severity }) => {
      const checking = pendingAction?.id === monitor.id && pendingAction.action === 'check';
      const toggling = pendingAction?.id === monitor.id && pendingAction.action === 'toggle';
      const probeable = (monitor.type === 'http' || monitor.type === 'tcp') && monitor.source !== 'agent';
      return <div key={monitor.id} className="flex items-center gap-1 rounded-2xl px-1 transition-colors hover:bg-white/[0.055]">
        <button type="button" onClick={() => go(monitor.type === 'agent' ? `/admin/agents?agent=${encodeURIComponent(monitor.id)}` : `/admin?monitor=${encodeURIComponent(monitor.id)}`)} aria-label={`${monitor.name}: ${t('island.openDetails')}`} className="flex min-w-0 flex-1 items-start gap-3 rounded-xl px-2 py-3 text-left">
          <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', DOT[severity])} />
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{monitor.name}</span>{monitor.msg ? <span className="mt-0.5 block truncate text-[11.5px] text-zinc-400" title={monitor.msg}>{monitor.msg}</span> : null}<span className="mt-1 block text-[10.5px] text-zinc-500">{checking ? t('island.checking') : monitor.checked_at ? ago(monitor.checked_at) : ''}</span></span>
        </button>
        <button type="button" onClick={() => void runAction(monitor, 'toggle')} aria-label={t(monitor.active ? 'island.pause' : 'island.resume')} title={t(monitor.active ? 'island.pause' : 'island.resume')} aria-busy={toggling} className={ICON_BUTTON}>{toggling ? <Loader2 size={13} className="animate-spin" /> : monitor.active ? <Pause size={13} /> : <Play size={13} />}</button>
        {probeable ? <button type="button" onClick={() => void runAction(monitor, 'check')} aria-label={t(checking ? 'island.checking' : 'island.checkNow')} title={t(checking ? 'island.checking' : 'island.checkNow')} aria-busy={checking} className={clsx(ICON_BUTTON, 'mr-1')}>{checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}</button> : null}
      </div>;
    })}
    {offline.length > 0 ? <p className="px-3 pt-2 pb-1 text-[10.5px] font-medium text-zinc-500">{t('island.agents')}</p> : null}
    {offline.slice(0, 4).map(agent => <button key={agent.id} type="button" onClick={() => go(`/admin/agents?agent=${encodeURIComponent(agent.id)}`)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-white/[0.055]"><Server size={15} className="shrink-0 text-zinc-400" /><span className="min-w-0 flex-1 truncate text-[13px] font-medium">{agent.name}</span><span className="shrink-0 text-[11px] text-zinc-500">{agent.last_reported_at ? ago(agent.last_reported_at) : '—'}</span></button>)}
  </>;
}

function ActivityList({ shownEvents, seen, islandSpring, markSeen, go }: {
  shownEvents: ReturnType<typeof joinEvents>;
  seen: number;
  islandSpring: {
    type: 'spring';
    duration: number;
    bounce: number;
  };
  markSeen: (id: number) => void;
  go: (path: string) => void;
}) {
  const t = useTranslations('admin');
  const ago = useTimeAgo();
  return (<ul className="relative space-y-0.5">
    <AnimatePresence initial={false} mode="popLayout">
      {shownEvents.slice(0, 12).map((row, index) => {
        const unreadRow = row.id > seen;
        const status = row.status === 0 ? 'down' : row.status === 2 ? 'warn' : row.status === 4 ? 'pending' : 'up';
        return <motion.li layout="position" key={row.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 12, transition: { duration: 0.14 } }} transition={{ duration: 0.16, delay: Math.min(index, 4) * 0.025, layout: islandSpring }}>
          <button type="button" onClick={() => {
            markSeen(row.id);
            if (row.monitor) go(row.monitor.type === 'agent' ? `/admin/agents?agent=${encodeURIComponent(row.monitor_id)}` : `/admin?monitor=${encodeURIComponent(row.monitor_id)}`);
          }} disabled={!row.monitor} className={clsx('flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors enabled:hover:bg-white/[0.07]', unreadRow && 'bg-white/[0.035]')}>
            <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', DOT[status])} />
            <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className="truncate text-[12.5px] font-medium">{row.name ?? t('insights.deletedMonitor')}</span><span className="shrink-0 text-[10.5px] text-zinc-400">{t(`status.${status}`)}</span>{unreadRow ? <span className="ml-auto h-1 w-1 shrink-0 rounded-full bg-sky-300" aria-label={t('island.unreadOnly')} /> : null}</span>{row.message ? <span className="mt-1 block truncate text-[11.5px] leading-relaxed text-zinc-400" title={row.message}>{row.message}</span> : null}<time dateTime={new Date(row.created_at * 1000).toISOString()} className="polaris-num mt-1 block text-[10.5px] text-zinc-500">{ago(row.created_at)}</time></span>
          </button>
        </motion.li>;
      })}
    </AnimatePresence>
  </ul>);
}

function IslandFooter({ muted, onMute, onOpen, openLabel }: {
  muted: boolean;
  onMute: () => void;
  onOpen: () => void;
  openLabel: string;
}) {
  const t = useTranslations('admin');
  return <>
    <button type="button" onClick={onMute} aria-label={t(muted ? 'island.resumeNotifications' : 'island.snooze')} title={t(muted ? 'island.resumeNotifications' : 'island.snooze')} className="flex h-7 items-center gap-1.5 rounded-lg px-1 text-zinc-400 transition-colors hover:text-white">{muted ? <BellOff size={13} /> : <Bell size={13} />}{t(muted ? 'island.resumeNotifications' : 'island.snooze')}</button>
    <button type="button" onClick={onOpen} className="flex h-7 items-center gap-1.5 rounded-lg px-1 font-medium text-zinc-200 transition-colors hover:text-white">{openLabel}<ArrowRight size={13} /></button>
  </>;
}
