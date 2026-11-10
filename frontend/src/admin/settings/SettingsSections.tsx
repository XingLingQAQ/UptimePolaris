import { settingsApi } from '@/admin/settings/api';
import { useBackendCapabilities } from '@/api/backend';
import { ApiError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { APP_VERSION } from '@/lib/version';
import { useLocation } from 'react-router';
import { Button, Input, Switch, Textarea } from '@heroui/react';
import clsx from 'clsx';
import {
  Activity,
  AlertTriangle,
  Check,
  Clock,
  Cloud,
  Database,
  Globe,
  History,
  Loader2,
  RotateCcw,
  Server,
  ShieldCheck,
  Tag,
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { mutate } from 'swr';
import { Meter } from '../../components/ui/MetricMeters';
import type { Hue } from '../../types/tone';
import { Panel, PanelHeader } from '../components/Panel';
import { formatCompact } from '../format';
import { SiteIconUpload } from './SiteIconUpload';
import { MaintenanceWindowEditor } from './MaintenanceWindowEditor';
import { MotionPreferenceControl } from './MotionPreferenceControl';
import { useReducedMotion } from '@/lib/useReducedMotion';
import type { MaintenanceWindow, SettingSpec, UsageReport } from './types';

/** The groups, in the order the page presents them. / 设置分组，按页面展示顺序排列。 */
export const SETTING_GROUPS = [
  'presentation',
  'site',
  'monitor',
  'retention',
  'maintenance',
  'security',
  'system',
  'operations',
  'migration',
  'account',
  'events',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** Each group's marker, shared by the rail and the panel it scrolls to. / 各分组的标记，由导航栏及目标面板共用。 */
const GROUP_ICON: Record<SettingGroup, { icon: LucideIcon; hue: Hue }> = {
  presentation: { icon: Globe, hue: 'primary' },
  site: { icon: Globe, hue: 'primary' },
  monitor: { icon: Activity, hue: 'cyan' },
  retention: { icon: Database, hue: 'indigo' },
  maintenance: { icon: Clock, hue: 'amber' },
  security: { icon: ShieldCheck, hue: 'success' },
  system: { icon: Server, hue: 'default' },
  operations: { icon: Wrench, hue: 'violet' },
  migration: { icon: Database, hue: 'indigo' },
  account: { icon: UserRound, hue: 'pink' },
  events: { icon: History, hue: 'primary' },
};

/** Groups that hold no writable setting and therefore take no part in auto-save. / 不含可写设置的分组，不参与自动保存。 */
const READ_ONLY_GROUPS: readonly SettingGroup[] = ['presentation', 'system', 'operations', 'migration', 'account', 'events'];

/**
 * Which settings belong to which group.
 *
 * Declared here rather than on the server so the grouping is a presentation
 * decision that can be reorganised without a migration or an API change - the
 * registry in `settings.ts` owns validity and defaults, not layout.
 *
 * 设置归组在此前端声明，而非服务器声明，使分组作为展示决策可重排而无需迁移或修改 API；
 * `settings.ts` 注册表负责有效性和默认值，不负责布局。
 */
const GROUP_KEYS: Record<SettingGroup, string[]> = {
  presentation: [],
  site: ['site.title', 'site.description', 'site.icon', 'site.syncMonitorIcons'],
  monitor: ['monitor.defaultIntervalSec', 'monitor.defaultTimeoutMs', 'monitor.defaultRetries'],
  retention: ['retention.availabilityDays', 'retention.detailDays', 'retention.eventDays'],
  maintenance: ['maintenance.enabled','maintenance.scheduleEnabled','alerts.maintenanceWindows','maintenance.announcementTitle','maintenance.announcementDescription','maintenance.title','maintenance.description'],
  security: [
    'security.sessionTtlDays',
    'security.loginMaxAttempts',
    'security.loginWindowSec',
    'security.allowAgentCommands',
  ],
  // These three render their own content rather than a list of settings. / 这三个分组渲染自己的内容，而非设置列表。
  system: [],
  operations: [],
  migration: [],
  account: [],
  events: [],
};

/** Anchored setting groups with debounced, serialized saves; operation and account groups provide their own controls. / 锚点设置分组使用防抖及串行保存；操作和账户分组提供自己的控件。 */
export function SettingsSections({
  groups,
  renderGroup,
}: {
  groups: readonly SettingGroup[];
  /** Custom content for groups without registry-driven controls. / 没有注册表驱动控件的分组所使用的自定义内容。 */
  renderGroup?: (group: SettingGroup) => ReactNode;
}) {
  const t = useTranslations('admin.settings');
  const backend = useBackendCapabilities();
  const location = useLocation();
  const reduced = useReducedMotion();
  const apiErrorMessage = useApiErrorMessage();
  const [specs, setSpecs] = useState<SettingSpec[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [invalid, setInvalid] = useState<Array<{ key: string; reason: string }>>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const draftRef = useRef(draft);
  const draftVersions = useRef(new Map<string, number>());
  const invalidDrafts = useRef(new Set<string>());
  const pendingSaves = useRef(new Map<SettingGroup, Promise<void>>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [savingGroups, setSavingGroups] = useState(new Set<SettingGroup>());
  const [savedAt, setSavedAt] = useState<SettingGroup | null>(null);
  const [saveError, setSaveError] = useState<Partial<Record<SettingGroup, string>>>({});
  const [activeGroup, setActiveGroup] = useState<SettingGroup>(groups[0]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await settingsApi.listSettings();
      setSpecs(response.specs);
      setValues(response.values);
      setInvalid(response.invalid);
      draftRef.current = {};
      setDraft({});
      setError(null);
    } catch (error) {
      setError(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    Scroll-spy for the group rail.

    `IntersectionObserver` rather than a scroll handler: the observer fires only
    when a section actually crosses the line, so there is no work per scroll
    event on a page with six tall sections.

    分组导航的滚动监听使用 IntersectionObserver 而非 scroll 处理器；只有区段越过
    指定线时才触发，避免包含六个长区段的页面在每次滚动事件中都执行工作。
  */
  useEffect(() => {
    if (loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) {
          const id = visible.target.id.replace('settings-', '') as SettingGroup;
          if (groups.includes(id)) setActiveGroup(id);
        }
      },
      // The band excludes the sticky header, so a section counts as current once
      // it reaches reading position rather than when it first peeks in.
      // 判定区间排除吸顶页头，使区段到达阅读位置而非刚露出时才成为当前区段。
      { rootMargin: '-88px 0px -70% 0px', threshold: 0 },
    );
    for (const group of groups) {
      const node = document.getElementById(`settings-${group}`);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [groups, loading]);

  const specByKey = useMemo(() => new Map(specs.map((spec) => [spec.key, spec])), [specs]);

  /** The effective value: a draft edit if present, else what the server returned. / 当前生效显示值：优先使用草稿，否则使用服务器返回值。 */
  const valueOf = (key: string): unknown => (key in draft ? draft[key] : values[key]);

  const isDirty = (group: SettingGroup): boolean =>
    GROUP_KEYS[group].some((key) => key in draft && draft[key] !== values[key]);

  const isReadOnly = (group: SettingGroup): boolean => READ_ONLY_GROUPS.includes(group);

  const setValue = (key: string, value: unknown) => {
    draftVersions.current.set(key, (draftVersions.current.get(key) ?? 0) + 1);
    draftRef.current = { ...draftRef.current, [key]: value };
    setDraft(draftRef.current);
  };

  const timers = useRef(new Map<SettingGroup, ReturnType<typeof setTimeout>>());
  // 同组保存串行执行；版本变化的草稿不能被较早请求清除。
  // Serialize saves per group; earlier requests cannot clear newer draft revisions.
  const save = useCallback((group: SettingGroup): Promise<void> => {
    const payload: Record<string, unknown> = {};
    const versions = new Map<string, number | undefined>();
    for (const key of GROUP_KEYS[group]) {
      if (key in draftRef.current && !invalidDrafts.current.has(key)) {
        payload[key] = draftRef.current[key];
        versions.set(key, draftVersions.current.get(key));
      }
    }
    const previous = pendingSaves.current.get(group) ?? Promise.resolve();
    const task = previous.then(async () => {
      for (const key of Object.keys(payload)) {
        if (draftVersions.current.get(key) !== versions.get(key)) delete payload[key];
      }
      if (Object.keys(payload).length === 0) return;

      setSavingGroups((groups) => new Set(groups).add(group));
      try {
        const result = await settingsApi.updateSettings(payload);
        setValues((previous) => ({ ...previous, ...Object.fromEntries(Object.keys(payload).map((key) => [key, result.values[key]])) }));
        setSpecs((previous) => previous.map((spec) => spec.key in payload ? { ...spec, stored: true } : spec));
        const remaining = { ...draftRef.current };
        for (const key of Object.keys(payload)) {
          if (draftVersions.current.get(key) === versions.get(key) && Object.is(remaining[key], payload[key])) delete remaining[key];
        }
        draftRef.current = remaining;
        setDraft(remaining);
        setSavedAt(group);
        setSaveError(previous => ({ ...previous, [group]: undefined }));
        if (group === 'maintenance') void mutate('/api/public/maintenance');
      } catch (error) {
        if (error instanceof ApiError && error.code === 'invalid_settings' && Array.isArray(error.details?.failures)) {
          const fields = (error.details.failures as Array<{ key: string }>).map(({ key }) => LABELS[key] ? t(LABELS[key].label) : key).join(', ');
          setSaveError(previous => ({ ...previous, [group]: t('invalidFields', { fields }) }));
        } else setSaveError(previous => ({ ...previous, [group]: apiErrorMessage(error) }));
      } finally {
        setSavingGroups((groups) => {
          const remaining = new Set(groups);
          remaining.delete(group);
          return remaining;
        });
      }
    });
    pendingSaves.current.set(group, task);
    void task.finally(() => {
      if (pendingSaves.current.get(group) === task) pendingSaves.current.delete(group);
    });
    return task;
  }, [t, apiErrorMessage]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const schedule = (group: SettingGroup) => {
    const existing = timers.current.get(group);
    if (existing) clearTimeout(existing);
    timers.current.set(
      group,
      setTimeout(() => {
        timers.current.delete(group);
        void save(group);
      }, 600),
    );
  };

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const [group, timer] of map) { clearTimeout(timer); void saveRef.current(group); }
      map.clear();
    };
  }, []);

  const change = (group: SettingGroup, key: string, value: unknown) => {
    invalidDrafts.current.delete(key);
    setValue(key, value);
    setSavedAt(previous => previous === group ? null : previous);
    setSaveError(previous => ({ ...previous, [group]: undefined }));
    schedule(group);
  };

  const invalidate = (group: SettingGroup, key: string) => {
    invalidDrafts.current.add(key);
    draftVersions.current.set(key, (draftVersions.current.get(key) ?? 0) + 1);
    setSavedAt(previous => previous === group ? null : previous);
    if (!GROUP_KEYS[group].some(item => item in draftRef.current && !invalidDrafts.current.has(item))) {
      clearTimeout(timers.current.get(group));
      timers.current.delete(group);
    }
  };

  /** Drop an override so the key falls back to its declared default. / 删除覆盖值，使该键回退到声明的默认值。 */
  const reset = (key: string): Promise<void> => {
    invalidDrafts.current.delete(key);
    draftVersions.current.set(key, (draftVersions.current.get(key) ?? 0) + 1);
    const group = groups.find((group) => GROUP_KEYS[group].includes(key))!;
    const timer = timers.current.get(group);
    if (timer) clearTimeout(timer);
    timers.current.delete(group);
    const remaining = { ...draftRef.current };
    delete remaining[key];
    draftRef.current = remaining;
    setDraft(remaining);

    const previous = pendingSaves.current.get(group) ?? Promise.resolve();
    const task = previous.then(async () => {
      setSavingGroups((groups) => new Set(groups).add(group));
      try {
        const result = await settingsApi.resetSetting(key);
        setValues((prev) => ({ ...prev, [key]: result.value }));
        setSpecs((prev) => prev.map((spec) => (spec.key === key ? { ...spec, stored: false } : spec)));
        setSavedAt(group);
        setSaveError(previous => ({ ...previous, [group]: undefined }));
        if (group === 'maintenance') void mutate('/api/public/maintenance');
      } catch {
        toast.error(t('resetFailed'));
      } finally {
        setSavingGroups((groups) => {
          const remaining = new Set(groups);
          remaining.delete(group);
          return remaining;
        });
      }
    });
    pendingSaves.current.set(group, task);
    void task.finally(() => {
      if (pendingSaves.current.get(group) === task) pendingSaves.current.delete(group);
    });
    if (GROUP_KEYS[group].some((item) => item in remaining)) schedule(group);
    return task;
  };

  useEffect(() => {
    if (loading) return;
    const id = location.hash.slice(1);
    if (!id.startsWith('settings-')) return;
    const group = id.replace('settings-', '') as SettingGroup;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
      if (groups.includes(group)) setActiveGroup(group);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [groups, loading, location.hash, location.key]);

  const jumpTo = (group: SettingGroup) => {
    document.getElementById(`settings-${group}`)?.scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' });
    setActiveGroup(group);
  };

  if (error) {
    return (
      <Panel>
        <p className="flex items-center gap-2 text-small text-danger">
          <AlertTriangle size={15} className="shrink-0" />
          {apiErrorMessage(error)}
          <Button size="sm" variant="light" color="danger" onPress={() => void load()}>
            {t('retrySave')}
          </Button>
        </p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
      {/*
        The group rail.

        Sticky on wide screens so the group list stays reachable while reading a
        long section; horizontal and scrollable below `lg`, where a fixed rail
        would take width the sections need. Only groups that actually render are
        listed, so a group with no settings never appears as an empty page.

        分组导航在宽屏吸顶，方便阅读长区段时切换；小于 lg 时改为水平可滚动，
        避免固定侧栏占用内容宽度。仅列出实际渲染的分组，空分组不会出现为空白页面。
      */}
      <nav
        aria-label={t('title')}
        className="tab-scroll-list sticky top-14 z-10 -mx-1 flex gap-1 overflow-x-auto bg-[var(--polaris-panel)] px-1 py-1 lg:top-6 lg:mx-0 lg:w-48 lg:shrink-0 lg:flex-col lg:overflow-visible lg:bg-transparent lg:px-0 lg:py-0"
      >
        {groups.map((group) => {
          const Icon = GROUP_ICON[group].icon;
          const active = activeGroup === group;
          return (
            <button
              key={group}
              type="button"
              onClick={() => jumpTo(group)}
              aria-current={active ? 'true' : undefined}
              className={clsx(
                'flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] whitespace-nowrap transition-colors',
                active
                  ? 'bg-[var(--polaris-active)] font-medium text-[var(--polaris-ink)]'
                  : 'text-[var(--polaris-ink-2)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]',
              )}
            >
              <Icon size={15} className={active ? 'text-[var(--polaris-ink)]' : 'text-[var(--polaris-ink-4)]'} />
              {t(`group${group[0].toUpperCase()}${group.slice(1)}`)}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-5">
        {loading
          ? groups.map((group) => (
              <Panel key={group}>
                <PanelHeader title={t(`group${group[0].toUpperCase()}${group.slice(1)}`)} />
                <div className="flex flex-col gap-3">
                  <div className="h-12 animate-pulse rounded-medium bg-default-100" />
                  <div className="h-12 animate-pulse rounded-medium bg-default-100" />
                </div>
              </Panel>
            ))
          : groups.map((group) => (
              <section key={group} id={`settings-${group}`} className="scroll-mt-6">
                <Panel>
                  <PanelHeader
                    icon={(() => {
                      const Icon = GROUP_ICON[group].icon;
                      return <Icon />;
                    })()}
                    hue={GROUP_ICON[group].hue}
                    title={t(`group${group[0].toUpperCase()}${group.slice(1)}`)}
                    description={t(`group${group[0].toUpperCase()}${group.slice(1)}Desc`)}
                  />

                  {invalid.length > 0 ? (
                    <p className="mb-4 flex items-start gap-2 rounded-medium border border-warning/30 bg-warning/10 px-3 py-2 text-tiny text-warning">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>
                        {t('invalidStored')}: {invalid.map((row) => row.key).join(', ')}
                      </span>
                    </p>
                  ) : null}

                  {isReadOnly(group) ? (
                    <div className="flex flex-col gap-4">{renderGroup?.(group)}</div>
                  ) : (
                  <div className="flex flex-col gap-4">
                    {group === 'maintenance' ? renderGroup?.(group) : null}
                    {GROUP_KEYS[group].filter(key => {
                      if(group !== 'maintenance')return true;
                      if(key==='maintenance.announcementTitle'||key==='maintenance.announcementDescription')return valueOf('maintenance.scheduleEnabled')===true;
                      if(key==='alerts.maintenanceWindows')return valueOf('maintenance.scheduleEnabled')===true;
                      if(key==='maintenance.title'||key==='maintenance.description')return valueOf('maintenance.enabled')===true||valueOf('maintenance.scheduleEnabled')===true;
                      return true;
                    }).map((key) => {
                      const spec = specByKey.get(key);
                      if (!spec) return null;
                      return (
                        <SettingField
                          key={key}
                          spec={spec}
                          value={valueOf(key)}
                          t={t}
                          minimumIntervalSec={backend.data?.monitoring.minimumIntervalSec ?? 60}
                          onChange={(next) => change(group, key, next)}
                          onInvalid={() => invalidate(group, key)}
                          onReset={() => void reset(key)}
                        />
                      );
                    })}
                  </div>
                  )}

                  {group === 'system' ? <SystemFacts t={t} /> : null}
                  {group === 'site' ? <MotionPreferenceControl /> : null}

                  {/*
                    Save status, not a save button.

                    The group commits itself; this line is the only place that
                    says whether the value on screen is what the server holds.

                    显示保存状态而非保存按钮：分组自行提交，此行说明屏幕上的值
                    是否与服务器持有的值一致。
                  */}
                  {!isReadOnly(group) && (savingGroups.has(group) || isDirty(group) || savedAt === group || saveError[group]) ? (
                    <GroupSaveStatus error={saveError[group]} saving={savingGroups.has(group)} saved={savedAt === group} onRetry={() => void save(group)} />
                  ) : null}
                </Panel>
              </section>
            ))}
      </div>
    </div>
  );
}

/** LABELS supplies copy; the spec kind selects the control. Both must be updated when adding a setting. / LABELS 提供文案，spec kind 选择控件；新增设置时两者都须更新。 */
function SettingField({
  spec,
  value,
  t,
  minimumIntervalSec,
  onChange,
  onReset,
  onInvalid,
}: {
  spec: SettingSpec;
  value: unknown;
  t: ReturnType<typeof useTranslations<'admin.settings'>>;
  minimumIntervalSec: number;
  onChange: (value: unknown) => void;
  onReset: () => void;
  onInvalid: () => void;
}) {
  const labelKey = LABELS[spec.key];
  if (!labelKey) return null;
  const label = t(labelKey.label);
  const hint = labelKey.hint ? t(labelKey.hint, { min: minimumIntervalSec }) : undefined;

  /* Labels and controls share columns on wider screens. / 宽屏时标签和控件按列对齐。 */
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2 border-b border-[var(--polaris-line-soft)] py-4 first:pt-1 last:border-0 last:pb-0 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span id={`setting-label-${spec.key}`} className="text-small font-medium">{label}</span>
          {/*
            An inherited value is marked, not hidden.

            The difference between "the operator chose 60" and "nobody has chosen"
            matters when the default later changes - an unmarked field would make a
            future default change look like it did nothing.

            继承值要标记而非隐藏：“操作人员选择了 60”与“从未选择”不同；
            否则默认值将来变化时，未标记的字段会让变化看起来没有生效。
          */}
          {!spec.stored ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-md bg-default-100 px-1.5 text-[11px] text-default-500">
              <Tag size={10} aria-hidden="true" />
              {t('inherited')}
            </span>
          ) : null}
        </div>
        {hint && spec.kind !== 'boolean' ? (
          <span className="text-tiny leading-snug text-default-500">{hint}</span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          {spec.kind === 'boolean' ? (
            <Switch size="sm" aria-labelledby={`setting-label-${spec.key}`} aria-describedby={hint ? `setting-hint-${spec.key}` : undefined} isSelected={value === true} onValueChange={(v) => onChange(v)}>
              <span id={`setting-hint-${spec.key}`} className="text-tiny text-default-500">{hint}</span>
            </Switch>
          ) : spec.kind === 'list' ? (
            <MaintenanceWindowEditor
              windows={Array.isArray(value) ? (value as MaintenanceWindow[]) : []}
              onChange={onChange}
              onInvalid={onInvalid}
            />
          ) : (spec.key === 'maintenance.description' || spec.key === 'maintenance.announcementDescription') ? (
            <Textarea size="sm" aria-label={label} value={typeof value==='string'?value:''} onValueChange={onChange} minRows={3} maxLength={1000}/>
          ) : spec.kind === 'number' ? (
            <Input
              type="number"
              aria-label={label}
              size="sm"
              className="text-tiny [&_input]:text-tiny"
              value={value === null || value === undefined ? '' : String(value)}
              onValueChange={(next) => onChange(next === '' ? null : Number(next))}
            />
          ) : (
            <div className="flex min-w-0 flex-col gap-2.5">
              <Input
                size="sm"
                aria-label={label}
                className="text-tiny [&_input]:text-tiny"
                value={typeof value === 'string' ? value : ''}
                onValueChange={onChange}
              />
              {/*
                The icon setting carries two ways to answer the same question.

                The field above is the address a page points at, which may be an
                external URL; the control below stores bytes in this deployment.
                Only `site.icon` needs both, and keying off the setting name keeps
                that exception to one line instead of a second `kind` that every
                other setting would have to ignore.

                图标设置提供两种方式：上方字段填写页面指向的地址（可为外部 URL），
                下方控件将字节存入当前部署。只有 `site.icon` 同时需要两者；
                按设置名判断可将特例限制为一行，避免新增让其他设置都必须忽略的 kind。
              */}
              {spec.key === 'site.icon' ? <SiteIconUpload /> : null}
            </div>
          )}
        </div>
        {spec.stored ? (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="shrink-0 text-default-400"
            aria-label={t('resetOne')}
            onPress={onReset}
          >
            <RotateCcw size={14} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Display configuration sources; bindings and password-hashing cost are changed at deployment. / 显示配置来源；绑定和密码哈希成本在部署时修改。 */
function SystemFacts({ t }: { t: ReturnType<typeof useTranslations<'admin.settings'>> }) {
  const backend = useBackendCapabilities();
  /** Deployment-observed usage; no measurements are shown until a report loads. / 部署环境观测到的用量；报告加载前不显示测量值。 */
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [usageError, setUsageError] = useState(false);
  useEffect(() => {
    let alive = true;
    settingsApi.usage()
      .then((report) => alive && setUsage(report))
      .catch(() => alive && setUsageError(true));
    return () => {
      alive = false;
    };
  }, []);
  if (backend.data?.runtime === 'go') {
    const runtime = usage?.runtime;
    return <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[
          [t('factRuntime'), runtime?.goVersion ?? 'Go'],
          [t('runtimeUptime'), runtime ? `${Math.floor(runtime.uptimeSeconds / 60)} min` : '—'],
          [t('runtimeMemory'), runtime ? `${(runtime.heapAllocBytes / 1024 / 1024).toFixed(1)} MiB` : '—'],
          [t('runtimeTasks'), runtime ? String(runtime.goroutines) : '—'],
          [t('runtimeDatabase'), runtime?.database.type === 'postgres' ? 'PostgreSQL' : runtime ? 'SQLite' : '—'],
          [t('runtimeThemeStorage'), t('runtimeFilesystem')],
        ].map(([label, value]) => <div key={label} className="polaris-well px-3.5 py-3"><p className="text-tiny text-default-500">{label}</p><p className="mt-1 text-small font-semibold">{value}</p></div>)}
      </div>
      {!runtime ? <p role="status" className="text-small text-default-500">{t(usageError ? 'usageUnavailable' : 'usageLoading')}</p> : null}
    </div>;
  }
  const facts: Array<[string, string]> = [
    [t('readOnly'), t('readOnlyHint')],
    ['PBKDF2_ITERATIONS', 'wrangler.toml'],
    ['DATABASE_TYPE', 'wrangler.toml'],
    ['ADMIN_TOKEN', 'wrangler secret'],
    ['CF_API_TOKEN', 'wrangler secret'],
  ];
  // Missing usage is unknown, not zero consumption. / 缺少用量数据表示未知，而不是零消耗。
  const meters = usage
    ? [
        { label: t('usageReads'), used: usage.d1RowsRead, limit: usage.limits.d1RowsRead },
        { label: t('usageWrites'), used: usage.d1RowsWritten, limit: usage.limits.d1RowsWritten },
        { label: t('usageSubrequests'), used: usage.peakSubrequests, limit: usage.limits.subrequests },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { icon: <Tag size={15} />, label: t('factVersion'), value: `v${APP_VERSION}` },
          { icon: <Cloud size={15} />, label: t('factRuntime'), value: 'Cloudflare Workers' },
          { icon: <Clock size={15} />, label: t('factCadence'), value: t('factCadenceValue') },
        ].map((fact) => (
          <div key={fact.label} className="polaris-well flex items-center gap-3 px-3.5 py-3">
            <span className="text-default-400">{fact.icon}</span>
            <div className="min-w-0">
              <p className="text-[11px] text-default-400">{fact.label}</p>
              <p className="truncate text-small font-semibold">{fact.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Today's consumption, observed by this deployment. The Worker records
          every tick's D1 metadata into `usage_daily`; the figures are measured,
          not read from a quota API, which is why the footer names the day.
          本部署观测到的今日消耗：Worker 将每次 tick 的 D1 元数据记录到 `usage_daily`；
          数据是实测值而非配额 API 返回值，因此页脚标明日期。 */}
      <div className="polaris-well px-3.5 py-3.5">
        <div className="mb-3 flex items-center gap-2">
          <p className="text-tiny font-semibold">{t('usageTitle')}</p>
          {usage ? <span className="ml-auto text-[11px] text-default-400">{t(usage.plan === 'paid' ? 'usageHintPaid' : 'usageHint')}</span> : null}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {meters.map((meter) => {
            const pct = (meter.used / meter.limit) * 100;
            return (
              <div key={meter.label} className="flex flex-col gap-1.5">
                <p className="flex items-baseline justify-between gap-2 text-[11px] text-default-500">
                  <span className="truncate">{meter.label}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-semibold text-foreground">{formatCompact(meter.used)}</span> / {formatCompact(meter.limit)}
                  </span>
                </p>
                <Meter value={pct} tone={pct >= 90 ? 'down' : pct >= 70 ? 'warn' : 'primary'} />
              </div>
            );
          })}
        </div>
        {/* Observed reports distinguish zero recorded ticks from an unavailable usage response. / 观测报告区分没有记录到 tick 和用量响应不可用。 */}
        <p className="mt-3 text-[11px] text-default-400 tabular-nums">
          {usage
            ? usage.observed
              ? t('usageFooter', {
                  day: usage.day,
                  ticks: usage.ticks,
                  statements: usage.statements.toLocaleString(),
                })
              : t('usageNoTicks', { day: usage.day })
            : t(usageError ? 'usageUnavailable' : 'usageLoading')}
        </p>
      </div>

      <div className="polaris-well polaris-divide overflow-hidden">
        {facts.map(([name, source]) => (
          <div key={name} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="font-mono text-[11.5px] text-default-600">{name}</span>
            <span className="ml-auto text-[11px] text-default-400">{source}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Label and hint keys per setting.
 *
 * A map rather than derived from the setting key: the labels are prose an
 * operator reads ("Default check interval (s)"), while the keys are storage names
 * ("monitor.defaultIntervalSec"). Deriving one from the other produces either
 * unreadable labels or storage keys that no longer describe their contents.
 *
 * 每个设置的标签和提示键使用映射而非从设置键推导：标签是操作人员阅读的文案
 *（例如“默认检查间隔（秒）”），键是存储名称（例如 `monitor.defaultIntervalSec`）；
 * 相互推导会产生难读的标签，或使存储键无法准确描述其内容。
 */
const LABELS: Record<string, { label: string; hint?: string }> = {
  'site.title': { label: 'siteTitle', hint: 'siteTitleHint' },
  'site.description': { label: 'siteDescription', hint: 'siteDescriptionHint' },
  'site.icon': { label: 'siteIcon', hint: 'siteIconHint' },
  'site.syncMonitorIcons': { label: 'syncMonitorIcons', hint: 'syncMonitorIconsHint' },
  'monitor.defaultIntervalSec': { label: 'defaultInterval', hint: 'defaultIntervalHint' },
  'monitor.defaultTimeoutMs': { label: 'defaultTimeout', hint: 'defaultTimeoutHint' },
  'monitor.defaultRetries': { label: 'defaultRetries', hint: 'defaultRetriesHint' },
  'retention.availabilityDays': { label: 'retainAvailability', hint: 'retainAvailabilityHint' },
  'retention.detailDays': { label: 'retainDetail', hint: 'retainDetailHint' },
  'retention.eventDays': { label: 'retainEvents', hint: 'retainEventsHint' },
  'alerts.maintenanceWindows': { label: 'maintenanceWindows' },
  'maintenance.enabled': {label:'maintenanceManual',hint:'maintenanceManualAutoHint'},
  'maintenance.scheduleEnabled': {label:'maintenanceScheduled',hint:'maintenanceScheduledAutoHint'},
  'maintenance.announcementTitle': {label:'maintenanceAnnouncementTitle',hint:'maintenanceAnnouncementHint'},
  'maintenance.announcementDescription': {label:'maintenanceAnnouncementDescription'},
  'maintenance.title': {label:'maintenanceTitle',hint:'maintenanceTitleHint'},
  'maintenance.description': {label:'maintenanceDescription',hint:'maintenanceContentHint'},
  'alerts.maintenanceNote': { label: 'maintenanceNote', hint: 'maintenanceNoteHint' },
  'security.sessionTtlDays': { label: 'sessionTtl', hint: 'sessionTtlHint' },
  'security.loginMaxAttempts': { label: 'loginAttempts', hint: 'loginAttemptsHint' },
  'security.loginWindowSec': { label: 'loginWindow', hint: 'loginWindowHint' },
  'security.allowAgentCommands': { label: 'allowCommands', hint: 'allowCommandsHint' },
};

function GroupSaveStatus({ error, saving, saved, onRetry }: {
  error?: string;
  saving: boolean;
  saved: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('admin.settings');
  return (<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-divider/60 pt-3">
    {error ? (
      <>
        <AlertTriangle size={14} className="shrink-0 text-danger" />
        <span className="text-tiny text-danger">{error}</span>
        <Button
          size="sm"
          variant="light"
          color="danger"
          className="ml-auto text-tiny"
          onPress={onRetry}
        >
          {t('retrySave')}
        </Button>
      </>
    ) : saving ? (
      <>
        <Loader2 size={14} className="animate-spin text-default-400" />
        <span className="text-tiny text-default-500">{t('saving')}</span>
      </>
    ) : saved ? (
      <>
        <Check size={14} className="text-success" />
        <span className="text-tiny text-success">{t('saved')}</span>
      </>
    ) : (
      <span className="text-tiny text-default-500">{t('unsavedHint')}</span>
    )}
  </div>);
}
