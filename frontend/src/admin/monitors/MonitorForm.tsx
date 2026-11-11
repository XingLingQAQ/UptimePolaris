import { MotionDisclosure } from '@/components/ui/MotionDisclosure';
import { Autocomplete, Select } from '@/components/ui/MotionOverlays';
import { useMotionList } from '@/lib/useMotionList';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { useBackendCapabilities } from '@/api/backend';
import { isProbeMonitorType } from '../../../../shared/backend-capabilities';
import { AutocompleteItem, Button, Chip, Divider, Input, SelectItem, Switch, Textarea } from '@heroui/react';
import clsx from 'clsx';
import {
  Check,
  ChevronDown,
  Copy,
  FlaskConical,
  Loader2,
  Plus,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import useSWR from 'swr';
import { isActiveProbeType, requiredProbeCapabilities } from '../../../../shared/probe-capabilities';
import { udpPacketOptions } from '../../../../shared/udp-probe';
import { groupsApi, tagsApi } from '../groups/api';
import type { MonitorGroup, Tag } from '../groups/types';
import { monitorsApi } from './api';
import { MonitorCheckFeedback } from './MonitorCheckFeedback';
import { probeSourceReadiness } from './presentation';
import { DEFAULT_DOH_RESOLVER, parseOptions, pushEndpointUrl, tagKey } from './options';
import type { CheckResult, DnsOptions, HttpOptions, Monitor, MonitorInput, MonitorType, TcpOptions } from './types';
import { hostOfTarget, isIpAddress, validateAgentOptions, validateTarget } from './validation';

/** Per-type labels and targets; Push and Agent have no target input. / 各类型的标签与目标字段；Push 和 Agent 无目标输入。 */
const TYPE_META: Record<
  MonitorType,
  {
    labelKey: string;
    targetLabelKey?: string;
    placeholderKey?: string;
    /** The paragraph under the type selector for this type. / 此类型在选择器下方显示的说明。 */
    hintKey?: string;
  }
> = {
  http: {
    labelKey: 'type.http',
    targetLabelKey: 'target.url',
    placeholderKey: 'target.urlPlaceholder',
    hintKey: 'target.urlHint',
  },
  tcp: {
    labelKey: 'type.tcp',
    targetLabelKey: 'target.addr',
    placeholderKey: 'target.addrPlaceholder',
    hintKey: 'target.addrHint',
  },
  udp: { labelKey: 'type.udp', targetLabelKey: 'target.addr', placeholderKey: 'target.udpPlaceholder', hintKey: 'target.udpHint' },
  icmp: { labelKey: 'type.icmp', targetLabelKey: 'target.host', placeholderKey: 'target.hostPlaceholder', hintKey: 'target.icmpHint' },
  dns: { labelKey: 'type.dns', targetLabelKey: 'target.host', placeholderKey: 'target.hostPlaceholder', hintKey: 'target.dnsHint' },
  tls: { labelKey: 'type.tls', targetLabelKey: 'target.addr', placeholderKey: 'target.tlsPlaceholder', hintKey: 'target.tlsHint' },
  websocket: { labelKey: 'type.websocket', targetLabelKey: 'target.url', placeholderKey: 'target.websocketPlaceholder', hintKey: 'target.websocketHint' },
  push: {
    labelKey: 'type.push',
    // No target field; `target.pushHint` already renders under the URL field.
    // Push 无目标字段；提示已显示在 URL 字段下，不重复。
  },
  agent: {
    labelKey: 'type.agent',
  },
};

/**
 * Every option field the form can edit, flattened.
 *
 * The three option interfaces are disjoint, so intersecting their partials
 * avoids narrowing a discriminated union at every access. DNS nests under
 * `dns` so an HTTP monitor carrying DNS settings cannot collide with a
 * same-named HTTP knob. `Partial` on `dns` matters: a stored `{}` must render
 * as a selection (`A` fallback), not crash.
 * 表单选项字段的扁平视图；DNS 嵌套在 `dns` 下，存储的 `{}` 必须能回退到 A 而不是崩溃。
 */
type FormOptions = Partial<HttpOptions> & Partial<TcpOptions> & { serverName?: string; check_source?: { type: 'worker' | 'server' } | { type: 'agent'; agent_id: string }; dns?: Partial<DnsOptions>; alerts?: Partial<Record<'cpu' | 'memory' | 'disk' | 'load', { enabled: boolean; threshold: number; duration_sec: number; recovery_pct: number }>> };

/** The record types the Worker accepts, in the order a zone file lists them. / Worker 接受的记录类型，按区域文件中的顺序排列。 */
const DNS_RECORD_TYPES: DnsOptions['recordType'][] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];

interface ProbeSourceOption {
  key: string;
  label: string;
  disabled: boolean;
}

/**
 * Sentinel for "no group" in the group select.
 *
 * HeroUI keys are strings, and a `null` group has none, so one must be
 * invented. Not the empty string: a select reports that for "nothing
 * selected", and clearing the group must stay distinguishable from a
 * selection that failed to render. A leading NUL cannot occur in a group id.
 * “无分组”哨兵；不能用空键，空键表示未选择。NUL 不会出现在分组 ID 中。
 */
const NO_GROUP = '\u0000none';

/** Headers as pasted `Name: value` lines; a textarea beats a two-input repeater. / 请求头按粘贴的 `Name: value` 行编辑，比逐行两输入框省事。 */
function headersToText(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n');
}

function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    // Drop malformed lines; the raw textarea text is kept separately.
    // 丢弃无冒号的行；原文与解析结果分开保存。
    if (sep <= 0) continue;
    out[trimmed.slice(0, sep).trim()] = trimmed.slice(sep + 1).trim();
  }
  return out;
}


interface Props {
  monitor?: Monitor | null;
  onSaved: () => void;
  onCancel?: () => void;
  /** Notify the host when a group or tag vocabulary changes. / 分组或标签词表变化时通知宿主。 */
  onVocabChanged?: () => void;
  /** Defaults for new monitors only; edited monitors keep their stored values. / 仅用于新建监控；编辑时使用已存值。 */
  defaults?: { interval_sec: number; timeout_ms: number };
  /** Type a new monitor starts on. Ignored when editing. / 新建监控项的初始类型；编辑时忽略。 */
  initialType?: MonitorType | null;
}

function toInput(
  monitor: Monitor | null | undefined,
  defaults?: { interval_sec: number; timeout_ms: number },
): MonitorInput {
  if (!monitor) {
    return {
      name: '',
      type: 'http',
      target: '',
      method: 'GET',
      expected_status: '200-299',
      keyword: '',
      // Show the settings values that will be saved; 60/10000 only covers the first paint.
      // 显示将保存的设置值；首次绘制前才用 60/10000。
      interval_sec: defaults?.interval_sec ?? 60,
      timeout_ms: defaults?.timeout_ms ?? 10000,
      warn_days: 14,
      active: 1,
      agent_id: null,
      check_ssl: 0,
      check_domain: 0,
      check_dns: 0,
      options_json: '{}',
      // Send explicit nulls: absent `group_id`/`tag_ids` means "leave unchanged".
      // 显式发送 null；缺失表示保持原值。
      group_id: null,
      tag_ids: [],
    };
  }
  return {
    name: monitor.name,
    type: monitor.type,
    target: monitor.target,
    method: monitor.method,
    expected_status: monitor.expected_status,
    keyword: monitor.keyword ?? '',
    interval_sec: monitor.interval_sec,
    timeout_ms: monitor.timeout_ms,
    warn_days: monitor.warn_days,
    active: monitor.active,
    agent_id: monitor.type === 'agent' ? monitor.agent_id : null,
    check_ssl: monitor.check_ssl,
    check_domain: monitor.check_domain,
    check_dns: monitor.check_dns,
    // Pass through verbatim; re-serialising would rewrite an untouched column.
    // 原样传递；重新序列化会改写用户未触及的列。
    options_json: monitor.options_json ?? '{}',
    group_id: monitor.group_id,
    tag_ids: (monitor.tags ?? []).map(tagKey),
  };
}

export function MonitorForm({ monitor, onSaved, onCancel, onVocabChanged, defaults, initialType }: Props) {
  const backend = useBackendCapabilities();
  const capabilities = backend.data;
  const backendSource = capabilities?.probeSource;
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const [form, setForm] = useState<MonitorInput>(() => {
    const base = toInput(monitor, defaults);
    return monitor || !initialType ? base : { ...base, type: initialType };
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const testRequest = useRef<AbortController | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    testRequest.current?.abort();
    testRequest.current = null;
    setTesting(false);
    setResult(null);
    setError(null);
    return () => { testRequest.current?.abort(); };
  }, [form]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const probeSources = useSWR('agent-probe-sources', () => monitorsApi.probeSources(), { refreshInterval: 15000, revalidateOnFocus: true });
  const probeAgents = probeSources.data?.agents ?? [];
  const probeAgentsLoaded = !probeSources.isLoading;
  const probeAgentsError = Boolean(probeSources.error);

  /**
   * Raw header text, edited alongside `options_json`.
   *
   * Do not derive it from the parsed record: a trailing newline has no header to
   * attach to, so pressing Enter to start a second header would drop it, and
   * `X-Trace:` would lose the space before the value is typed. The parsed record
   * is still written to `options_json` on every change, so the wire shape has a
   * single source; this text is only what the cursor edits.
   *
   * 请求头原文，与 options_json 并存；不要从解析记录反推，否则输入过程中的换行和空格会丢。
   */
  const [headersText, setHeadersText] = useState(() =>
    headersToText(parseOptions<HttpOptions>(monitor?.options_json).headers),
  );

  // Re-seed when a different monitor is opened, so the previous row's values
  // can never leak into the next edit.
  // 打开不同监控项时重新填充，避免上一行的值泄漏到下一次编辑。
  useEffect(() => {
    if (!monitor) return;
    setForm(toInput(monitor));
    setHeadersText(headersToText(parseOptions<HttpOptions>(monitor?.options_json).headers));
    setResult(null);
    setError(null);
    setCopied(false);
    setGroupQuery('');
    setTagQuery('');
  }, [monitor?.id]);

  /**
   * Group and tag vocabularies for both pickers.
   *
   * Loaded here so every host gets them; `null` while loading stays distinct
   * from an empty array, or every open would flash "nothing to choose from".
   * A lookup failure degrades to empty lists: the monitor can still be saved
   * without touching either field, and the Worker re-validates on write.
   * 分组与标签词表；加载中与空列表区分，加载失败降级为空，不影响保存。
   */
  const [groups, setGroups] = useState<MonitorGroup[] | null>(null);
  const [tags, setTags] = useState<Tag[] | null>(null);

  /** Create and select groups/tags inline; group management also lives on /admin/groups. / 在表单内创建并选择分组或标签；分组管理也位于 /admin/groups。 */
  const [vocabError, setVocabError] = useState<string | null>(null);

  /**
   * Group picker input text, held beside the selection.
   *
   * `onInputChange` only reports typing; `onSelectionChange` only fires on a
   * pick. Knowing "typed X, nothing matched" needs both. Reset when the drawer
   * switches monitors so the previous row's query cannot leak.
   * 分组选择器输入文本；输入与选中分开保存，切换监控时重置。
   */
  const [groupQuery, setGroupQuery] = useState('');

  /** Tag picker input; becomes the new tag name when nothing matches. / 标签选择器输入；无匹配时作为新标签名。 */
  const fields = useMotionList();
  const [tagQuery, setTagQuery] = useState('');

  /** Re-read both vocabularies, for after an inline create or edit. / 在表单内创建或编辑后重新读取两个词表。 */
  const reloadVocab = async () => {
    const [groupList, tagList] = await Promise.all([
      groupsApi.listGroups().then((r) => r.groups, () => []),
      tagsApi.listTags().then((r) => r.tags, () => []),
    ]);
    setGroups(groupList);
    setTags(tagList);
    onVocabChanged?.();
  };

  /**
   * Create a group from the picker text and select it.
   *
   * Selecting is the point: the monitor belongs in a group that does not exist
   * yet, so leaving it unselected would make the user create it and then pick
   * it. Errors surface under the picker; `name_taken` is the likely answer.
   * 用输入文本新建分组并选中；错误显示在选择器下方。
   */
  async function createGroupFromQuery() {
    const name = groupQuery.trim();
    if (!name) return;
    setVocabError(null);
    try {
      const { id } = await groupsApi.createGroup({ name });
      await reloadVocab();
      patch('group_id', id);
      setGroupQuery('');
    } catch (e) {
      setVocabError(apiErrorMessage(e));
    }
  }

  /**
   * Create a tag from the picker text, add it to this monitor, then clear the
   * input. Selected as well as created, for the same reason as a new group.
   * 用输入文本新建标签并加入当前监控，然后清空输入。
   */
  async function createTagFromQuery() {
    const name = tagQuery.trim();
    if (!name) return;
    setVocabError(null);
    try {
      const { id } = await tagsApi.createTag({ name });
      await reloadVocab();
      patch('tag_ids', [...(form.tag_ids ?? []), id]);
      setTagQuery('');
    } catch (e) {
      setVocabError(apiErrorMessage(e));
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [groupList, tagList] = await Promise.all([
        groupsApi.listGroups().then(
          (r) => r.groups,
          () => [],
        ),
        tagsApi.listTags().then(
          (r) => r.tags,
          () => [],
        ),
      ]);
      // Ignore lookup results after the drawer closes. / 抽屉关闭后忽略查询结果。
      if (cancelled) return;
      setGroups(groupList);
      setTags(tagList);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function reloadProbeSources() {
    await probeSources.mutate();
  }

  /** Order by weight then name, matching the status page. / 按 weight、name 排序，与状态页一致。 */
  const groupOptions = useMemo(
    () =>
      [...(groups ?? [])].sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name)),
    [groups],
  );

  /** Tag options, by name - they have no weight, so name is the only order. / 标签没有权重，选项仅按名称排序。 */
  const tagOptions = useMemo(
    () => [...(tags ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  );

  const meta = TYPE_META[form.type];

  /** Parsed options; `parseOptions` never throws, so a NULL or truncated value becomes an empty form. / 解析后的选项；`parseOptions` 不会抛错，NULL 或截断值显示为空表单。 */
  const options = useMemo(() => parseOptions<FormOptions>(form.options_json), [form.options_json]);

  /**
   * Type stays editable, including on an existing monitor.
   *
   * Locking it used to be the remedy, but that only pushed the user to delete
   * and recreate the monitor, losing history. The Worker re-validates the target
   * against the new type and rejects a mismatch with `invalid_target_for_type`,
   * so a target is still never silently reinterpreted.
   * 类型始终可编辑；Worker 会按新类型校验目标，避免静默改写。
   */
  const targetError = useMemo(
    () => (form.target ? validateTarget(form.type, form.target) : null),
    [form.type, form.target],
  );

  /** Looked up per render so it follows locale switches; `validateTarget` returns codes. / 每次渲染时查询以跟随语言切换；`validateTarget` 返回错误码。 */
  const targetErrorMessage = targetError ? t(`form.targetError.${targetError}`) : undefined;

  /** Add-ons need a host; push has none, which removes the section. / 附加检查需要主机；Push 没有主机，因此隐藏该区域。 */
  const addonHost = useMemo(
    () => hostOfTarget(form.type, form.target),
    [form.type, form.target],
  );

  const hasAddons = form.type === 'http' || form.type === 'tcp' ||
    capabilities?.runtime === 'go' && ['udp', 'tls', 'websocket'].includes(form.type);

  /**
   * IP literals make every add-on a name lookup that cannot succeed, so the
   * whole section is replaced with an explanation. A disabled switch would imply
   * it could work if another field changed; here nothing the form edits can.
   * IP 目标下附加检查无法成功；用说明替代禁用开关，避免暗示改别的字段就能用。
   */
  const isIp = addonHost ? isIpAddress(addonHost) : false;

  const formOptions = parseOptions<FormOptions>(form.options_json);
  const selectedSource = formOptions.check_source?.type === 'agent' ? formOptions.check_source.agent_id : '';
  const addonsDisabled = !hasAddons || !addonHost || Boolean(targetError) || isIp;
  const agentOnly = isProbeMonitorType(form.type) && !capabilities?.monitoring.nativeTypes.includes(form.type);
  const invalidUdp = form.type === 'udp' && !udpPacketOptions(formOptions);

  /**
   * Zero add-on flags at save time, not while typing.
   *
   * Clearing them in an effect keyed on "no host derivable" fired on every
   * keystroke that made the target momentarily invalid, silently wiping the
   * add-on the user had just enabled. Push targets are blanked by the same rule
   * at submit, so switching type and back does not destroy a typed URL.
   * 保存时清零附加开关，不在输入过程中清零；切换类型不会清掉已输入的 URL。
   */
  function normalizeForSubmit(input: MonitorInput): MonitorInput {
    const out = addonsDisabled
      ? { ...input, check_ssl: 0, check_domain: 0, check_dns: 0 }
      : { ...input };
    if (out.type === 'push') { out.target = ''; out.options_json = '{}'; }
    if (isProbeMonitorType(out.type) && !selectedSource && backendSource) {
      out.options_json = JSON.stringify({ ...parseOptions<FormOptions>(out.options_json), check_source: { type: backendSource } });
    }
    if (out.type === 'dns') {
      const options = parseOptions<FormOptions>(out.options_json);
      out.options_json = JSON.stringify({ ...options, dns: { ...options.dns, recordType: options.dns?.recordType ?? 'A' } });
    }
    return out;
  }

  /** Push has no target, so it cannot be required. / Push 没有目标，不能设为必填。 */
  const needsTarget = form.type !== 'push' && form.type !== 'agent';
  const requiredSourceCapabilities = requiredProbeCapabilities(form.type, { ssl: Boolean(form.check_ssl), domain: Boolean(form.check_domain), dns: Boolean(form.check_dns) });
  const sourceAgent = probeAgents.find((agent) => agent.id === selectedSource);
  const sourceAvailable = Boolean(sourceAgent && (!agentOnly || !probeAgentsError) && probeSourceReadiness(sourceAgent, requiredSourceCapabilities) === 'ready');
  const canCreateWithSource = Boolean(monitor) || (agentOnly ? Boolean(selectedSource) && sourceAvailable : !selectedSource || sourceAvailable);
  const typeOptions = (capabilities?.monitoring.types ?? []).flatMap(type => {
    const available = type === 'push' || type === 'agent' || capabilities?.monitoring.nativeTypes.includes(type) ||
      isActiveProbeType(type) && !probeAgentsError && probeAgents.some(agent => probeSourceReadiness(agent, requiredProbeCapabilities(type)) === 'ready');
    return available || monitor?.type === type ? [{ type, label: t(TYPE_META[type].labelKey), disabled: !available }] : [];
  });

  const probeSourceOptions: ProbeSourceOption[] = [
    ...(!agentOnly && backendSource ? [{ key: backendSource, label: t(backendSource === 'server' ? 'form.serverSource' : 'form.workerSource'), disabled: false }] : []),
    ...(selectedSource && !sourceAgent ? [{ key: selectedSource, label: probeAgentsLoaded && !probeAgentsError ? t('form.removedAgent', { id: selectedSource }) : selectedSource, disabled: true }] : []),
    ...(isActiveProbeType(form.type) ? probeAgents : []).map((agent) => {
      const readiness = probeSourceReadiness(agent, requiredSourceCapabilities);
      const ready = readiness === 'ready';
      const state = t(readiness === 'ready' ? 'form.agentReady' : readiness === 'waiting' ? 'form.agentWaiting' : readiness === 'disabled' ? 'form.agentProbeDisabled' : readiness === 'upgrade' ? 'form.agentUpgrade' : 'form.agentOffline');
      return { key: agent.id, label: `${agent.name} · ${state}`, disabled: !ready };
    }),
  ];
  const canSubmit =
    Boolean(capabilities?.monitoring.types.includes(form.type)) && Boolean(form.name.trim()) && (!needsTarget || Boolean(form.target.trim())) && !targetError && !invalidUdp && canCreateWithSource &&
    (form.type !== 'agent' || Boolean(form.agent_id) && validateAgentOptions(form.options_json ?? '{}')) && !saving;

  const patch = <K extends keyof MonitorInput>(key: K, value: MonitorInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * Merge rendered option fields into the stored JSON.
   *
   * Unknown keys pass through untouched, so an option added to the Worker's
   * contract before this form knows it survives an unrelated edit instead of
   * being silently dropped on the next save.
   * 未知键原样保留，避免表单不认识的新选项在下次保存时被丢掉。
   */
  function patchOptions(fields: Partial<FormOptions>) {
    setForm((f) => {
      const current = parseOptions<FormOptions>(f.options_json);
      return { ...f, options_json: JSON.stringify({ ...current, ...fields }) };
    });
  }

  /** Patch only the nested `dns` block; create it on first edit. / 只修改嵌套的 `dns`，首次编辑时创建。 */
  function patchDns(fields: Partial<NonNullable<FormOptions['dns']>>) {
    setForm((f) => {
      const current = parseOptions<FormOptions>(f.options_json);
      const dns = { ...(current.dns ?? {}), ...fields };
      return { ...f, options_json: JSON.stringify({ ...current, dns }) };
    });
  }

  function patchHeaders(text: string) {
    setHeadersText(text);
    patchOptions({ headers: textToHeaders(text) });
  }

  async function handleTest() {
    if (testRequest.current) return;
    const controller = new AbortController();
    testRequest.current = controller;
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      const response = await monitorsApi.testMonitor(normalizeForSubmit(form), AbortSignal.any([
        controller.signal, AbortSignal.timeout(Math.max(75000, (form.timeout_ms ?? capabilities?.monitoring.maximumTimeoutMs ?? 60000) + 15000)),
      ]));
      if (!controller.signal.aborted) setResult(response);
    } catch (e) {
      if (!controller.signal.aborted) setError(apiErrorMessage(e));
    } finally {
      if (testRequest.current === controller) {
        testRequest.current = null;
        setTesting(false);
      }
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload = normalizeForSubmit(form);
      if (monitor) await monitorsApi.updateMonitor(monitor.id, payload);
      else await monitorsApi.createMonitor(payload);
      onSaved();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * The push URL is built after save, when the Worker mints the token.
   *
   * No regenerate control: the contract exposes `POST /api/public/push/:token`
   * and nothing else. Rotating the token means recreating the monitor.
   * Push URL 在保存后由 Worker 生成令牌；轮换只能重建监控。
   */
  const pushUrl = pushEndpointUrl(monitor?.push_token);

  async function copyPushUrl() {
    try {
      await navigator.clipboard.writeText(pushUrl);
      setCopied(true);
      // Reverts on its own so the button stops reading "Copied" once the
      // clipboard has moved on.
      // 两秒后自动恢复按钮文案，避免剪贴板内容变化后仍显示“已复制”。
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  return (
    /*
      Fixed-height column: a scrolling content area, then the action bar pinned
      under it. The bar used to be `sticky bottom-0` inside a single flow, which
      only pins it while the content is *taller* than the drawer - delete a
      section and the buttons ride up with the form instead of staying at the
      bottom. Giving the content its own scroll box makes the bar's position
      independent of how much is above it.

      固定高度列包含独立滚动内容和固定在其下的操作栏。原先在单一内容流中使用
      `sticky bottom-0`，只有内容高于抽屉时才固定；删除区段后按钮会随表单上移。
      独立滚动框让操作栏位置不受上方内容高度影响。
    */
    <div className="flex min-h-0 flex-1 flex-col">
      {backend.error ? <div role="alert" className="flex items-center gap-2 text-small text-danger"><span>{apiErrorMessage(backend.error)}</span><Button variant="light" onPress={() => void backend.mutate()}>{t('action.retry')}</Button></div> : null}
      <div className="polaris-scroll-x flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pb-5">
      {meta.hintKey ? <p className="text-small text-default-500">{t(meta.hintKey)}</p> : null}

      <div ref={fields} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label={t('form.name')}
          placeholder={t('form.namePlaceholder')}
          variant="bordered"
          value={form.name}
          onValueChange={(v) => patch('name', v)}
          isRequired
        />

        <Select
          items={typeOptions}
          label={t('form.type')}
          variant="bordered"
          selectedKeys={typeOptions.some(option => option.type === form.type) ? [form.type] : []}
          disallowEmptySelection
          /* Changing the type re-validates the target against it. The hint below
             says so, because a rejection here looks like a bug otherwise.
             更改类型会按新类型重新校验目标；下方提示说明这一点，否则拒绝输入看起来像故障。 */
          isLoading={backend.isLoading}
          description={monitor ? t('form.typeChangeHint') : undefined}
          onChange={(e) => {
            const type = e.target.value as MonitorType;
            if (!typeOptions.some(option => option.type === type && !option.disabled)) return;
            setForm(current => {
              const options = parseOptions<FormOptions>(current.options_json);
              if (isProbeMonitorType(type) && !capabilities?.monitoring.nativeTypes.includes(type)) {
                const ready = probeAgents.filter(agent => probeSourceReadiness(agent, requiredProbeCapabilities(type)) === 'ready');
                const selected = ready.find(agent => agent.id === selectedSource) ?? ready[0];
                const check_source = selected ? { type: 'agent' as const, agent_id: selected.id } : undefined;
                return { ...current, type, check_ssl: 0, check_domain: 0, check_dns: 0,
                  options_json: JSON.stringify(type === 'udp' ? { check_source, send: options.send || 'ping', expect: options.expect ?? '', encoding: options.encoding ?? 'text' } : { check_source }) };
              }
              if (!isProbeMonitorType(type) || !isActiveProbeType(type)) delete options.check_source;
              return { ...current, type, options_json: JSON.stringify(type === 'agent' ? { ...(options.alerts ? { alerts: options.alerts } : {}) } : options) };
            });
          }}
        >
          {(item) => <SelectItem key={item.type} textValue={item.label} isDisabled={item.disabled}>{item.label}</SelectItem>}
        </Select>

        {form.type === 'agent' ? <Select
          items={form.agent_id && !probeAgents.some(agent => agent.id === form.agent_id)
            ? [...probeAgents, { id: form.agent_id, name: probeAgentsLoaded && !probeAgentsError ? t('form.removedAgent', { id: form.agent_id }) : form.agent_id }]
            : probeAgents}
          label={t('form.agentMachine')}
          description={t('form.agentMachineHint')}
          variant="bordered"
          isRequired
          isLoading={!probeAgentsLoaded}
          selectedKeys={form.agent_id ? [form.agent_id] : []}
          disallowEmptySelection
          onSelectionChange={keys => { if (keys !== 'all') { const id = [...keys][0]; if (typeof id === 'string') patch('agent_id', id); } }}
        >
          {agent => <SelectItem key={agent.id} textValue={agent.name}>{agent.name}</SelectItem>}
        </Select> : null}

        {/*
          Group.

          The combobox offers an explicit "no group" option backed by a sentinel
          key. On selection the sentinel maps back to `null`, the value the
          Worker expects. Ungrouping is a normal edit and does not require the
          operator to discover a clear affordance.

          分组组合框以哨兵键提供明确的“无分组”选项；选中后将其映射回 Worker
          期望的 null。取消分组是正常编辑操作，无需用户发现清除控件。
        */}
        {/*
          Group, as a combobox that filters as you type and offers to create
          what isn't there.

          Autocomplete with `allowsCustomValue` replaces the previous Select +
          `+` endContent + inline create row: typing narrows the list, and
          when nothing matches the input becomes a "create" action - which is
          the affordance newapi's model picker uses, and the one the inline
          row approximated badly by living outside the dropdown.

          The "no group" option is the first item rather than a separate
          control: ungrouping is a normal edit, and putting it in the list
          keeps it reachable by keyboard and by the same filter that searches
          real groups.

          分组使用可输入筛选和创建的组合框。支持自定义值的 Autocomplete 取代
          旧的 Select、加号和行内创建行；输入可缩小列表，无匹配时转为创建操作，
          与 newapi 模型选择器的方式相同，避免创建行位于下拉框外造成的割裂。
          “无分组”是首个列表项而非独立控件，可通过键盘和与真实分组相同的筛选访问。
        */}
        <Autocomplete
          label={t('form.group')}
          variant="bordered"
          description={t('form.groupHint')}
          selectedKey={form.group_id ?? null}
          defaultInputValue={
            form.group_id
              ? (groupOptions.find((g) => g.id === form.group_id)?.name ?? '')
              : form.group_id === null
                ? t('form.groupNone')
                : ''
          }
          allowsCustomValue
          /*
            No clear button. The picker's value is a group *name*, and an ×
            here would do two wrong things at once: it would blank the input
            (which is fine) but it would also fire onSelectionChange(null)
            which is indistinguishable from "user wants no group" - the one
            action that already has a dedicated row in the list. Hiding the
            × keeps "clear" a deliberate choice, not a misclick.

            不显示清除按钮：输入值是分组名称，× 会清空输入，同时触发
            onSelectionChange(null)，后者无法与“用户想取消分组”区分；
            列表已有专门的无分组项。隐藏 × 可避免误点导致取消分组。
          */
          isClearable={false}
          onInputChange={setGroupQuery}
          onSelectionChange={(key) => {
            if (key === null) return;
            const id = String(key);
            patch('group_id', id === NO_GROUP ? null : id);
            setGroupQuery('');
          }}
          listboxProps={{
            emptyContent:
              groupQuery.trim().length > 0 ? (
                <button
                  type="button"
                  onClick={() => void createGroupFromQuery()}
                  className="flex w-full items-center gap-2 rounded-small px-2 py-1.5 text-left text-small text-primary hover:bg-primary/10"
                >
                  <Plus size={14} />
                  {t('groups.createFromQuery', { name: groupQuery.trim() })}
                </button>
              ) : (
                t('list.noMatch')
              ),
          }}
        >
          <>
            <AutocompleteItem key={NO_GROUP}>{t('form.groupNone')}</AutocompleteItem>
            {groupOptions.map((group) => (
              <AutocompleteItem key={group.id} textValue={group.name}>
                {group.name}
              </AutocompleteItem>
            ))}
          </>
        </Autocomplete>

        {/*
          Tags.

          The vocabulary can grow without bound, so one combobox is used instead
          of a checkbox per tag. Each selection adds one tag; selected tags appear
          as removable chips below.

          标签词表长度不固定，因此使用一个组合框而非每个标签一个复选框。
          每次选择添加一个标签；已选标签在下方显示为可移除的徽章。
        */}
        {/*
          Tags.

          A single combobox that adds one tag at a time, with the chosen tags
          shown as chips below - the same arrangement newapi's model picker
          uses. Typing filters the vocabulary; when nothing matches, the empty
          state becomes a "create this" action so a new tag is one click away
          rather than a context switch.

          A single Autocomplete rather than a multi-select because the
          workflow is asymmetric: adding a tag is a search ("find or create"),
          while removing one is a direct action on the chip. A multi-select
          forces both through the same dropdown and makes creation awkward.

          使用一次添加一个标签的组合框，已选标签以徽章列在下方，与 newapi 模型
          选择器一致。输入筛选词表，无匹配时空状态提供创建操作，避免切换上下文。
          添加是搜索或创建，删除是对徽章的直接操作；多选会强迫二者使用同一下拉框，
          使创建变得不便。
        */}
        <div className="flex flex-col gap-2">
          <Autocomplete
            label={t('form.tags')}
            variant="bordered"
            description={t('form.tagsHint')}
            placeholder={t('tags.namePlaceholder')}
            allowsCustomValue
            /* The × would only clear the input - the selected tags live in the
               chips below, so the button would be a dead affordance.
               × 只能清除输入，已选标签保存在下方徽章中，因此该按钮无法清除选择。 */
            isClearable={false}
            onInputChange={setTagQuery}
            onSelectionChange={(key) => {
              if (key === null) return;
              const id = String(key);
              // Add to the selection, ignore duplicates. / 添加到选择中，忽略重复项。
              const cur = form.tag_ids ?? [];
              if (!cur.includes(id)) patch('tag_ids', [...cur, id]);
              setTagQuery('');
            }}
            listboxProps={{
              emptyContent:
                tagQuery.trim().length > 0 ? (
                  <button
                    type="button"
                    onClick={() => void createTagFromQuery()}
                    className="flex w-full items-center gap-2 rounded-small px-2 py-1.5 text-left text-small text-primary hover:bg-primary/10"
                  >
                    <Plus size={14} />
                    {t('tags.createFromQuery', { name: tagQuery.trim() })}
                  </button>
                ) : (
                  t('list.noMatch')
                ),
            }}
          >
            {tagOptions
              .filter((tag) => !(form.tag_ids ?? []).includes(tag.id))
              .map((tag) => (
                <AutocompleteItem key={tag.id} textValue={tag.name}>
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </span>
                </AutocompleteItem>
              ))}
          </Autocomplete>

          {/*
            The tags already on this monitor, each with an × to remove.

            Removal is direct (no confirmation): the tag stays in the
            vocabulary, only the link to this monitor goes. Rename and delete
            from the vocabulary are deliberately not offered here - those are
            global operations, and the place for them is not the per-monitor
            form.

            已选标签各带 × 可直接移除，无需确认：标签仍保留在词表中，只删除它与
            当前监控项的关联。重命名和删除词表中的标签是全局操作，不放在单监控项表单中。
          */}
          {(form.tag_ids ?? []).length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {tagOptions
                .filter((tag) => (form.tag_ids ?? []).includes(tag.id))
                .map((tag) => (
                  <Chip
                    key={tag.id}
                    size="sm"
                    variant="flat"
                    className="h-6 px-2 text-tiny"
                    style={{ backgroundColor: `${tag.color}15`, color: tag.color }}
                    onClose={() =>
                      patch(
                        'tag_ids',
                        (form.tag_ids ?? []).filter((id) => id !== tag.id),
                      )
                    }
                  >
                    {tag.name}
                  </Chip>
                ))}
            </div>
          ) : null}

          {vocabError ? (
            <p className="rounded-medium border border-danger/20 bg-danger/10 px-3 py-2 text-tiny text-danger">
              {vocabError}
            </p>
          ) : null}
        </div>

        {meta.targetLabelKey ? (
          <div className="sm:col-span-2">
            <Input
              label={t(meta.targetLabelKey)}
              placeholder={meta.placeholderKey ? t(meta.placeholderKey) : undefined}
              variant="bordered"
              value={form.target}
              onValueChange={(v) => patch('target', v)}
              isInvalid={Boolean(targetError)}
              errorMessage={targetErrorMessage}
              isRequired
            />
          </div>
        ) : null}

        {isProbeMonitorType(form.type) ? (
          <div className="sm:col-span-2">
            <Select
              items={probeSourceOptions}
              label={t('form.probeSource')}
              variant="bordered"
              selectedKeys={selectedSource ? [selectedSource] : agentOnly || !backendSource ? [] : [backendSource]}
              isRequired={agentOnly}
              isLoading={!probeAgentsLoaded}
              description={!probeAgentsLoaded ? t('form.sourcesLoading') : selectedSource && !sourceAvailable
                ? t('form.sourceUnavailable', { name: sourceAgent?.name ?? selectedSource })
                : t(agentOnly ? 'form.agentOnlySourceHint' : backendSource === 'server' ? 'form.serverProbeHint' : 'form.probeSourceHint')}
              onChange={(event) => {
                const id = event.target.value;
                if (agentOnly && id === backendSource) return;
                if (!probeSourceOptions.some(option => option.key === id && !option.disabled)) return;
                patchOptions({ check_source: id === backendSource && backendSource ? { type: backendSource } : { type: 'agent', agent_id: id } });
              }}
            >
              {(option) => <SelectItem key={option.key} isDisabled={option.disabled}>{option.label}</SelectItem>}
            </Select>
            {probeAgentsError ? <div className="flex items-center gap-2 text-tiny text-danger"><span>{t('form.sourcesFailed')}</span><Button size="sm" variant="light" onPress={reloadProbeSources}>{t('form.retrySources')}</Button></div> : null}
          </div>
        ) : null}

        {/*
          The push URL takes the target slot rather than a box further down: it
          is the address of this monitor, which is what that slot means for every
          other type.

          Rendered in both states, so the form's shape does not jump the moment a
          monitor is saved. Before the token exists the input is empty with
          `target.push` as its placeholder - "(nothing to enter)" says the
          emptiness is the point, where a bare empty box would read as a field
          the user has failed to fill - and the hint is the one that explains the
          Worker will generate the address. Afterwards it carries the URL.

          Push URL 占据目标字段位置，因为它是该监控项的地址，与其他类型该位置的含义一致。
          保存前后均渲染，避免保存时表单跳动；令牌不存在时输入框为空并显示 `target.push`
          占位符“无需输入”，提示 Worker 会生成地址；生成后显示 URL。
        */}
        {form.type === 'push' ? (
          <div className="sm:col-span-2">
            <div className="flex items-end gap-2">
              <Input
                isReadOnly
                label={t('form.pushUrl')}
                variant="bordered"
                value={pushUrl}
                placeholder={pushUrl ? undefined : t('target.push')}
                classNames={{ input: 'font-mono text-tiny' }}
                /* Read-only rather than disabled: a disabled input cannot be
                   selected, and being selected and copied is this field's whole
                   purpose.
                   输入框只读而非禁用：禁用后无法选中，而选择和复制正是其用途。 */
              />
              <Button
                variant="flat"
                isDisabled={!pushUrl}
                startContent={copied ? <Check size={15} /> : <Copy size={15} />}
                onPress={copyPushUrl}
              >
                {copied ? t('form.pushCopied') : t('form.pushCopy')}
              </Button>
            </div>
            <p className="mt-1.5 text-tiny text-default-500">
              {pushUrl ? t('form.pushUrlHint') : t('target.pushHint')}
            </p>
          </div>
        ) : null}

        {form.type === 'agent' ? (
          <>


            <div className="flex flex-col gap-2 rounded-medium border border-divider bg-default-50 p-3 sm:col-span-2">
              <span className="text-small font-medium">{t('form.agentAlerts')}</span>
              {/*
                One rule per row: switch, then its three numbers.

                The first column is sized to the longest label rather than to
                the content of each row, so all four switches start at the same
                x and the inputs line up - the old four-equal-columns grid let
                a longer label steal width from its own inputs and left the
                card taller than it needed to be.

                每条规则一行：开关及三个数值。第一列按最长标签确定宽度，
                使四个开关和输入框对齐；旧四等列网格让较长标签挤占本行输入宽度，
                并使卡片比必要的更高。
              */}
              {(['cpu', 'memory', 'disk', 'load'] as const).map((key) => {
                const rule = options.alerts?.[key] ?? { enabled: false, threshold: key === 'load' ? 4 : 90, duration_sec: 300, recovery_pct: 90 };
                const setRule = (patch: Partial<typeof rule>) => patchOptions({ alerts: { ...options.alerts, [key]: { ...rule, ...patch } } });
                // Align the Switch with the label-plus-box block, not the input alone. / 让开关与“标签+输入框”整体对齐，而不只是输入框。
                return (
                  <div
                    key={key}
                    className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[7rem_repeat(3,minmax(0,1fr))]"
                  >
                    <Switch
                      size="sm"
                      className="mb-3"
                      isSelected={rule.enabled}
                      onValueChange={(enabled) => setRule({ enabled })}
                    >
                      {t(`form.agentAlert.${key}`)}
                    </Switch>
                    <Input type="number" size="sm" min={0.1} label={t('form.agentThreshold')} value={String(rule.threshold)} onValueChange={(v) => setRule({ threshold: Number(v) })} />
                    <Input type="number" size="sm" min={1} label={t('form.agentDuration')} value={String(rule.duration_sec)} onValueChange={(v) => setRule({ duration_sec: Number(v) })} />
                    <Input type="number" size="sm" min={1} max={99} label={t('form.agentRecovery')} value={String(rule.recovery_pct)} onValueChange={(v) => setRule({ recovery_pct: Number(v) })} />
                  </div>
                );
              })}
              <p className="text-tiny text-default-500">{t('form.agentAlertsHint')}</p>
              {validateAgentOptions(form.options_json ?? '{}') ? null : <p className="text-tiny text-danger">{t('form.agentThresholdInvalid')}</p>}
            </div>
          </>
        ) : null}
      </div>

      <Divider />

      <div ref={fields} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label={t(form.type === 'push' ? 'form.pushInterval' : 'form.interval')}
          type="number"
          variant="bordered"
          min={capabilities?.monitoring.minimumIntervalSec}
          value={String(form.interval_sec ?? 60)}
          onValueChange={(v) => patch('interval_sec', Number(v) || 60)}
          description={
            // Push reuses interval_sec as its heartbeat deadline. / Push 将 interval_sec 用作心跳截止时间。
            form.type === 'push'
              ? t('form.pushDeadline', { sec: form.interval_sec ?? 60 })
              : t('form.intervalMinimum', { min: capabilities?.monitoring.minimumIntervalSec ?? 60 })
          }
        />

        {form.type !== 'push' ? <Input
          label={t('form.timeout')}
          type="number"
          variant="bordered"
          min={capabilities?.monitoring.minimumTimeoutMs}
          max={capabilities?.monitoring.maximumTimeoutMs}
          description={capabilities ? t('form.timeoutRange', { min: capabilities.monitoring.minimumTimeoutMs, max: capabilities.monitoring.maximumTimeoutMs }) : undefined}
          value={String(form.timeout_ms ?? 10000)}
          onValueChange={(v) => patch('timeout_ms', Number(v) || 10000)}
        /> : null}

        {form.type === 'http' ? (
          <>
            <Input
              label={t('form.expectedStatus')}
              placeholder="200-299"
              variant="bordered"
              value={form.expected_status ?? ''}
              onValueChange={(v) => patch('expected_status', v)}
              description={t('form.statusHint')}
            />
            <Input
              label={t('form.keyword')}
              placeholder="OK"
              variant="bordered"
              value={form.keyword ?? ''}
              onValueChange={(v) => patch('keyword', v)}
              description={t('form.keywordHint')}
            />
          </>
        ) : null}

        {/* The expiry threshold only means something while an expiry add-on is
            on, so it appears with them rather than permanently. DNS warn is
            binary and has no day count to threshold, so enabling `check_dns`
            alone does not bring the field back.
            到期阈值只在启用证书或域名到期附加项时有意义，因此随其显示；
            DNS 警告是二元状态，没有可设置阈值的天数，单独启用 check_dns 不显示此字段。 */}
        {form.check_ssl || form.check_domain || form.type === 'tls' ? (
          <Input
            label={t('form.warnDays')}
            type="number"
            variant="bordered"
            min={1}
            value={String(form.warn_days ?? 14)}
            onValueChange={(v) => patch('warn_days', Number(v) || 14)}
            description={t('form.warnHint')}
          />
        ) : null}
      </div>

      {form.type === 'tcp' || form.type === 'udp' || form.type === 'websocket' ? (
        <>
          <Divider />
          <div ref={fields} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label={t(form.type === 'udp' ? 'form.udpSend' : 'form.tcpSend')}
              placeholder={form.type === 'udp' ? 'ping' : 'PING\r\n'}
              isRequired={form.type === 'udp'}
              variant="bordered"
              value={options.send ?? (form.type === 'udp' ? 'ping' : '')}
              onValueChange={(v) => patchOptions({ send: v })}
              description={t(form.type === 'udp' ? 'form.udpSendHint' : 'form.tcpSendHint')}
            />
            <Input
              label={t(form.type === 'udp' ? 'form.udpExpect' : 'form.tcpExpect')}
              placeholder={form.type === 'udp' ? 'pong' : 'SSH-2.0'}
              variant="bordered"
              value={options.expect ?? ''}
              onValueChange={(v) => patchOptions({ expect: v })}
              description={t(form.type === 'udp' ? 'form.udpExpectHint' : 'form.tcpExpectHint')}
            />
            {form.type === 'udp' ? <Select label={t('form.udpEncoding')} variant="bordered" selectedKeys={[options.encoding ?? 'text']} disallowEmptySelection
              onChange={event => patchOptions({ encoding: event.target.value as 'text' | 'hex' })}>
              <SelectItem key="text">{t('form.udpText')}</SelectItem><SelectItem key="hex">{t('form.udpHex')}</SelectItem>
            </Select> : null}
            {invalidUdp ? <p role="alert" className="text-tiny text-danger sm:col-span-2">{t('form.udpOptionsInvalid')}</p> : null}
          </div>
        </>
      ) : null}

      {form.type === 'dns' ? <div ref={fields} className="grid gap-4 sm:grid-cols-2">
        <Select label={t('form.dnsRecordType')} selectedKeys={[formOptions.dns?.recordType ?? 'A']} disallowEmptySelection
          onChange={event => patchOptions({ dns: { ...formOptions.dns, recordType: event.target.value as DnsOptions['recordType'] } })}>
          {(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const).map(type => <SelectItem key={type}>{type}</SelectItem>)}
        </Select>
        <Input label={t('form.dnsExpected')} value={formOptions.dns?.expected ?? ''} onValueChange={expected => patchOptions({ dns: { ...formOptions.dns, recordType: formOptions.dns?.recordType ?? 'A', expected } })} />
        <Input label={t('form.dnsResolver')} placeholder={t('form.dnsSystemPlaceholder')} description={t('form.dnsSystemHint')} value={formOptions.dns?.resolver ?? ''}
          onValueChange={resolver => patchOptions({ dns: { ...formOptions.dns, recordType: formOptions.dns?.recordType ?? 'A', resolver } })} />
      </div> : null}
      {form.type === 'tls' ? <Input label={t('form.serverName')} placeholder="example.com" value={formOptions.serverName ?? ''}
        onValueChange={serverName => patchOptions({ serverName })} /> : null}
      {form.type === 'websocket' ? <Textarea label={t('form.httpHeaders')} minRows={3} value={headersText} onValueChange={patchHeaders} /> : null}

      {/* DNS options live in the add-on section below, not in a per-type block:
          `check_dns` is a flag on an http/tcp monitor, so the record-type /
          expected / resolver triple is the *consequence* of the switch, not a
          type of its own. The section below renders them beside the switch.
          DNS 是 HTTP/TCP 监控项的 check_dns 标志，记录类型、预期值和解析器
          是开关的后续选项而非独立监控类型，因此在下方附加项区与开关并列显示。 */}

      {form.type === 'http' ? (
        <>
          <Divider />

          {/*
            Advanced HTTP options, behind a disclosure.

            They get a section of their own rather than another row in the grid
            above because they are the exception: a plain status-code check needs
            none of them, and this form is already long enough that six more
            inputs would push Save below the fold on a laptop.

            A plain toggle rather than an accordion component, so the open state
            is one boolean this component owns and nothing remounts when the type
            changes - remounting is what discarded in-progress input in the past.

            高级 HTTP 选项折叠在独立区段：普通状态码检查无需这些选项，
            表单已足够长，再显示六个输入框会让笔记本首屏看不到保存按钮。
            使用普通开关而非 accordion，让本组件以一个布尔值持有展开状态，
            类型变化时不重新挂载；过去重新挂载曾丢失正在输入的内容。
          */}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
              className="flex items-center gap-1.5 self-start text-small font-medium text-default-600 transition-colors hover:text-foreground"
            >
              <ChevronDown
                size={15}
                className={clsx('transition-transform', advancedOpen && 'rotate-180')}
              />
              {t('form.httpAdvanced')}
            </button>

            <MotionDisclosure open={advancedOpen} className="flex flex-col gap-4">
                <p className="text-tiny text-default-500">{t('form.httpAdvancedHint')}</p>

                <Textarea
                  label={t('form.httpHeaders')}
                  variant="bordered"
                  minRows={3}
                  value={headersText}
                  onValueChange={patchHeaders}
                  description={t('form.httpHeadersHint')}
                />

                <Textarea
                  label={t('form.httpBody')}
                  variant="bordered"
                  minRows={2}
                  value={options.body ?? ''}
                  onValueChange={(v) => patchOptions({ body: v })}
                  description={t('form.httpBodyHint')}
                />

                <div ref={fields} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Select
                    items={(['none', 'basic', 'bearer'] as const).map((type) => ({ type, label: t(`form.httpAuth${type === 'none' ? 'None' : type === 'basic' ? 'Basic' : 'Bearer'}`) }))}
                    label={t('form.httpAuthType')}
                    variant="bordered"
                    selectedKeys={[options.auth?.type ?? 'none']}
                    disallowEmptySelection
                    onChange={(e) => {
                      const type = e.target.value as 'none' | 'basic' | 'bearer';
                      // "None" deletes `auth` instead of storing `{type:'none'}`; missing means no auth. / 选择 none 时删除 auth，而不是存 `{type:'none'}`；缺失即无认证。
                      patchOptions({ auth: type === 'none' ? undefined : { type } });
                    }}
                  >
                    {(item) => <SelectItem key={item.type} textValue={item.label}>{item.label}</SelectItem>}
                  </Select>

                  {options.auth?.type === 'basic' ? (
                    <>
                      <Input
                        label={t('form.httpAuthUser')}
                        variant="bordered"
                        value={options.auth.username ?? ''}
                        onValueChange={(v) =>
                          patchOptions({ auth: { ...options.auth, type: 'basic', username: v } })
                        }
                      />
                      <Input
                        label={t('form.httpAuthPass')}
                        type="password"
                        variant="bordered"
                        value={options.auth.password ?? ''}
                        onValueChange={(v) =>
                          patchOptions({ auth: { ...options.auth, type: 'basic', password: v } })
                        }
                      />
                    </>
                  ) : null}

                  {options.auth?.type === 'bearer' ? (
                    <Input
                      label={t('form.httpAuthToken')}
                      type="password"
                      variant="bordered"
                      value={options.auth.token ?? ''}
                      onValueChange={(v) => patchOptions({ auth: { type: 'bearer', token: v } })}
                    />
                  ) : null}
                </div>

                <div ref={fields} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Input
                    label={t('form.httpJsonPath')}
                    variant="bordered"
                    value={options.jsonPath ?? ''}
                    onValueChange={(v) => patchOptions({ jsonPath: v })}
                    description={t('form.httpJsonPathHint')}
                  />
                  <Input
                    label={t('form.httpJsonExpected')}
                    variant="bordered"
                    value={options.jsonExpected ?? ''}
                    onValueChange={(v) => patchOptions({ jsonExpected: v })}
                    description={t('form.httpJsonExpectedHint')}
                  />
                  <Input
                    label={t('form.httpHeaderName')}
                    variant="bordered"
                    value={options.headerName ?? ''}
                    onValueChange={(v) => patchOptions({ headerName: v })}
                    description={t('form.httpHeaderNameHint')}
                  />
                  <Input
                    label={t('form.httpHeaderExpected')}
                    variant="bordered"
                    value={options.headerExpected ?? ''}
                    onValueChange={(v) => patchOptions({ headerExpected: v })}
                    description={t('form.httpHeaderExpectedHint')}
                  />
                  <Input
                    label={t('form.httpMaxLatency')}
                    type="number"
                    variant="bordered"
                    min={1}
                    value={options.maxLatencyMs === undefined ? '' : String(options.maxLatencyMs)}
                    // Blank must mean "no ceiling", not `0` - which would be a
                    // ceiling no request can meet and would fail every check.
                    // 空值表示无上限，而不是 0；0 会使请求无法满足上限并导致每次检查失败。
                    onValueChange={(v) => patchOptions({ maxLatencyMs: v ? Number(v) : undefined })}
                    description={t('form.httpMaxLatencyHint')}
                  />
                </div>
              </MotionDisclosure>
          </div>
        </>
      ) : null}

      {hasAddons ? (
        <>
          <Divider />

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5">
              <ShieldCheck size={15} className="text-default-400" />
              <span className="text-small font-medium">{t('form.addons')}</span>
            </div>

            {isIp ? (
              <p className="rounded-medium border border-divider bg-default-50 px-3 py-2.5 text-tiny text-default-500">
                {t('form.ipNoAddons')}
              </p>
            ) : (
              <div className="flex flex-col gap-2.5 rounded-medium border border-divider bg-default-50 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Switch
                    size="sm"
                    isSelected={form.check_ssl === 1}
                    isDisabled={addonsDisabled}
                    onValueChange={(on) => patch('check_ssl', on ? 1 : 0)}
                  >
                    {t('form.checkSsl')}
                  </Switch>
                  <span className="text-tiny text-default-500">{t(selectedSource ? 'form.agentSslHint' : capabilities?.monitoring.sslMode === 'tls-handshake' ? 'form.directSslHint' : 'form.checkSslHint')}</span>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Switch
                    size="sm"
                    isSelected={form.check_domain === 1}
                    isDisabled={addonsDisabled}
                    onValueChange={(on) => patch('check_domain', on ? 1 : 0)}
                  >
                    {t('form.checkDomain')}
                  </Switch>
                  <span className="text-tiny text-default-500">{t('form.checkDomainHint')}</span>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Switch
                    size="sm"
                    isSelected={form.check_dns === 1}
                    isDisabled={addonsDisabled}
                    onValueChange={(on) => patch('check_dns', on ? 1 : 0)}
                  >
                    {t('form.checkDns')}
                  </Switch>
                  <span className="text-tiny text-default-500">{t('form.checkDnsHint')}</span>
                </div>

                {/* The DNS knobs appear only while the switch is on - hiding
                    them keeps the block from growing three rows for a feature
                    the operator did not ask about. The sub-object is created
                    lazily by `patchDns`, so an untouched options_json has no
                    `dns` key at all rather than an empty one.
                    DNS 选项仅在开关开启时显示，避免未使用功能占据三行；
                    `patchDns` 按需创建嵌套块，未触及的 options_json 没有 dns 键，
                    而不是包含空对象。 */}
                {form.check_dns === 1 ? (
                  <div className="grid grid-cols-1 gap-3 border-t border-divider pt-3 sm:grid-cols-2">
                    <Select
                      items={DNS_RECORD_TYPES.map((recordType) => ({ recordType }))}
                      label={t('form.dnsRecordType')}
                      variant="bordered"
                      size="sm"
                      selectedKeys={[options.dns?.recordType ?? 'A']}
                      disallowEmptySelection
                      description={t('form.dnsRecordTypeHint')}
                      onChange={(e) =>
                        patchDns({
                          recordType: e.target.value as DnsOptions['recordType'],
                        })
                      }
                    >
                      {(item) => (
                        // Not a message key: a record type is a protocol token,
                        // the same one-to-five characters in every locale.
                        // 记录类型是各语言均相同的 1–5 字符协议标记，不是翻译键。
                        <SelectItem key={item.recordType} textValue={item.recordType}>{item.recordType}</SelectItem>
                      )}
                    </Select>

                    <Input
                      label={t('form.dnsExpected')}
                      variant="bordered"
                      size="sm"
                      value={options.dns?.expected ?? ''}
                      onValueChange={(v) => patchDns({ expected: v })}
                      description={t('form.dnsExpectedHint')}
                    />

                    <div className="sm:col-span-2">
                      <Input
                        label={t('form.dnsResolver')}
                        variant="bordered"
                        size="sm"
                        value={options.dns?.resolver ?? ''}
                        onValueChange={(v) => patchDns({ resolver: v })}
                        // The placeholder is the exact default the Worker
                        // applies, so a blank field is never a guess about
                        // which resolver answers.
                        placeholder={!selectedSource && backendSource === 'server' ? t('form.dnsSystemPlaceholder') : DEFAULT_DOH_RESOLVER}
                        description={t(!selectedSource && backendSource === 'server' ? 'form.dnsSystemHint' : 'form.dnsResolverHint')}
                      />
                    </div>
                  </div>
                ) : null}

                {/* Say which host would be inspected, so enabling a check is never
                    a guess about what it will look at.
                    说明将检查哪个主机，避免启用检查时猜测目标。 */}
                <p className="text-tiny text-default-400">
                  {addonHost ? t('form.addonTarget', { host: addonHost }) : t('form.addonNeedsHost')}
                </p>
              </div>
            )}
          </div>
        </>
      ) : null}

      {monitor ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-medium border border-divider bg-default-50 px-3 py-2.5">
          <Switch
            size="sm"
            isSelected={form.active !== 0}
            onValueChange={(on) => patch('active', on ? 1 : 0)}
          >
            {t('form.active')}
          </Switch>
          <span className="text-tiny text-default-500">{t('form.activeHint')}</span>
        </div>
      ) : null}

      {/*
        Action bar.

        The action bar sits outside the scrolling form content, keeping Save
        reachable when the drawer is taller than the viewport. `-mx-6` cancels
        the drawer body's horizontal padding; the parent supplies `pb-0` so no
        bottom padding remains. Buttons use `justify-end`, with Cancel pushed
        left by `mr-auto`, matching the right-aligned primary action in other
        dialogs such as the group modal.

        操作栏位于表单滚动内容之外，抽屉高于视口时保存按钮仍可访问。`-mx-6`
        抵消抽屉内容的水平内边距；父级使用 `pb-0`，避免底部留白。按钮使用
        `justify-end`，取消按钮通过 `mr-auto` 推向左侧，使主要操作与分组弹窗等
        其他对话框一样右对齐。
      */}
      {/*
        Geometry note. HeroUI's `DrawerBody` applies `px-6` horizontally;
        `-mx-6` lets the action bar's top border span the content box. Its
        parent sets `pb-0` (see MonitorsPage), so the bar needs no negative
        bottom margin to reach the drawer's lower edge.

        几何说明：HeroUI DrawerBody 左右使用 `px-6`；`-mx-6` 使操作栏顶部边框
        贯穿内容区。父级在 MonitorsPage 中设置 `pb-0`，因此操作栏无需负下边距
        即可到达抽屉底缘。
      */}
      </div>

      {/*
        Test result and error, *outside* the scroll box and directly above the
        action bar.

        They used to sit at the end of the scrolling content. The Test button is
        pinned in the bar at the bottom, so pressing it printed its answer several
        hundred pixels further up - off-screen whenever the form was long enough to
        scroll. That reads as "the test did nothing". Keeping the answer next to
        the button that produced it is the whole point of printing it.

        测试结果和错误放在滚动框外、操作栏正上方。此前结果在滚动内容末尾，而测试按钮
        固定在底部；长表单中结果会出现在上方数百像素的屏幕外，看起来像测试无反应。
        显示结果的目的就是让它靠近产生结果的按钮。
      */}
      <div className="-mx-6 border-t border-[var(--polaris-line)] bg-[var(--polaris-card)]">
      <MonitorCheckFeedback pending={testing} result={result} error={error} onDismiss={() => { setResult(null); setError(null); }} />
      <div className="flex flex-wrap items-center justify-end gap-2 px-6 py-4">
        {onCancel ? (
          <Button variant="light" onPress={onCancel} className="mr-auto">
            {t('action.cancel')}
          </Button>
        ) : null}

        {/*
          Hidden for agent sources: the check endpoint has no way to reach an
          agent synchronously - it would have to enqueue a job and wait for the
          next poll - so it only ever answered "result not available yet". A
          button that cannot do what its label says is worse than no button.

          Also hidden for `agent` and `push` monitor *types*. Neither has an
          active probe: `runCheck` (src/lib/check/run.ts) refuses both outright and
          answers DOWN with `latencyMs: 0`. Printing that as the answer to "Run a
          test" is a false failure - it reported a red 0ms for a monitor that was
          healthy and simply never checked. An agent monitor's health comes from
          its daemon's reports and a push monitor's from its heartbeat; neither
          can be provoked from this drawer.

          Agent 探测来源隐藏测试按钮：检查端点不能同步触达 Agent，只能排队并等待下一次
          轮询，因此只会答“结果尚不可用”，无法履行按钮的含义。Agent 和 Push 监控类型
          也隐藏：二者没有主动探测，`runCheck` 会直接拒绝并返回 DOWN、latencyMs: 0；
          把它作为测试结果会给健康但不主动检查的监控项显示错误的红色 0ms。
          Agent 健康来自守护进程上报，Push 来自心跳，均不能从抽屉触发。
        */}
        {selectedSource || form.type === 'agent' || form.type === 'push' ? null : (
          <Button
            variant="flat"
            startContent={
              testing ? <Loader2 className="animate-spin" size={15} /> : <FlaskConical size={15} />
            }
            onPress={handleTest}
            isDisabled={!canSubmit || testing}
          >
            {testing ? t('action.testing') : t('action.test')}
          </Button>
        )}

        <Button
          color="primary"
          startContent={saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
          onPress={handleSave}
          isDisabled={!canSubmit || testing}
        >
          {saving ? t('action.saving') : t('action.save')}
        </Button>
      </div>
      </div>
    </div>
  );
}

