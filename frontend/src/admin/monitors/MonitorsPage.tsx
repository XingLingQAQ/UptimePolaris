import { AnimatePresence, LayoutGroup, motion, useIsPresent } from 'framer-motion';
import { NAV_TRANSITION, FEEDBACK_TRANSITION } from '@/lib/motion';
import { MotionDisclosure } from '@/components/ui/MotionDisclosure';
import { Drawer, Modal, Dropdown, Select } from '@/components/ui/MotionOverlays';
import { UnauthorizedError } from '@/api/errors';
import { MONITOR_TYPES } from '../../../../shared/backend-capabilities';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import {
  Button,
  Checkbox,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  SelectItem,
  Skeleton,
  Tooltip,
} from '@heroui/react';
import clsx from 'clsx';
import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  Ellipsis,
  Eye,
  EyeOff,
  Loader2,
  LockKeyhole,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { MonitorGlyph } from '../../components/monitor/MonitorGlyph';
import { SparkLine } from '../../components/ui/MetricFigures';
import { Segmented } from '../../components/ui/Segmented';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import type { Tone } from '../../types/tone';
import { EmptyState } from '../components/ConsolePrimitives';
import { PulseArt, SearchArt } from '../components/illustrations';
import { OnboardingChecklist } from '../components/OnboardingChecklist';
import { formatAvailability } from '../format';
import { groupsApi } from '../groups/api';
import type { MonitorGroup } from '../groups/types';
import { jobsApi } from '../jobs-api';
import { AdminPage } from '../layout/AdminPage';
import { useConsoleRefreshInterval, useOverview } from '../useConsoleData';
import { monitorsApi } from './api';
import { ringLatency } from './insights';
import { MonitorForm } from './MonitorForm';
import { CheckRail } from './MonitorIndicators';
import { MonitorInsights } from './MonitorInsights';
import { MonitorOverview } from './MonitorOverview';
import { MonitorQuickView } from './MonitorQuickView';
import { tagKey } from './options';
import { TYPE_LABEL, readingLabel, toneForStatus } from './presentation';
import type { AddonReading, Monitor, MonitorTag, MonitorType, OverviewCounts, OverviewMonitor } from './types';

/** Empty summary, so the strip renders before the first response lands. / 空汇总使指标栏可在首次响应到达前渲染。 */
const EMPTY_COUNTS: OverviewCounts = { total: 0, up: 0, warn: 0, down: 0, pending: 0, paused: 0 };

/** Sentinel for "all groups" in the toolbar filter; NUL cannot appear in a group id. / 工具栏“全部分组”哨兵；分组 ID 不含 NUL。 */
const ALL_GROUPS = '\u0000all';
/** Same sentinel device as `ALL_GROUPS`, for the tag filter beside it. / 标签筛选器使用与 `ALL_GROUPS` 相同的哨兵方案。 */
const ALL_TAGS = '\u0000all-tags';

/** The buckets the status filter accepts, from the overview tiles or `?state=`. / 状态筛选接受的类别，来源为概览指标或 `?state=`。 */
const STATE_BUCKETS = ['up', 'warn', 'pending', 'down', 'paused'] as const;


/** 展示监控总览，并协调筛选、编辑和即时检查。 / Display the monitor overview and coordinate filtering, editing, and immediate checks. */
export function MonitorsPage() {
  const refreshInterval = useConsoleRefreshInterval();
  const navigate = useNavigate();
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const [params, setParams] = useSearchParams();

  /** Fleet data from the shared cache, so page and frame share one request. / 共享缓存中的机器列表，页面和框架共用一次请求。 */
  const { data, error: loadError, mutate, isValidating } = useOverview();
  const monitors = data?.monitors ?? (loadError ? [] : null);
  const counts = data?.counts ?? EMPTY_COUNTS;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  /** Selected group filter, null for all groups. / 当前分组筛选，null 表示全部。 */
  const [groupFilter, setGroupFilter] = useState<string | null>(null);

  /** Selected tag filter, null for all tags; a monitor matches any of its tags. / 当前标签筛选，null 表示全部；监控带任一标签即匹配。 */
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  /** Status filter from the overview strip; null means all. / 概览条的状态筛选；null 表示全部。 */
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);

  const [editing, setEditing] = useState<Monitor | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [newType, setNewType] = useState<MonitorType | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Monitor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [quickId, setQuickId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    await mutate();
  }, [mutate]);

  /** Deep-link intents (`monitor`, `new`, `state`); each is consumed once. / 深链接意图（`monitor`、`new`、`state`），读取后移除。 */
  useEffect(() => {
    const focus = params.get('monitor');
    const state = params.get('state');
    const create = params.get('new');
    if (!focus && !state && !create) return;
    if (focus) setQuickId(focus);
    if (state && (STATE_BUCKETS as readonly string[]).includes(state)) setStatusFilter(state);
    if (create) {
      setEditing(null);
      // `?new=agent` preselects the type before the drawer's first paint. / `?new=agent` 在抽屉首次绘制前预选类型。
      setNewType(MONITOR_TYPES.includes(create as MonitorType) ? (create as MonitorType) : null);
      setFormOpen(true);
    }
    const next = new URLSearchParams(params);
    next.delete('monitor');
    next.delete('state');
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams]);

  /**
   * Group vocabulary for the toolbar filter.
   *
   * Loaded independently of the fleet so a failure leaves an empty select rather
   * than an error state; refreshing the fleet should not refetch a vocabulary
   * that only changes on another page. The form shares the loader because it can
   * create a group.
   * 与机器列表分开加载；刷新列表不重取词表，失败时保持空选择器。
   */
  const loadGroups = useCallback(() => {
    void groupsApi.listGroups().then(
      ({ groups: rows }) => setGroups(rows),
      () => setGroups([]),
    );
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  /** Groups that actually contain monitors, derived from loaded rows. / 仅包含有监控的分组，从已加载行推导。 */
  const groupsInUse = useMemo(() => {
    const ids = new Set((monitors ?? []).map((m) => m.group_id).filter(Boolean) as string[]);
    return groups.filter((g) => ids.has(g.id));
  }, [groups, monitors]);

  /** group_id to name; a missing group renders as ungrouped. / group_id 到名称；缺失时显示未分组。 */
  const groupNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const g of groups) out[g.id] = g.name;
    return out;
  }, [groups]);

  /** Tags in use, derived from monitors and sorted by name. / 实际使用的标签，从监控推导并按名称排序。 */
  const tagsInUse = useMemo(() => {
    const byKey = new Map<string, MonitorTag>();
    for (const m of monitors ?? []) {
      for (const tag of m.tags ?? []) byKey.set(tagKey(tag), tag);
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [monitors]);

  async function handleTick() {
    setBusy('tick');
    setError(null);
    try {
      const r = await jobsApi.runTick();
      await load();
      if (r.tick === 'skipped') toast.info(t('toast.checkSkipped'));
      else toast.success(t('toast.checkDone', { ms: r.ms, n: r.monitors }));
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  function handleError(e: unknown) {
    if (e instanceof UnauthorizedError) {
      navigate('/login', { replace: true, state: { from: '/admin' } });
      return;
    }
    const msg = apiErrorMessage(e);
    setError(msg);
    toast.error(msg);
  }

  async function toggleActive(m: Monitor) {
    setBusy(m.id);
    setError(null);
    const turningOn = m.active === 0;
    try {
      await monitorsApi.updateMonitor(m.id, { active: turningOn ? 1 : 0 });
      await load();
      toast.success(t(turningOn ? 'toast.resumed' : 'toast.paused', { name: m.name }));
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setBusy(target.id);
    setPendingDelete(null);
    try {
      await monitorsApi.deleteMonitor(target.id);
      await load();
      toast.success(t('toast.deleted', { name: target.name }));
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  async function togglePublic(m: Monitor) {
    setBusy(m.id);
    setError(null);
    const isPublic = m.is_public === 0;
    try {
      await monitorsApi.updateMonitor(m.id, { is_public: isPublic });
      await load();
      toast.success(t(isPublic ? 'toast.monitorPublished' : 'toast.monitorHidden', { name: m.name }));
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Compose the text, group and tag filters; the group filter applies after text.
   *
   * Keeping it in one `useMemo` makes the filters compose ("which of these")
   * rather than reset each other; a chained pair would re-sort on every change
   * and is easy to wire in the wrong order. Tags match when the selected tag is
   * among a monitor's tags, not an exact set.
   * 组合筛选而非互相重置；标签匹配“包含”而不是精确集合。
   */
  const visible = useMemo(() => {
    if (!monitors) return null;
    const q = query.trim().toLowerCase();
    const rows = monitors.filter((m) => {
      if (groupFilter && m.group_id !== groupFilter) return false;
      if (tagFilter && !(m.tags ?? []).some((tag) => tagKey(tag) === tagFilter)) return false;
      if (statusFilter) {
        // `paused` is the monitor's own flag; the rest are readings, so a paused
        // monitor must not also count as "down" just because it has no fresh
        // reading.
        // `paused` 是监控项自身标志，其余是观测值；暂停项不能仅因没有新读数同时计为故障。
        if (statusFilter === 'paused') {
          if (m.active) return false;
        } else {
          if (!m.active) return false;
          const st = m.st ?? null;
          const bucket = st === 1 ? 'up' : st === 2 ? 'warn' : st === 4 ? 'pending' : 'down';
          if (bucket !== statusFilter) return false;
        }
      }
      if (!q) return true;
      // Tags are searchable too: an operator who remembers the label but not the
      // monitor's name would otherwise have to scan the table for the chip.
      // 标签也可搜索；只记得标签而不记得监控项名称的用户无需逐行查看徽章。
      return (
        m.name.toLowerCase().includes(q) ||
        m.target.toLowerCase().includes(q) ||
        (m.tags ?? []).some((tag) => tag.name.toLowerCase().includes(q))
      );
    });

    // Paused last: the table exists to operate live checks. / 暂停项排在最后：表格主要用于操作实时检查。
    return [...rows].sort((a, b) => {
      if (a.active !== b.active) return b.active - a.active;
      return a.created_at - b.created_at;
    });
  }, [monitors, query, groupFilter, tagFilter, statusFilter]);

  const active = counts.total - counts.paused;
  const selectedMonitors = (monitors ?? []).filter(m => selected.has(m.id));
  const toggleSelection = (id: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllVisible = () => setSelected(previous => {
    const next = new Set(previous);
    const allSelected = visible ? visible.length > 0 && visible.every(m => previous.has(m.id)) : false;
    for (const monitor of visible ?? []) { if (allSelected) next.delete(monitor.id); else next.add(monitor.id); }
    return next;
  });
  const setSelectedVisibility = async (isPublic: boolean) => {
    if (busy !== null) return;
    const ids = selectedMonitors.filter(m => (m.is_public === 1) !== isPublic).map(m => m.id);
    if (ids.length === 0) return;
    setBusy('visibility');
    setError(null);
    try {
      const result = await monitorsApi.setVisibility(ids, isPublic);
      setSelected(new Set());
      await load();
      toast.success(t(isPublic ? 'toast.monitorsPublished' : 'toast.monitorsHidden', { n: result.updated }));
    } catch (e) { handleError(e); }
    finally { setBusy(null); }
  };
  const quick = useMemo(() => (monitors ?? []).find((m) => m.id === quickId) ?? null, [monitors, quickId]);
  const shownError = error ?? (loadError && !(loadError instanceof UnauthorizedError) ? String(loadError.message ?? loadError) : null);

  const openEditor = (m: Monitor | null) => {
    setEditing(m);
    setFormOpen(true);
  };

  /** Stable callback so MonitorOverview's memo keeps working. / 稳定回调，避免破坏 MonitorOverview 的 memo。 */
  const toggleStatusFilter = useCallback((bucket: string) => {
    setStatusFilter((prev) => (prev === bucket ? null : bucket));
  }, []);

  const filterOptions = (['down', 'pending', 'warn', 'up', 'paused'] as const)
    .filter((bucket) => counts[bucket] > 0 || statusFilter === bucket)
    .map((bucket) => ({ value: bucket as string, label: t(`stat.${bucket}`), count: counts[bucket] }));

  return (
    <AdminPage
      title={t('nav.monitors')}
      description={t('list.desc', { total: counts.total, active })}
      actions={
        <>
          <Button
            size="sm"
            variant="bordered"
            className="border-[var(--polaris-line-strong)] bg-[var(--polaris-card)]"
            startContent={busy === 'tick' ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
            onPress={handleTick}
            isDisabled={busy === 'tick'}
          >
            {busy === 'tick' ? t('action.checking') : t('action.checkNow')}
          </Button>
          <Button size="sm" color="primary" startContent={<Plus size={15} />} onPress={() => openEditor(null)}>
            {t('action.add')}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {/*
          The getting-started card, above the figures.

          First in the column because on a deployment that is not set up yet it
          is the only thing on the page that is actionable - the tiles below it
          are four zeros. It removes itself once every step is done or the
          operator dismisses it, so a working console pays one render, not a
          permanent band of advice.

          入门卡放在指标上方：部署尚未设置时，下方四个零值指标不能操作，
          而此卡可以引导操作。全部步骤完成或用户关闭后自动移除，
          已运行的控制台只承担一次渲染，不会永久显示建议栏。
        */}
        <OnboardingChecklist onAddMonitor={() => openEditor(null)} />

        <MonitorOverview
          counts={counts}
          monitors={monitors ?? []}
          stateFilter={statusFilter}
          onFilter={toggleStatusFilter}
        />

        {monitors && monitors.length > 0 ? <MonitorInsights monitors={monitors} onOpenMonitor={setQuickId} /> : null}

        {shownError ? (
          <div className="flex items-center gap-3 rounded-xl border border-danger/20 bg-danger/[0.04] px-4 py-2.5 text-[13px] text-danger-600">
            <TriangleAlert size={16} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={shownError}>
              {shownError}
            </span>
            <Button size="sm" variant="light" color="danger" onPress={() => void load()}>
              {t('action.retry')}
            </Button>
          </div>
        ) : null}

        <MotionDisclosure open={selectedMonitors.length > 0} className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--polaris-line-strong)] bg-[var(--polaris-card)] px-3 py-2">
            <span className="text-small font-semibold">{t('list.selectedCount', { n: selectedMonitors.length })}</span>
            <Dropdown>
              <DropdownTrigger><Button size="sm" variant="flat" isDisabled={busy !== null} isLoading={busy === 'visibility'} endContent={<ChevronDown size={14} />}>{t('list.bulkActions')}</Button></DropdownTrigger>
              <DropdownMenu aria-label={t('list.bulkActions')}>
                <DropdownItem key="hide" startContent={<EyeOff size={15} />} isDisabled={!selectedMonitors.some(m => m.is_public === 1)} onPress={() => void setSelectedVisibility(false)}>{t('action.hideFromPublic')}</DropdownItem>
                <DropdownItem key="show" startContent={<Eye size={15} />} isDisabled={!selectedMonitors.some(m => m.is_public === 0)} onPress={() => void setSelectedVisibility(true)}>{t('action.showOnPublic')}</DropdownItem>
              </DropdownMenu>
            </Dropdown>
            <Button size="sm" variant="light" className="ml-auto" isDisabled={busy === 'visibility'} onPress={() => setSelected(new Set())}>{t('list.clearSelection')}</Button>
        </MotionDisclosure>

        <section className={clsx('polaris-card flex min-h-[22rem] flex-col overflow-hidden', isValidating && data && 'polaris-sweep')}>
          {/* Toolbar: the status filter on the left, finding and narrowing on the right. / 工具栏左侧为状态筛选，右侧用于查找和缩小范围。 */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--polaris-line)] px-3 py-2.5">
            <Segmented
              label={t('col.status')}
              value={statusFilter ?? 'all'}
              onChange={(value) => setStatusFilter(value === 'all' ? null : value)}
              options={[{ value: 'all', label: t('list.filterAll'), count: counts.total }, ...filterOptions]}
            />

            <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
              {groupsInUse.length > 0 ? (
                <Select
                  items={[
                    { key: ALL_GROUPS, label: t('list.allGroups') },
                    ...groupsInUse.map((group) => ({ key: group.id, label: group.name })),
                  ]}
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t('list.filterGroup')}
                  selectedKeys={[groupFilter ?? ALL_GROUPS]}
                  disallowEmptySelection
                  onChange={(e) => setGroupFilter(e.target.value === ALL_GROUPS ? null : e.target.value)}
                >
                  {(item) => <SelectItem key={item.key} textValue={item.label}>{item.label}</SelectItem>}
                </Select>
              ) : null}
              {tagsInUse.length > 0 ? (
                <Select
                  items={[
                    { key: ALL_TAGS, label: t('list.allTags') },
                    ...tagsInUse.map((tag) => ({ key: tagKey(tag), label: tag.name })),
                  ]}
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t('list.filterTag')}
                  selectedKeys={[tagFilter ?? ALL_TAGS]}
                  disallowEmptySelection
                  onChange={(e) => setTagFilter(e.target.value === ALL_TAGS ? null : e.target.value)}
                >
                  {(item) => <SelectItem key={item.key} textValue={item.label}>{item.label}</SelectItem>}
                </Select>
              ) : null}
              <Input
                size="sm"
                className="w-full sm:w-60"
                placeholder={t('list.search')}
                value={query}
                onValueChange={setQuery}
                startContent={<Search className="shrink-0 text-[var(--polaris-ink-4)]" size={14} />}
                endContent={
                  query ? (
                    <button
                      type="button"
                      aria-label={t('action.cancel')}
                      onClick={() => setQuery('')}
                      className="text-[var(--polaris-ink-4)] transition-colors hover:text-[var(--polaris-ink)]"
                    >
                      <X size={14} />
                    </button>
                  ) : null
                }
                isClearable={false}
              />
            </div>
          </div>

          {/*
            The table is 464px wide, so on a phone it scrolls sideways inside
            this box. The console hides scrollbars globally to keep the chrome
            quiet; here that would leave the "操作" column looking cut off
            rather than scrollable, so the hint is put back.

            表格宽 464px，手机上需在此容器内水平滚动。控制台全局隐藏滚动条以保持简洁；
            此处若隐藏会使“操作”列看起来像被截断而非可滚动，因此恢复滚动提示。
          */}
          <div className="polaris-scroll-x min-h-0 flex-1 overflow-x-auto">
            {visible === null ? (
              <div className="flex flex-col gap-2 p-4">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-14 rounded-lg" />
                ))}
              </div>
            ) : monitors && monitors.length === 0 && !loadError ? (
              <EmptyState
                art={<PulseArt />}
                title={t('list.empty')}
                hint={t('list.emptyHint')}
                action={
                  <Button color="primary" size="sm" startContent={<Plus size={15} />} onPress={() => openEditor(null)}>
                    {t('list.addFirst')}
                  </Button>
                }
              />
            ) : visible.length === 0 ? (
              <EmptyState
                art={<SearchArt />}
                title={t('list.noMatch')}
                action={
                  query || statusFilter || groupFilter || tagFilter ? (
                    <Button
                      size="sm"
                      variant="bordered"
                      onPress={() => {
                        setQuery('');
                        setStatusFilter(null);
                        setGroupFilter(null);
                        setTagFilter(null);
                      }}
                    >
                      {t('list.clearFilter')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <MonitorTable
                rows={visible}
                busy={busy}
                groupNames={groupNames}
                selected={selected}
                onToggleSelection={toggleSelection}
                onToggleAll={toggleAllVisible}
                onOpen={(m) => setQuickId(m.id)}
                onEdit={(m) => openEditor(m)}
                onToggle={toggleActive}
                onTogglePublic={togglePublic}
                onDelete={(m) => setPendingDelete(m)}
              />
            )}
          </div>

          <div className="flex shrink-0 items-center gap-4 border-t border-[var(--polaris-line)] px-4 py-2.5 text-[12px] text-[var(--polaris-ink-3)]">
            <span className="polaris-num">{t('list.footShown', { shown: visible?.length ?? 0, total: counts.total })}</span>
            <span className="flex items-center gap-1.5">
              <span className="polaris-live h-1.5 w-1.5 rounded-full bg-success" />
              {t('list.autoRefresh', { seconds: refreshInterval / 1000 })}
            </span>
            <span className="polaris-num ml-auto">{t('list.footActive', { n: active })}</span>
          </div>
        </section>
      </div>

      {/* Editor. A drawer rather than an inline panel: creating a monitor is a
          detour, and the drawer keeps the list in view while it is open.
          编辑器使用抽屉而非内联面板：创建监控项是临时操作，打开时仍可看到列表。 */}
      {/* `xl`, not `lg`: HeroUI's `lg` drawer is 512px, which leaves 89px per
          column once the agent alert rows lay out four cells. The extra width
          is what keeps those inputs readable.
          使用 xl 而非 lg：HeroUI 的 lg 抽屉宽 512px，Agent 告警行的四格各仅剩 89px；
          额外宽度让输入保持可读。 */}
      <Drawer isOpen={formOpen} onOpenChange={setFormOpen} placement="right" size="xl" scrollBehavior="inside">
        <DrawerContent>
          {(onClose) => (
            <>
              <DrawerHeader className="flex flex-col gap-0.5 border-b border-[var(--polaris-line)] px-6 py-4">
                <p className="text-[15px] font-semibold tracking-[-0.01em]">{editing ? t('form.edit') : t('form.create')}</p>
                {editing ? <p className="truncate text-[12.5px] font-normal text-[var(--polaris-ink-3)]">{editing.name}</p> : null}
              </DrawerHeader>
              {/*
                `pb-0` removes the drawer body's bottom padding so the action
                bar below MonitorForm's scrolling content reaches the lower edge.

                `pb-0` 移除抽屉内容的底部内边距，使 MonitorForm 滚动内容下方的
                操作栏到达抽屉底缘。
              */}
              <DrawerBody className="polaris-scroll-x flex min-h-0 flex-col pt-5 pb-0">
                <MonitorForm
                  /*
                    Keyed on the starting type: the form reads `initialType`
                    once, in a useState initialiser, so a type that arrives
                    after mount (the drawer opens first, then the effect runs)
                    would be ignored without a remount.

                    以初始类型为 key：表单仅在初始化时读取 initialType；从添加监控项
                    切换到添加 Agent 若不重新挂载，新初始类型会被忽略。
                  */
                  key={`${editing?.id ?? 'new'}:${newType ?? 'default'}`}
                  monitor={editing}
                  initialType={newType}
                  // From the overview already loaded; first paint uses registry defaults. / 使用已加载的概览；首次绘制用注册表默认值。
                  defaults={data?.defaults}
                  onSaved={async () => {
                    onClose();
                    setEditing(null);
                    await load();
                    toast.success(t('toast.saved'));
                  }}
                  onCancel={onClose}
                  onVocabChanged={loadGroups}
                />
              </DrawerBody>
            </>
          )}
        </DrawerContent>
      </Drawer>

      <MonitorQuickView
        monitor={quick}
        groupName={quick?.group_id ? groupNames[quick.group_id] : undefined}
        busy={quick ? busy === quick.id : false}
        onClose={() => setQuickId(null)}
        onEdit={() => {
          if (!quick) return;
          setQuickId(null);
          openEditor(quick);
        }}
        onToggle={() => {
          if (quick) void toggleActive(quick);
        }}
      />

      <Modal isOpen={pendingDelete !== null} onClose={() => setPendingDelete(null)} size="sm">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1 pb-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-danger/10 text-danger-600">
              <Trash2 size={17} />
            </span>
            <span className="mt-2 text-[15px]">{t('action.delete')}</span>
          </ModalHeader>
          <ModalBody className="gap-1.5">
            {/* Name first, consequence second. / 先显示名称，再说明后果。 */}
            <p className="text-[13.5px] font-medium">{pendingDelete?.name}</p>
            <p className="text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">{t('list.deleteHint')}</p>
          </ModalBody>
          <ModalFooter>
            <Button size="sm" variant="bordered" onPress={() => setPendingDelete(null)}>
              {t('action.cancel')}
            </Button>
            <Button size="sm" color="danger" onPress={confirmDelete}>
              {t('action.delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </AdminPage>
  );
}

/** Real table for screen-reader row and column navigation. / 使用真实表格，便于读屏按行列导航。 */
function MonitorTable({
  rows,
  busy,
  groupNames,
  selected,
  onToggleSelection,
  onToggleAll,
  onOpen,
  onEdit,
  onToggle,
  onTogglePublic,
  onDelete,
}: {
  rows: OverviewMonitor[];
  busy: string | null;
  groupNames: Record<string, string>;
  selected: Set<string>;
  onToggleSelection: (id: string) => void;
  onToggleAll: () => void;
  onOpen: (m: OverviewMonitor) => void;
  onEdit: (m: Monitor) => void;
  onToggle: (m: Monitor) => void;
  onTogglePublic: (m: Monitor) => void;
  onDelete: (m: Monitor) => void;
}) {
  const t = useTranslations('admin');
  const allSelected = rows.length > 0 && rows.every(m => selected.has(m.id));

  return (
    <table className="polaris-table text-[13px]">
      <thead className="sticky top-0 z-10">
        <tr>
          <th className="w-10 px-3"><Checkbox size="sm" aria-label={t('list.selectAllVisible')} isSelected={allSelected} isIndeterminate={!allSelected && rows.some(m => selected.has(m.id))} isDisabled={busy !== null} onValueChange={onToggleAll} /></th>
          <th className="w-full min-w-[17rem] pl-4">{t('col.monitor')}</th>
          <th className="text-right">{t('col.reading')}</th>
          <th className="hidden text-right sm:table-cell">{t('col.uptime')}</th>
          <th className="hidden xl:table-cell">{t('col.recent')}</th>
          <th className="pr-4 text-right">
            <span className="sr-only">{t('col.actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <LayoutGroup>
          <AnimatePresence initial={false}>
            {rows.map((m) => (
              <MonitorRow
                key={m.id}
                monitor={m}
                busy={busy === m.id || busy === 'visibility'}
                selected={selected.has(m.id)}
                selectionDisabled={busy !== null}
                onToggleSelection={() => onToggleSelection(m.id)}
                groupName={m.group_id ? groupNames[m.group_id] : undefined}
                onOpen={() => onOpen(m)}
                onEdit={() => onEdit(m)}
                onToggle={() => onToggle(m)}
                onTogglePublic={() => onTogglePublic(m)}
                onDelete={() => onDelete(m)}
              />
            ))}
          </AnimatePresence>
        </LayoutGroup>
      </tbody>
    </table>
  );
}

const FLASH_TONE: Record<Tone, string> = {
  up: 'rgb(16 185 129 / 0.10)',
  warn: 'rgb(245 158 11 / 0.13)',
  down: 'rgb(239 68 68 / 0.13)',
  pending: 'rgb(249 115 22 / 0.13)',
  idle: 'rgb(161 161 170 / 0.14)',
};

const STATUS_INK: Record<Tone, string> = {
  up: 'text-[var(--polaris-ink-2)]',
  warn: 'text-warning-700',
  down: 'text-danger-600',
  pending: 'text-orange-700 dark:text-orange-400',
  idle: 'text-[var(--polaris-ink-3)]',
};

/** An add-on's lifetime as a few words in the row's second line, toned only when it matters. / 在行的第二行简短显示附加项有效期，仅在需要时着色。 */
function AddonNote({ label, reading, icon }: { label: string; reading: AddonReading | undefined; icon: React.ReactNode }) {
  if (!reading || reading.ts === 0) return null;
  const tone = reading.st === 0 ? 'text-danger-600' : reading.st === 2 ? 'text-warning-700' : undefined;
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 [&>svg]:h-3 [&>svg]:w-3', tone)}>
      {icon}
      {label} {reading.days === null ? '—' : `${Math.round(reading.days)}d`}
    </span>
  );
}

function MonitorRow({
  monitor: m,
  busy,
  selected,
  selectionDisabled,
  onToggleSelection,
  groupName,
  onOpen,
  onEdit,
  onToggle,
  onTogglePublic,
  onDelete,
}: {
  monitor: OverviewMonitor;
  busy: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onToggleSelection: () => void;
  groupName?: string;
  onOpen: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onTogglePublic: () => void;
  onDelete: () => void;
}) {
  const present = useIsPresent();
  const t = useTranslations('admin');
  const ago = useTimeAgo();
  const paused = m.active === 0;
  const tone: Tone = paused ? 'idle' : toneForStatus(m.st);
  const reportedAt = m.type === 'push' ? m.push_last_received_at ?? 0 : m.checked_at;
  const latency = useMemo(() => ringLatency(m), [m]);
  const failing = !paused && (m.st === 0 || m.st === 4) && Boolean(m.msg);

  // A state change seen while the page is open washes the row in its new tone for a moment. / 页面打开期间观察到状态变化时，该行短暂显示新状态色。
  const previousTone = useRef(tone);
  const [flash, setFlash] = useState<Tone | null>(null);
  useEffect(() => {
    if (previousTone.current === tone) return;
    previousTone.current = tone;
    setFlash(tone);
    const id = window.setTimeout(() => setFlash(null), 2600);
    return () => window.clearTimeout(id);
  }, [tone]);

  // Three cases, not two: a paused monitor is deliberately not running, a
  // never-checked one has no reading yet, and only the third is a real status.
  // 状态分三种：暂停项是主动停止，从未检查项尚无读数，只有第三种才是真实状态。
  const statusLabel = paused
    ? t('status.paused')
    : m.st === null
      ? t('status.unknown')
      : m.st === 1
        ? t('status.up')
        : m.st === 4
          ? t('status.pending')
          : m.st === 2
            ? t('status.warn')
            : t('status.down');

  const where = m.type === 'push' ? t('list.pushInbound') : m.target.replace(/^https?:\/\//, '');
  const uptimeTone =
    !m.has_history ? 'text-[var(--polaris-ink-4)]' : m.uptime < 95 ? 'text-danger-600' : m.uptime < 99 ? 'text-warning-700' : 'text-[var(--polaris-ink)]';

  return (
    <motion.tr
      inert={!present}
      aria-hidden={!present || undefined}
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: paused ? 0.55 : 1 }}
      exit={{ opacity: 0 }}
      transition={{ layout: NAV_TRANSITION, opacity: FEEDBACK_TRANSITION }}
      style={
        {
          ...(flash ? { '--polaris-flash': FLASH_TONE[flash] } : {}),
        } as CSSProperties
      }
      className={clsx('group cursor-pointer', flash && 'polaris-flash-row')}
      onClick={(event) => {
        // The row opens the quick view; its own buttons and links keep their jobs. / 点击行打开快速详情；行内按钮和链接保留各自功能。
        if ((event.target as HTMLElement).closest('button, a, input, label, [role="checkbox"], [role="menu"]')) return;
        onOpen();
      }}
    >
      <td className="px-3"><Checkbox size="sm" aria-label={t('list.selectOne', { name: m.name })} isSelected={selected} isDisabled={selectionDisabled} onValueChange={onToggleSelection} classNames={{ base: 'm-0' }} /></td>
      <td className="max-w-[28rem] pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <MonitorGlyph type={m.type} target={m.target} monitorId={m.num_id} badge={paused ? undefined : tone} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <Tooltip
                delay={500}
                closeDelay={0}
                placement="top-start"
                content={
                  <div className="flex max-w-xs flex-col gap-1 py-1">
                    <span className="text-[12.5px] font-semibold">{m.name}</span>
                    <span className="font-mono text-[11.5px] break-all text-[var(--polaris-ink-3)]">
                      {TYPE_LABEL[m.type]} · {m.target || t('list.pushInbound')}
                    </span>
                    <span className="text-[12px] text-[var(--polaris-ink-3)]">
                      {m.type === 'push' ? `${t('quick.pushTimeout')} · ${m.interval_sec}s` : t('quick.everySec', { n: m.interval_sec })}
                      {groupName ? ` · ${groupName}` : ''}
                    </span>
                    {m.check_dns === 1 && m.dns ? (
                      <span className="text-[12px] text-[var(--polaris-ink-3)]">
                        DNS · {m.dns.msg || '—'}
                        {m.dns.records && m.dns.records.length > 0 ? (
                          <span className="block font-mono text-[11px] text-[var(--polaris-ink-4)]">
                            {m.dns.records.join(', ')}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                }
              >
                {m.is_public === 0 ? <button type="button" onClick={onOpen} className="min-w-0 truncate text-[13.5px] font-medium text-[var(--polaris-ink)] hover:underline" title={m.name}>{m.name}</button> : <Link
                    to={`/monitor/${m.num_id}`}
                    className="min-w-0 truncate text-[13.5px] font-medium text-[var(--polaris-ink)] hover:underline"
                    data-overflow-tooltip="off"
                    title={m.name}
                  >
                    {m.name}
                  </Link>}
              </Tooltip>
              {m.is_public === 0 ? <Tooltip content={t('list.private')}><span aria-label={t('list.private')} className="shrink-0 text-default-400"><LockKeyhole size={13} /></span></Tooltip> : null}
              {/* Tags as quiet chips: a dot in the tag's colour, the name in ink.
                  The name is a JSX child (escaped); the colour is one CSS value.
                  标签以低调徽章显示：圆点使用标签色，名称使用正文色；
                  名称作为 JSX 子节点转义，颜色仅作为一个 CSS 值。 */}
              {m.tags?.slice(0, 3).map((tag) => (
                <span
                  key={tagKey(tag)}
                  className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-[var(--polaris-line)] px-1.5 text-[11px] text-[var(--polaris-ink-2)]"
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </span>
              ))}
              {m.tags && m.tags.length > 3 ? (
                <span className="text-[11px] text-[var(--polaris-ink-4)]">+{m.tags.length - 3}</span>
              ) : null}
            </div>

            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
              <span className={clsx('shrink-0 font-medium', STATUS_INK[tone])}>{statusLabel}</span>
              <span className="text-[var(--polaris-ink-4)]">·</span>
              {failing ? (
                <span className={clsx('min-w-0 truncate', STATUS_INK[tone])} title={m.msg}>
                  {m.msg}
                </span>
              ) : (
                <>
                  <span className="shrink-0 font-mono text-[10.5px] tracking-wide text-[var(--polaris-ink-4)]">{TYPE_LABEL[m.type]}</span>
                  <span className="min-w-0 truncate" title={m.type === 'push' ? undefined : m.target}>
                    {where}
                  </span>
                  {m.check_ssl === 1 ? <AddonNote label="SSL" reading={m.ssl} icon={<ShieldCheck />} /> : null}
                  {m.check_domain === 1 ? <AddonNote label={t('insights.kindDomain')} reading={m.domain} icon={<CalendarClock />} /> : null}
                  {m.check_dns === 1 && m.dns && m.dns.ts > 0 && m.dns.st !== 1 ? (
                    <span className="shrink-0 text-warning-700">DNS ✕</span>
                  ) : null}
                  {m.source === 'agent' ? (
                    <span className="shrink-0 text-[var(--polaris-ink-4)]">
                      · {m.source_name ?? m.source_id ?? 'Agent'}
                      {m.source_available === false ? ` (${t('form.sourceUnavailableBadge')})` : ''}
                      {m.source_pending ? ` (${t('form.sourcePendingBadge')})` : ''}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </td>

      <td className="text-right whitespace-nowrap">
        <div className="flex items-center justify-end gap-3">
          {!paused && latency.filter((v) => v !== null).length > 1 ? (
            <SparkLine values={latency} height={22} className="hidden w-20 text-[var(--polaris-chart)] md:block" />
          ) : null}
          <div className="w-14 text-right">
            {paused || m.checked_at === 0 ? (
              <span className="text-[12px] text-[var(--polaris-ink-4)]">{paused ? '—' : t('list.neverChecked')}</span>
            ) : (
              <span className="polaris-num text-[13px] font-medium text-[var(--polaris-ink)]">
                {m.st === 0 && !m.v ? '—' : (readingLabel(m.v, m.st, m.type) ?? '—')}
              </span>
            )}
            {!paused && reportedAt > 0 ? (
              <span className="block text-[11px] text-[var(--polaris-ink-4)]" title={m.type === 'push' ? t('quick.lastPush') : undefined}>{ago(reportedAt)}</span>
            ) : null}
          </div>
        </div>
      </td>

      <td className="hidden text-right whitespace-nowrap sm:table-cell">
        <span className={clsx('polaris-num text-[13px] font-medium', uptimeTone)}>
          {m.has_history ? formatAvailability(m.uptime) : '—'}
        </span>
      </td>

      <td className="hidden w-[220px] min-w-[220px] xl:table-cell">
        <CheckRail ring={m.ring ?? []} emptyLabel={t('list.noHistory')} max={40} />
      </td>

      <td className="pr-4 text-right whitespace-nowrap">
        <div className="polaris-reveal flex items-center justify-end gap-0.5">
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="h-7 w-7 min-w-7 text-[var(--polaris-ink-3)]"
            aria-label={paused ? t('action.resume') : t('action.pause')}
            onPress={onToggle}
            isDisabled={busy}
          >
            {busy ? <Loader2 className="animate-spin" size={15} /> : paused ? <Play size={15} /> : <Pause size={15} />}
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="h-7 w-7 min-w-7 text-[var(--polaris-ink-3)]"
            aria-label={t('action.edit')}
            onPress={onEdit}
          >
            <Pencil size={15} />
          </Button>
          <Dropdown placement="bottom-end">
            <DropdownTrigger>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                className="h-7 w-7 min-w-7 text-[var(--polaris-ink-3)]"
                aria-label={t('col.actions')}
                isDisabled={busy}
              >
                <Ellipsis size={16} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label={t('col.actions')} variant="flat">
              <DropdownItem key="open" startContent={<Eye size={15} />} onPress={onOpen}>
                {t('quick.open')}
              </DropdownItem>
              <DropdownItem
                key="public"
                isDisabled={m.is_public === 0}
                startContent={<ArrowUpRight size={15} />}
                href={`/monitor/${m.num_id}`}
              >
                {t('quick.openPublic')}
              </DropdownItem>
              <DropdownItem
                key="visibility"
                startContent={m.is_public === 0 ? <Eye size={15} /> : <EyeOff size={15} />}
                isDisabled={busy}
                onPress={onTogglePublic}
              >
                {t(m.is_public === 0 ? 'action.showOnPublic' : 'action.hideFromPublic')}
              </DropdownItem>
              <DropdownItem
                key="delete"
                className="text-danger"
                color="danger"
                startContent={<Trash2 size={15} />}
                onPress={onDelete}
              >
                {t('action.delete')}
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </div>
      </td>
    </motion.tr>
  );
}
