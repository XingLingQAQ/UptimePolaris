import { loadTone, percentOf } from '@/lib/resource-metrics';
import { AnimatePresence, LayoutGroup, motion, useIsPresent } from 'framer-motion';
import { NAV_TRANSITION, FEEDBACK_TRANSITION } from '@/lib/motion';
import { Modal, Dropdown, Select } from '@/components/ui/MotionOverlays';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import {
  Button,
  Checkbox,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  SelectItem,
} from '@heroui/react';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowUpCircle,
  Eye,
  EyeOff,
  KeyRound,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCw,
  Search,
  SearchCheck,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { Meter } from '../../components/ui/MetricMeters';
import type { Tone } from '../../types/tone';
import { EmptyState } from '../components/ConsolePrimitives';
import { CountryFlag, countryOf, placeOf } from '../components/CountryFlag';
import { IconTile } from '../components/IconTile';
import { RackArt, SearchArt } from '../components/illustrations';
import { OsBadge } from '../components/OsBadge';
import { FillingPanel } from '../components/Panel';
import { AdminPage } from '../layout/AdminPage';
import { StatusPill } from '../monitors/MonitorIndicators';
import { AddAgentPanel } from './AddAgentPanel';
import { AgentCommandsDialog } from './AgentCommandsDialog';
import { AgentDetailDialog } from './AgentDetailDialog';
import { AgentEditDrawer } from './AgentEditDrawer';
import { AgentVersionPopover } from './AgentVersionPopover';
import { agentsApi, type AgentTag } from './api';
import { TaxonomyDelete, TaxonomyEditor, useAgentTaxonomy } from './Taxonomy';
import { FleetInsights, FleetOverview } from './FleetOverview';
import type { AgentCommandRecord, BatchCommandAction, FleetAgent, FleetSummary } from './types';

/** A percentage with one decimal, or an em dash. / 保留一位小数的百分比；无值时显示破折号。 */
function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

/** Coarsest useful "time ago"; under 90s uses seconds. / 最粗但仍有意义的时间单位；90 秒内用秒。 */
function formatAgo(
  seconds: number | null,
  t: ReturnType<typeof useTranslations<'admin.agents'>>,
): string {
  if (seconds === null) return t('never');
  if (seconds < 90) return t('agoSeconds', { n: Math.max(0, Math.round(seconds)) });
  if (seconds < 5400) return t('agoMinutes', { n: Math.round(seconds / 60) });
  if (seconds < 172800) return t('agoHours', { n: Math.round(seconds / 3600) });
  return t('agoDays', { n: Math.round(seconds / 86400) });
}

/** Whether the batch route will accept this machine, and why not when it will not. / 判断批量接口是否接受该机器，以及不可接受时的原因。 */
function batchEligibility(agent: FleetAgent): 'ok' | 'offline' | 'unsupported' | 'paused' {
  if (!agent.active) return 'paused';
  if (agent.online !== true) return 'offline';
  if (agent.capabilities?.includes('commands') !== true) return 'unsupported';
  return 'ok';
}

type BatchResultRow = { id: string; name: string; ok: boolean; error?: string };
type BatchResultState = { action: BatchCommandAction; rows: BatchResultRow[] };

/** 展示 Agent 清单与状态，协调筛选、批量命令和详情操作。 / Display the Agent fleet and status, coordinating filters, batch commands, and details. */
export function AgentsPage() {
  const t = useTranslations('admin.agents');
  const apiErrorMessage = useApiErrorMessage();
  const adminT = useTranslations('admin');
  const taxonomy = useAgentTaxonomy();
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [tagEditor, setTagEditor] = useState<AgentTag | 'new' | null>(null);
  const [tagDelete, setTagDelete] = useState<AgentTag | null>(null);
  const [agents, setAgents] = useState<FleetAgent[] | null>(null);
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<FleetAgent | null>(null);
  const [commandAgentId, setCommandAgentId] = useState<string | null>(null);
  const [editing, setEditing] = useState<FleetAgent | null>(null);
  const [batchRunning, setBatchRunning] = useState<BatchCommandAction | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResultState | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<FleetAgent[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [inProgress, setInProgress] = useState<Record<string, number>>({});
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const [params, setParams] = useSearchParams();

  const load = async () => {
    try {
      const fleet = await agentsApi.listAgents();
      setAgents(fleet.agents);
      setSummary(fleet.summary);
      setError('');
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Deep links `?agent=` and `?enroll=1`, consumed once. / 深链接 `?agent=` 和 `?enroll=1`，读取一次后移除。 */
  useEffect(() => {
    const focus = params.get('agent');
    const enroll = params.get('enroll');
    if (!focus && !enroll) return;
    if (focus && agents === null) return;
    if (focus) {
      const match = agents?.find((agent) => agent.id === focus);
      if (match) setDetail(match);
    }
    if (enroll) setAddOpen(true);
    const next = new URLSearchParams(params);
    next.delete('agent');
    next.delete('enroll');
    setParams(next, { replace: true });
  }, [agents, params, setParams, navigate]);

  /** Client-side filter; the whole fleet is already in one response. / 前端筛选；整个机器列表已在一次响应中。 */
  const rows = useMemo(() => {
    if (!agents) return [];
    const needle = query.trim().toLowerCase();
    return agents.filter((agent) => {
      if (needle) {
        const haystack = [agent.name, agent.os, agent.public_ip, agent.isp, agent.region]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (taxonomy.enabled && groupFilter && (groupFilter === '__ungrouped' ? agent.group_id !== null : agent.group_id !== groupFilter)) return false;
      if (taxonomy.enabled && tagFilter && !(agent.tags ?? []).some(tag => tag.id === tagFilter)) return false;
      if (stateFilter !== null) {
        if (stateFilter === 'online' && !(agent.active && agent.online === true)) return false;
        if (stateFilter === 'offline' && !(agent.active && agent.online === false)) return false;
        if (stateFilter === 'never' && agent.online !== null) return false;
        if (stateFilter === 'behind' && agent.version_state !== 'behind') return false;
        if (stateFilter === 'current' && agent.version_state !== 'current') return false;
        if (stateFilter === 'unknown' && agent.version_state !== 'unknown' && agent.version_state !== 'not_reported') return false;
        if (stateFilter === 'paused' && agent.active) return false;
      }
      return true;
    });
  }, [agents, query, stateFilter, taxonomy.enabled, groupFilter, tagFilter]);


  const allSelected = rows.length > 0 && rows.every((agent) => selected.has(agent.id));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map((agent) => agent.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Keep the table's in-progress markers in step with the dialog's command list. / 使表格中的进行中标记与对话框命令列表同步。 */
  const noteCommands = useCallback((id: string, commands: AgentCommandRecord[]) => {
    setClock(Math.floor(Date.now() / 1000));
    const pending = commands.find(
      (row) =>
        (row.state === 'pending' || row.state === 'leased') &&
        (row.action === 'check_update' || row.action === 'upgrade'),
    );
    setInProgress((prev) => {
      if (!pending) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if (prev[id] === pending.queued_at) return prev;
      return { ...prev, [id]: pending.queued_at };
    });
  }, []);

  // Markers are cleared by timestamp, not by another request. / 按时间戳清除标记，无需额外请求。
  useEffect(() => {
    if (Object.keys(inProgress).length === 0) return;
    const timer = window.setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setClock(now);
      setInProgress((prev) => {
        const kept = Object.entries(prev).filter(([, ts]) => now - ts < 300);
        return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [inProgress]);

  const selectedAgents = useMemo(
    () => (agents ?? []).filter((agent) => selected.has(agent.id)),
    [agents, selected],
  );

  const setVisibility = async (ids: string[], isPublic: boolean) => {
    if (!taxonomy.enabled || busy !== null) return;
    setBusy(ids.length === 1 ? ids[0] : 'visibility');
    try {
      await agentsApi.setVisibility(ids, isPublic);
      await load();
      toast.success(adminT('groups.saved'));
    } catch (reason) { toast.error(apiErrorMessage(reason)); }
    finally { setBusy(null); }
  };

  const hasUpgrade = selectedAgents.some((agent) => agent.version_state === 'behind');
  const upgradeTargets = selectedAgents.filter((agent) => agent.version_state === 'behind' && batchEligibility(agent) === 'ok');
  const upgradeExcluded = selectedAgents.filter((agent) => agent.version_state !== 'behind' || batchEligibility(agent) !== 'ok');

  const batchError = (code: string | undefined): string => {
    if (!code) return t('commandFailed');
    return apiErrorMessage(code);
  };

  const runBatch = async (action: BatchCommandAction, ids: string[] = [...selected]) => {
    if (ids.length === 0) return;
    const names = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));
    setBatchRunning(action);
    try {
      const response = await agentsApi.batchCommands(ids, action);
      const resultRows: BatchResultRow[] = response.results.map((row) => ({
        id: row.id,
        name: names.get(row.id) ?? row.id,
        ok: row.ok,
        error: row.error,
      }));
      setBatchResult({ action, rows: resultRows });

      const okRows = resultRows.filter((row) => row.ok);
      const failed = resultRows.length - okRows.length;
      if (resultRows.length === 0) {
        toast.error(t('commandFailed'));
      } else if (failed === 0) {
        toast.success(t('batchQueued', { n: okRows.length }));
      } else {
        toast.warning(t('batchPartial', { failed, total: resultRows.length }));
      }

      if (action === 'check_update' || action === 'upgrade') {
        const now = Math.floor(Date.now() / 1000);
        setInProgress((prev) => {
          const next = { ...prev };
          for (const row of okRows) next[row.id] = now;
          return next;
        });
      }

      setSelected(new Set());
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setBatchRunning(null);
    }
  };

  const requestDelete = (targets: FleetAgent[]) => {
    setDeleteErrors({});
    setDeleteTargets([...targets]);
  };
  const confirmDelete = async () => {
    if (deletingRef.current || !deleteTargets?.length) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteErrors({});
    const removed = new Set<string>();
    const errors: Record<string, string> = {};
    for (let offset = 0; offset < deleteTargets.length; offset += 4) {
      const chunk = deleteTargets.slice(offset, offset + 4);
      const results = await Promise.allSettled(chunk.map((agent) => agentsApi.removeAgent(agent.id)));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') removed.add(chunk[index].id);
        else errors[chunk[index].id] = apiErrorMessage(result.reason);
      });
    }
    setSelected((previous) => new Set([...previous].filter((id) => !removed.has(id))));
    setDeleteTargets(deleteTargets.some((agent) => !removed.has(agent.id)) ? deleteTargets.filter((agent) => !removed.has(agent.id)) : null);
    setDeleteErrors(errors);
    setDeleting(false);
    deletingRef.current = false;
    if (removed.size) toast.success(t('batchRemovedToast', { n: removed.size }));
    await load();
  };

  return (
    <AdminPage title={t('title')} description={t('description')}>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {/*
          Summary strip. Six tiles, each with the shape that answers its own
          question rather than six copies of the same number template.

          概览包含六个指标卡，各自使用适合回答对应问题的图形，而非六个相同数字模板。
        */}
        {/*
          Only when there is a fleet to summarise. With no agents enrolled the
          figures read `0 / 0`, and six tiles of zeros above an empty state say
          "the dashboard is broken" rather than "nothing is enrolled yet" - the
          empty state below already says the latter, in words.

          仅在有 Agent 时显示概览；空列表上方若出现六个零值卡和 `0 / 0`，
          会更像仪表板故障，而不是尚未添加 Agent；下方空状态已经用文字说明。
        */}
        {summary && agents && agents.length > 0 ? (
          <FleetOverview
            agents={agents}
            summary={summary}
            now={clock}
            stateFilter={stateFilter}
            onFilter={(bucket) => setStateFilter((prev) => (prev === bucket ? null : bucket))}
          />
        ) : null}

        {agents && agents.length > 0 ? <FleetInsights agents={agents} onOpen={setDetail} /> : null}

        {addOpen ? (
          <AddAgentPanel
            open={addOpen}
            onClose={() => setAddOpen(false)}
            onCreated={() => load()}
          />
        ) : null}

        {taxonomy.error ? <p role="alert" className="text-small text-danger">{apiErrorMessage(taxonomy.error)}</p> : null}
        {taxonomy.enabled && tagsOpen ? <div className="polaris-card flex flex-col gap-3 p-4"><div className="flex items-center gap-2"><h2 className="flex-1 text-small font-semibold">{adminT('agentTaxonomy.tags')}</h2><Button size="sm" color="primary" onPress={() => setTagEditor('new')}>{adminT('agentTaxonomy.addTag')}</Button><Button size="sm" variant="light" onPress={() => setTagsOpen(false)}>{t('close')}</Button></div>{taxonomy.tags.map(tag => <div key={tag.id} className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: tag.color }} /><span className="flex-1 text-small">{tag.name} · {adminT('agentTaxonomy.members', { count: tag.count })}</span><Button size="sm" variant="light" onPress={() => setTagEditor(tag)}>{adminT('action.edit')}</Button><Button size="sm" variant="light" color="danger" onPress={() => setTagDelete(tag)}>{adminT('action.delete')}</Button></div>)}</div> : null}
        {error ? (
          <div className="flex items-center gap-3 rounded-xl border border-danger/20 bg-danger/[0.06] px-4 py-2.5 text-small text-danger-600">
            <AlertTriangle size={16} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={error}>
              {error}
            </span>
            <Button size="sm" variant="flat" color="danger" onPress={() => void load()}>
              {adminT('action.retry')}
            </Button>
          </div>
        ) : null}

        {/*
          Bulk action bar.

          Sticky and outside the panel: the panel clips its overflow, which would
          make a sticky child scroll away with the table. It states its scope
          first, because a bulk control that does not say how many machines it
          touches is how the wrong machines get acted on.

          批量操作栏固定在面板外：面板会裁剪溢出，若作为面板内的 sticky 子元素，
          操作栏会随表格滚走。先显示操作范围，避免用户误操作未意识到的机器数量。
        */}
        {selected.size > 0 ? (
          <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--polaris-line-strong)] bg-[var(--polaris-card)]/95 px-3 py-2 shadow-[var(--polaris-shadow-float)] backdrop-blur-md lg:top-3">
            <IconTile icon={<ListChecks />} hue="primary" size="sm" />
            <span className="text-small font-semibold">{t('selectedCount', { n: selected.size })}</span>
            <span className="mx-0.5 hidden h-5 w-px bg-[var(--polaris-line-strong)] sm:block" />
            {taxonomy.enabled ? <Dropdown><DropdownTrigger><Button size="sm" variant="flat" startContent={<Eye size={15} />} isDisabled={batchRunning !== null || busy !== null}>{adminT('groups.visibility')}</Button></DropdownTrigger><DropdownMenu aria-label={adminT('groups.visibility')}><DropdownItem key="public" startContent={<Eye size={15} />} onPress={() => void setVisibility([...selected], true)}>{adminT('action.showOnPublic')}</DropdownItem><DropdownItem key="private" startContent={<EyeOff size={15} />} onPress={() => void setVisibility([...selected], false)}>{adminT('action.hideFromPublic')}</DropdownItem></DropdownMenu></Dropdown> : null}
            <Button
              size="sm"
              variant="flat"
              startContent={<RotateCw size={15} />}
              isDisabled={batchRunning !== null || busy !== null}
              isLoading={batchRunning === 're_report'}
              onPress={() => void runBatch('re_report')}
            >
              {t('commandReReport')}
            </Button>
            <Button
              size="sm"
              variant="flat"
              startContent={<SearchCheck size={15} />}
              isDisabled={batchRunning !== null || busy !== null}
              isLoading={batchRunning === 'check_update'}
              onPress={() => void runBatch('check_update')}
            >
              {t('commandCheckUpdate')}
            </Button>
            {hasUpgrade ? <Button
              size="sm"
              color="warning"
              variant="flat"
              startContent={<ArrowUpCircle size={15} />}
              isDisabled={batchRunning !== null || busy !== null}
              onPress={() => setUpgradeOpen(true)}
            >
              {t('commandUpgrade')}
            </Button> : null}
            <Button size="sm" color="danger" variant="flat" startContent={<Trash2 size={15} />} isDisabled={batchRunning !== null || busy !== null || deleting} onPress={() => requestDelete(selectedAgents)}>{t('batchRemove')}</Button>
            <Button
              size="sm"
              variant="light"
              className="ml-auto"
              isDisabled={batchRunning !== null}
              onPress={() => setSelected(new Set())}
            >
              {t('batchClear')}
            </Button>
          </div>
        ) : null}

        <FillingPanel padded={false} className="min-h-[20rem]">
          {/* Toolbar: filters left, the page's primary action right - the shape
              every list page in this console already uses.
              工具栏左侧为筛选、右侧为页面主要操作，与控制台其他列表页一致。 */}
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--polaris-line)] p-3">
            <Input
              size="sm"
              className="w-full text-tiny sm:w-64 [&_input]:text-tiny"
              placeholder={t('search')}
              value={query}
              onValueChange={setQuery}
              startContent={<Search className="shrink-0 text-default-400" size={15} />}
              endContent={
                query ? (
                  <button
                    type="button"
                    aria-label={adminT('action.cancel')}
                    onClick={() => setQuery('')}
                    className="text-default-400 transition-colors hover:text-foreground"
                  >
                    <X size={15} />
                  </button>
                ) : null
              }
              isClearable={false}
            />

            <Select
              items={[
                { key: 'online', label: t('stateOnline') },
                { key: 'offline', label: t('stateOffline') },
                { key: 'never', label: t('stateNever') },
                { key: 'current', label: t('versionCurrent') },
                { key: 'behind', label: t('stateBehind') },
                { key: 'unknown', label: t('versionUnknown') },
                { key: 'paused', label: t('statePaused') },
              ]}
              size="sm"
              className="w-36 text-tiny"
              aria-label={t('filterState')}
              placeholder={t('filterState')}
              selectedKeys={stateFilter ? [stateFilter] : []}
              onSelectionChange={(keys) => {
                const key = [...keys][0];
                setStateFilter(key === undefined ? null : String(key));
              }}
            >
              {(option) => <SelectItem key={option.key} textValue={option.label}>{option.label}</SelectItem>}
            </Select>

            {taxonomy.enabled ? <>
              <Select size="sm" className="w-40" aria-label={adminT('agentTaxonomy.group')} placeholder={adminT('agentTaxonomy.group')} selectedKeys={groupFilter ? [groupFilter] : []} onSelectionChange={keys => setGroupFilter([...keys][0] ? String([...keys][0]) : null)}>
                {[{ id: '__ungrouped', name: adminT('agentTaxonomy.ungrouped') }, ...taxonomy.groups].map(group => <SelectItem key={group.id} textValue={group.name}>{group.name}</SelectItem>)}
              </Select>
              <Select size="sm" className="w-40" aria-label={adminT('agentTaxonomy.tags')} placeholder={adminT('agentTaxonomy.tags')} selectedKeys={tagFilter ? [tagFilter] : []} onSelectionChange={keys => setTagFilter([...keys][0] ? String([...keys][0]) : null)}>
                {taxonomy.tags.map(tag => <SelectItem key={tag.id} textValue={tag.name}>{tag.name}</SelectItem>)}
              </Select>
              <Button size="sm" variant="flat" onPress={() => setTagsOpen(value => !value)}>{adminT('agentTaxonomy.manageTags')}</Button>
              <Button size="sm" variant="flat" onPress={() => setGroupEditorOpen(true)}>{adminT('agentTaxonomy.addGroup')}</Button>
            </> : null}

            {(query || stateFilter || groupFilter || tagFilter) ? (
              <Button
                size="sm"
                variant="light"
                onPress={() => {
                  setQuery('');
                  setStateFilter(null);
                  setGroupFilter(null);
                  setTagFilter(null);
                }}
              >
                {t('clearFilters')}
              </Button>
            ) : null}

            <div className="ml-auto flex items-center gap-2">
              <Button
                isIconOnly
                size="sm"
                variant="light"
                aria-label={t('refresh')}
                onPress={() => void load()}
              >
                <RotateCw size={16} />
              </Button>
              <Button color="primary" size="sm" startContent={<Plus size={16} />} onPress={() => setAddOpen(true)}>
                {t('enroll')}
              </Button>
            </div>
          </div>

          {batchResult ? (
            <div className="border-b border-[var(--polaris-line)] bg-[var(--polaris-well)] px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-small font-medium">{t('batchResults')}</span>
                <span className="text-tiny text-default-500">{t(`command_${batchResult.action}`)}</span>
                <span className="text-tiny text-default-400">·</span>
                <span className="text-tiny text-default-500">
                  {t('batchResultSummary', {
                    ok: batchResult.rows.filter((row) => row.ok).length,
                    failed: batchResult.rows.filter((row) => !row.ok).length,
                  })}
                </span>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  className="ml-auto"
                  aria-label={t('close')}
                  onPress={() => setBatchResult(null)}
                >
                  <X size={14} />
                </Button>
              </div>
              <ul className="polaris-divide mt-1 max-h-40 overflow-y-auto">
                {batchResult.rows.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                    <span className="min-w-0 truncate text-small">{row.name}</span>
                    <StatusPill
                      className="ml-auto shrink-0"
                      tone={row.ok ? 'up' : 'down'}
                      label={row.ok ? t('commandQueued') : t('commandFailed')}
                    />
                    {!row.ok ? (
                      <span className="w-full truncate text-tiny text-default-400" title={batchError(row.error)}>
                        {batchError(row.error)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {agents === null && error ? null : agents === null ? (
            <p className="flex items-center justify-center gap-2 py-12 text-small text-default-500">
              <Loader2 size={16} className="animate-spin text-default-400" />
              {t('loading')}
            </p>
          ) : rows.length === 0 ? (
            /*
              Two different empties, said differently.

              "Nothing enrolled" is an invitation to act; "nothing matched" means
              the filters are hiding rows, and telling the operator to enroll when
              they have forty agents and a typo in the search box is misleading.

              两种空状态使用不同文案：“没有 Agent”提示添加，
              “无匹配结果”表示筛选隐藏了数据；有 40 个 Agent 但搜索输错时提示添加会误导用户。
            */
            agents.length === 0 ? (
              /* `flex-1 justify-center` fills the panel so the footer strip
                 stays at the card's bottom edge instead of riding up under the
                 empty state - the same reason the table's own wrapper is
                 `flex-1`.
                 `flex-1 justify-center` 填满面板，让底部栏保持在卡片底缘，
                 而不是紧贴空状态；表格包装器使用 `flex-1` 也是同样原因。 */
              <EmptyState
                art={<RackArt />}
                title={t('emptyTitle')}
                hint={t('emptyHint')}
                className="flex-1 justify-center"
                action={
                  <Button color="primary" size="sm" startContent={<KeyRound size={15} />} onPress={() => setAddOpen(true)}>
                    {t('enroll')}
                  </Button>
                }
              />
            ) : (
              <EmptyState art={<SearchArt />} title={t('noMatch')} className="flex-1 justify-center" />
            )
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse text-small">
                <thead className="sticky top-0 z-10 bg-[var(--polaris-well)]">
                  <tr className="border-b border-[var(--polaris-line)] text-tiny text-default-500">
                    <th className="w-10 px-3 py-2.5">
                      <Checkbox
                        size="sm"
                        aria-label={t('selectAll')}
                        isSelected={allSelected}
                        isIndeterminate={!allSelected && rows.some((agent) => selected.has(agent.id))}
                        onChange={toggleAll}
                      />
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">{t('colName')}</th>
                    <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">{t('colState')}</th>
                    <th className="hidden px-3 py-2.5 text-left font-medium whitespace-nowrap md:table-cell">
                      {t('colVersion')}
                    </th>
                    <th className="hidden w-28 px-3 py-2.5 text-left font-medium whitespace-nowrap xl:table-cell">
                      {t('colCpu')}
                    </th>
                    <th className="hidden w-28 px-3 py-2.5 text-left font-medium whitespace-nowrap xl:table-cell">
                      {t('colMemory')}
                    </th>
                    <th className="hidden w-28 px-3 py-2.5 text-left font-medium whitespace-nowrap xl:table-cell">
                      {t('colDisk')}
                    </th>
                    <th className="hidden px-3 py-2.5 text-left font-medium whitespace-nowrap lg:table-cell">
                      {t('colReport')}
                    </th>
                    {/*
                      Probe load: how many monitors would go dark if this host
                      did. Narrow and hidden below lg because it is triage
                      information, not something every row is scanned for.

                      探测负载表示主机故障时有多少监控项受影响；它用于故障分诊，
                      不需要逐行浏览，因此窄列且在 lg 以下隐藏。
                    */}
                    <th className="hidden px-3 py-2.5 text-left font-medium whitespace-nowrap lg:table-cell">
                      {t('colProbes')}
                    </th>
                    <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">{t('colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  <LayoutGroup>
                    <AnimatePresence initial={false}>
                      {rows.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          taxonomyLabel={taxonomy.enabled ? [taxonomy.groups.find(group => group.id === agent.group_id)?.name, ...(agent.tags ?? []).map(tag => tag.name)].filter(Boolean).join(' · ') : ''}
                          visibilityEnabled={taxonomy.enabled}
                          onVisibility={() => void setVisibility([agent.id], agent.is_public !== 1)}
                          t={t}
                          selected={selected.has(agent.id)}
                          onToggle={() => toggleOne(agent.id)}
                          busy={busy === agent.id}
                          updating={inProgress[agent.id] !== undefined && clock - inProgress[agent.id] < 300}
                          onEdit={() => setEditing(agent)}
                          latestVersion={summary?.latestVersion ?? null}
                          onCommandsLoaded={noteCommands}
                          onUpdated={() => void load()}
                          onOpenDetail={() => setDetail(agent)}
                          onOpenCommands={() => setCommandAgentId(agent.id)}
                          onRemove={() => requestDelete([agent])}
                        />
                      ))}
                    </AnimatePresence>
                  </LayoutGroup>
                </tbody>
              </table>
            </div>
          )}

          {/*
            Footer strip.

            With the table filling the column, its last row can sit anywhere in
            the viewport, so a count pinned here says what the visible rows are
            a subset of. It also closes the card: a bordered panel that ends in
            bare table rows reads as clipped.

            表格填满列时，末行可能位于视口任何位置；固定底部计数说明可见行只是
            总数的子集，同时封住带框卡片，避免以裸表格行结尾显得被裁切。
          */}
          <div className="flex shrink-0 items-center gap-3 border-t border-[var(--polaris-line)] bg-[var(--polaris-well)] px-4 py-2 text-tiny text-default-500">
            {/*
              Only when there is something to count. With no agents enrolled the
              strip read "Showing 0 of 0" under an empty state that already says
              "No agents yet" - a count of nothing, repeated.

              仅在有数据可计数时显示；空状态已经写明“暂无 Agent”，
              再显示“显示 0 / 0”只是重复。
            */}
            {agents && agents.length > 0 ? (
              <span className="tabular-nums">{t('footShown', { shown: rows.length, total: agents.length })}</span>
            ) : null}
            {selected.size > 0 ? (
              <span className="text-primary">{t('footSelected', { n: selected.size })}</span>
            ) : null}
            <span className="ml-auto font-mono text-[11px] tabular-nums">
              {summary?.latestVersion ? `${t('fieldVersion')} v${summary.latestVersion}` : ''}
            </span>
          </div>
        </FillingPanel>
      </div>

      <AgentDetailDialog agent={detail} onClose={() => setDetail(null)} onEdit={(agent) => { setDetail(null); setEditing(agent); }} />
      {groupEditorOpen ? <TaxonomyEditor kind="groups" item={null} onClose={() => setGroupEditorOpen(false)} onSaved={taxonomy.load} /> : null}
      {tagEditor ? <TaxonomyEditor kind="tags" item={tagEditor === 'new' ? null : tagEditor} onClose={() => setTagEditor(null)} onSaved={async () => { await taxonomy.load(); await load(); }} /> : null}
      {tagDelete ? <TaxonomyDelete kind="tags" item={tagDelete} onClose={() => setTagDelete(null)} onDeleted={async () => { await taxonomy.load(); await load(); }} /> : null}
      {agents?.filter(agent => agent.id === commandAgentId).map(agent => <AgentCommandsDialog key={agent.id} agent={agent} onClose={() => setCommandAgentId(null)} onCommandsLoaded={noteCommands} />)}
      {editing ? <AgentEditDrawer key={editing.id} agent={editing} onClose={() => setEditing(null)} onUpdated={() => void load()} /> : null}

      <Modal isOpen={deleteTargets !== null} onClose={() => !deleting && setDeleteTargets(null)} isDismissable={!deleting} isKeyboardDismissDisabled={deleting} size="md" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>{t('batchRemoveTitle', { n: deleteTargets?.length ?? 0 })}</ModalHeader>
          <ModalBody>
            <p className="text-small text-default-500">{t('batchRemoveHint')}</p>
            <ul className="polaris-well polaris-divide max-h-72 overflow-y-auto">
              {deleteTargets?.map((agent) => <li key={agent.id} className="px-3 py-2.5"><p className="break-words text-small font-medium">{agent.name}</p>{deleteErrors[agent.id] ? <p role="alert" className="mt-1 text-tiny text-danger">{deleteErrors[agent.id]}</p> : null}</li>)}
            </ul>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" autoFocus isDisabled={deleting} onPress={() => setDeleteTargets(null)}>{adminT('action.cancel')}</Button>
            <Button color="danger" isLoading={deleting} onPress={() => void confirmDelete()}>{adminT('action.delete')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={upgradeOpen} onClose={() => setUpgradeOpen(false)} size="md" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>{t('batchUpgradeTitle')}</ModalHeader>
          <ModalBody className="gap-4">
            <p className="text-small text-default-500">{t('batchUpgradeHint')}</p>

            <div>
              <p className="mb-1.5 text-tiny text-default-500">
                {t('batchUpgradeAffected', { n: upgradeTargets.length })}
              </p>
              <ul className="max-h-40 overflow-y-auto rounded-medium border border-divider divide-y divide-divider/60">
                {upgradeTargets.length === 0 ? (
                  <li className="px-3 py-2 text-tiny text-default-400">{t('batchUpgradeNone')}</li>
                ) : (
                  upgradeTargets.map((agent) => (
                    <li key={agent.id} className="truncate px-3 py-1.5 text-small">
                      {agent.name}
                    </li>
                  ))
                )}
              </ul>
            </div>

            {upgradeExcluded.length > 0 ? (
              <div>
                <p className="mb-1.5 text-tiny text-default-500">
                  {t('batchUpgradeExcluded', { n: upgradeExcluded.length })}
                </p>
                <ul className="max-h-40 overflow-y-auto rounded-medium border border-divider divide-y divide-divider/60">
                  {upgradeExcluded.map((agent) => {
                    const reason = batchEligibility(agent);
                    return (
                      <li key={agent.id} className="flex items-center gap-2 px-3 py-1.5">
                        <span className="min-w-0 truncate text-small text-default-400">{agent.name}</span>
                        <span className="ml-auto shrink-0 text-tiny text-warning">
                          {t(
                            agent.version_state !== 'behind' ? (agent.version_state === 'current' ? 'versionCurrent' : 'versionUnknown') : reason === 'paused'
                              ? 'batchExcludePaused'
                              : reason === 'unsupported'
                                ? 'batchExcludeUnsupported'
                                : 'batchExcludeOffline',
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" autoFocus onPress={() => setUpgradeOpen(false)}>
              {adminT('action.cancel')}
            </Button>
            <Button
              color="warning"
              isLoading={batchRunning === 'upgrade'}
              isDisabled={upgradeTargets.length === 0 || batchRunning !== null}
              onPress={() => {
                const ids = upgradeTargets.map((agent) => agent.id);
                setUpgradeOpen(false);
                void runBatch('upgrade', ids);
              }}
            >
              {t('commandUpgrade')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </AdminPage>
  );
}

function AgentRow({
  visibilityEnabled,
  onVisibility,
  taxonomyLabel,
  agent,
  t,
  selected,
  onToggle,
  busy,
  updating,
  onEdit,
  latestVersion,
  onCommandsLoaded,
  onUpdated,
  onOpenDetail,
  onOpenCommands,
  onRemove,
}: {
  visibilityEnabled: boolean;
  onVisibility: () => void;
  agent: FleetAgent;
  taxonomyLabel: string;
  /**
   * Scoped translator, passed down rather than re-created.
   *
   * Typed as the intersection use-intl returns — a callable with message-key
   * helpers. A bare `(key) => string` rejects the real translator because the
   * library type carries the namespace and the rich/plain overloads.
   * 类型必须保留 use-intl 的调用签名和 helper，不能用裸函数类型。
   */
  t: ReturnType<typeof useTranslations<'admin.agents'>>;
  selected: boolean;
  onToggle: () => void;
  busy: boolean;
  updating: boolean;
  onEdit: () => void;
  latestVersion: string | null;
  onCommandsLoaded: (id: string, commands: AgentCommandRecord[]) => void;
  onUpdated: () => void;
  onOpenDetail: () => void;
  onOpenCommands: () => void;
  onRemove: () => void;
}) {
  const present = useIsPresent();
  const adminT = useTranslations('admin');
  /*
    Liveness, with "never reported" as its own state.

    A fresh enrollment has not sent a frame yet; showing that as offline would
    send an operator looking for a fault in a machine that is still installing.

    “从未上报”是独立在线状态：新注册的 Agent 可能还在安装，尚未发送首帧；
    将其显示为离线会误导操作人员排查尚不存在的故障。
  */
  const state: 'online' | 'offline' | 'never' | 'paused' = !agent.active
    ? 'paused'
    : agent.online === true
      ? 'online'
      : agent.online === false
        ? 'offline'
        : 'never';

  const stateTone: Tone = state === 'online' ? 'up' : state === 'offline' ? 'down' : 'idle';
  const stateLabel = t(
    state === 'online' ? 'stateOnline' : state === 'offline' ? 'stateOffline' : state === 'never' ? 'stateNever' : 'statePaused',
  );

  const memPercent = percentOf(agent.mem_used, agent.mem_total);
  const diskPercent = percentOf(agent.disk_used, agent.disk_total);
  const country = countryOf(agent.region);
  const place = placeOf(agent.region);

  return (
    <motion.tr
      inert={!present}
      aria-hidden={!present || undefined}
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ layout: NAV_TRANSITION, opacity: FEEDBACK_TRANSITION }}
      className={clsx(
        'group border-b border-[var(--polaris-line-soft)] transition-colors last:border-0 hover:bg-primary/[0.025]',
        selected && 'bg-primary/[0.04]',
        !agent.active && 'text-default-400',
      )}
    >
      <td className="px-3 py-3">
        <Checkbox
          size="sm"
          aria-label={t('selectOne', { name: agent.name })}
          isSelected={selected}
          onChange={onToggle}
          classNames={{ base: 'm-0' }}
        />
      </td>

      <td className="max-w-[20rem] px-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
            <OsBadge os={agent.os} />
            <div className="flex min-w-0 flex-col">
              <button
                type="button"
                onClick={onOpenDetail}
                className="truncate text-left font-medium transition-colors hover:text-primary"
              >
                {agent.name}
              </button>
              {/* The secondary line carries what identifies the host: where it
                  is, and its address. It is what an operator matches a name
                  against when the name is wrong.
                  第二行显示位置和地址等主机标识，名称有误时可据此核对。 */}
              <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-default-400">
                {agent.region ? <CountryFlag code={country} size={13} /> : null}
                <span className="truncate">
                  {[place, agent.public_ip ?? agent.public_ipv6, agent.region ? null : agent.os]
                    .filter(Boolean)
                    .join(' · ') || agent.isp || '—'}
                </span>
              </span>
              {taxonomyLabel ? <span className="truncate text-tiny text-default-500">{taxonomyLabel}</span> : null}
              {visibilityEnabled && agent.is_public !== 1 ? <span className="flex items-center gap-1 text-tiny text-default-500"><EyeOff size={12} />{adminT('list.private')}</span> : null}
              <div className="mt-1 md:hidden">
                <AgentVersionPopover agent={agent} latestVersion={latestVersion} onCommandsLoaded={onCommandsLoaded} onUpdated={onUpdated} />
              </div>
            </div>
          </div>
      </td>

      <td className="px-3 py-3 whitespace-nowrap">
        <StatusPill tone={stateTone} label={stateLabel} pulse={state === 'offline'} />
        {updating ? (
          <span className="mt-1 flex items-center gap-1 text-[11px] text-primary">
            <Loader2 size={10} className="animate-spin" />
            {t('updateInProgress')}
          </span>
        ) : null}
      </td>

      <td className="hidden px-3 py-3 whitespace-nowrap md:table-cell">
        <AgentVersionPopover agent={agent} latestVersion={latestVersion} onCommandsLoaded={onCommandsLoaded} onUpdated={onUpdated} />
      </td>

      {[agent.cpu_usage, memPercent, diskPercent].map((value, index) => (
        <td key={index} className="hidden w-28 px-3 py-3 xl:table-cell">
          {value === null || !Number.isFinite(value) ? (
            <span className="text-default-400">—</span>
          ) : (
            <span className="flex flex-col gap-1">
              <span className="text-tiny font-semibold tabular-nums">{formatPercent(value)}</span>
              <Meter value={value} tone={loadTone(value) === 'up' ? 'primary' : loadTone(value)} />
            </span>
          )}
        </td>
      ))}

      <td className="hidden px-3 py-3 whitespace-nowrap text-tiny text-default-500 lg:table-cell">
        <span className="flex items-center gap-1.5">
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              state === 'online' ? 'polaris-live bg-success' : state === 'offline' ? 'bg-danger' : 'bg-default-300',
            )}
          />
          {formatAgo(agent.stale_for_sec, t)}
        </span>
      </td>

      <td className="hidden px-3 py-3 whitespace-nowrap text-tiny text-default-500 lg:table-cell">
        {agent.probe_target_count > 0 ? (
          <span className="tabular-nums">{agent.probe_target_count}</span>
        ) : (
          <span className="text-default-400">—</span>
        )}
      </td>

      <td className="px-3 py-3">
        <div className="flex items-center justify-end gap-0.5">
          <Button isIconOnly size="sm" variant="light" aria-label={t('viewDetail')} onPress={onOpenDetail}>
            <Eye size={15} />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            aria-label={t('editTitle')}
            isDisabled={busy}
            onPress={onEdit}
          >
            <Pencil size={15} />
          </Button>
          <Dropdown placement="bottom-end">
            <DropdownTrigger><Button isIconOnly size="sm" variant="light" aria-label={t('moreActions')} isDisabled={busy}><MoreHorizontal size={16} /></Button></DropdownTrigger>
            <DropdownMenu aria-label={t('moreActions')}>
              {visibilityEnabled ? <DropdownItem key="visibility" startContent={agent.is_public === 1 ? <EyeOff size={15} /> : <Eye size={15} />} onPress={onVisibility}>{adminT(agent.is_public === 1 ? 'action.hideFromPublic' : 'action.showOnPublic')}</DropdownItem> : null}
              <DropdownItem key="commands" startContent={<SquareTerminal size={15} />} onPress={onOpenCommands}>{t('sectionCommands')}</DropdownItem>
              <DropdownItem key="remove" showDivider className="text-danger" color="danger" startContent={<Trash2 size={15} />} onPress={onRemove}>{t('remove')}</DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </div>
      </td>
    </motion.tr>
  );
}
