import { useMotionList } from '@/lib/useMotionList';
import { Drawer, Modal, Select } from '@/components/ui/MotionOverlays';
import { notificationsApi } from '@/admin/notifications/api';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { locales } from '@/i18n/config';
import { useLocale } from '@/i18n/IntlProvider';
import { defaultNotificationLanguage, isNotificationLanguage, resolveNotificationLanguage, type NotificationLanguage } from '../../../../shared/notification-language';
import {
  Button,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Input,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  SelectItem,
  Skeleton,
  Switch,
} from '@heroui/react';
import clsx from 'clsx';
import {
  BellRing,
  CircleCheck,
  Info,
  Loader2,
  Pencil,
  Plus,
  Send,
  Timer,
  Trash2
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { Meter } from '../../components/ui/MetricMeters';
import { useTimeAgo } from '../../hooks/useTimeAgo';
import { EmptyState } from '../components/ConsolePrimitives';
import { IconTile } from '../components/IconTile';
import { BellArt } from '../components/illustrations';
import { Panel, PanelHeader } from '../components/Panel';
import { StatBand, StatCell } from '../components/SummaryStats';
import { formatMs, formatPercent } from '../format';
import { groupsApi } from '../groups/api';
import type { MonitorGroup } from '../groups/types';
import { monitorsApi } from '../monitors/api';
import { StatusPill } from '../monitors/MonitorIndicators';
import { ProviderLogo } from './ProviderLogo';
import { NOTIFICATION_META, notificationFieldRequired } from './providers';
import type { ChannelDeliveryStats, DeliveryRecord, NotificationChannel, NotificationInput, NotificationType } from './types';

const messageLanguages = locales.filter(({ key }) => isNotificationLanguage(key));

/** Read the channel's group UUIDs; an empty scope accepts all monitors. / 读取渠道的分组 UUID；空范围接收所有监控项。 */
function scopeIds(channel: NotificationChannel): string[] {
  return Array.isArray(channel.group_ids) ? channel.group_ids : [];
}

/**
 * Notification channels driven by NOTIFICATION_META.
 *
 * `header` controls the title block: `panel` draws title, description and Add;
 * `toolbar` only Add (the page header already states the rest); `none` nothing.
 * `toolbar` exists so the dedicated page does not print the same words twice.
 * `header` 控制标题区；toolbar 模式只留添加按钮，避免页面标题重复。
 */
export function NotificationsPanel({ header = 'panel' }: { header?: 'panel' | 'toolbar' | 'none' }) {
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const cards = useMotionList<HTMLUListElement>();
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);
  const [creating, setCreating] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NotificationChannel | null>(null);
  /** Group vocabulary for the scope picker and row labels. / 范围选择器和行标签使用的分组词表。 */
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  /** Monitors filed under no group, which a scoped channel therefore never sees. / 未分组监控项；指定分组范围的渠道不会接收它们。 */
  const [ungrouped, setUngrouped] = useState(0);
  /** Observed attempts in the last 24 hours; absent channels have no recorded attempts in that window. / 过去 24 小时观测到的发送尝试；缺失的渠道在该时段无记录。 */
  const [stats, setStats] = useState<Record<string, ChannelDeliveryStats> | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [logRevision, setLogRevision] = useState(0);
  const formSession = useRef(0);

  /** Initial provider when the operator picked one from the empty-state gallery. / 从空状态画廊选择时新建渠道的初始提供商。 */
  const [initialType, setInitialType] = useState<NotificationType | null>(null);
  /** Open the form for a new channel. Shared by every mode's Add button. / 打开新渠道表单，供各模式的添加按钮共用。 */
  const startCreate = (type?: NotificationType) => {
    formSession.current++;
    setEditing(null);
    setCreating(true);
    setInitialType(type ?? null);
    setFormOpen(true);
  };

  /** Load channel data and scope vocabularies together; delivery statistics may fail independently. / 一起加载渠道数据和范围词表；发送统计可独立失败。 */
  const load = useCallback(async () => {
    try {
      const [{ channels: rows }, { groups: groupRows }, { monitors }, deliveryStats] = await Promise.all([
        notificationsApi.listNotifications(),
        groupsApi.listGroups(),
        monitorsApi.listMonitors(),
        // Delivery stats are separate because they change per send; a failure degrades to no figures. / 投递统计单独加载；失败时显示无数据。
        notificationsApi.notificationStats().catch(() => null),
      ]);
      setChannels(rows);
      setGroups(groupRows);
      setUngrouped(monitors.filter((m) => !m.group_id).length);
      setStats(deliveryStats?.channels ?? null);
      setStatsError(!deliveryStats);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const result = await notificationsApi.notificationStats();
      setStats(result.channels);
      setStatsError(false);
    } catch {
      setStats(null);
      setStatsError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Groups by id for row scope labels. / 按 ID 索引分组，供行范围标签使用。 */
  const groupName = useMemo(() => {
    const byId = new Map(groups.map((g) => [g.id, g.name]));
    // A deleted group keeps its id in the row: ugly but truer than hiding the scope. / 已删除分组保留 ID：不好看，但比隐藏范围更真实。
    return (id: string) => byId.get(id) ?? id;
  }, [groups]);

  /** Warn only when a scoped channel exists and some monitor is ungrouped. / 仅当存在限定渠道且有未分组监控时警告。 */
  const showUngroupedWarning =
    ungrouped > 0 && (channels ?? []).some((c) => scopeIds(c).length > 0);

  // Delivery statistics describe attempts within the reporting window. / 发送统计描述报告时间窗口内的尝试。

  async function toggleActive(c: NotificationChannel) {
    setBusy(c.id);
    try {
      await notificationsApi.updateNotification(c.id, { active: c.active ? 0 : 1 });
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Test send returns 200 with the provider's error text in the body. / 测试发送返回 200，提供商错误文本在正文中。 */
  async function test(c: NotificationChannel) {
    setBusy(c.id);
    try {
      const r = await notificationsApi.testNotification(c.id);
      if (r.ok) toast.success(t('notify.testOk', { name: c.name }));
      else toast.error(t('notify.testFailed', { name: c.name, error: r.error ?? '' }));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      void refreshStats();
      setLogRevision(revision => revision + 1);
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    setBusy(target.id);
    try {
      await notificationsApi.deleteNotification(target.id);
      await load();
      toast.success(t('toast.deleted', { name: target.name }));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {/*
          The title block, per mode. `toolbar` keeps the button and drops the
          heading, because the page header above already says it.

          标题区按模式显示；toolbar 保留按钮但隐藏标题，因为上方页头已显示标题。
        */}
        {header === 'panel' ? (
          <Panel>
            <PanelHeader
              icon={<BellRing />}
              hue="violet"
              title={t('notify.title')}
              description={t('notify.desc')}
              className="mb-0"
              actions={
                <Button size="sm" color="primary" startContent={<Plus size={15} />} onPress={() => startCreate()}>
                  {t('notify.add')}
                </Button>
              }
            />
          </Panel>
        ) : header === 'toolbar' ? (
          <div className="flex flex-wrap items-center gap-3">
            {channels && channels.length > 0 ? (
              <p className="text-tiny text-default-500 tabular-nums">
                {t('notify.summary', { total: channels.length, active: channels.filter((c) => c.active === 1).length })}
              </p>
            ) : null}
            <Button size="sm" color="primary" className="ml-auto" startContent={<Plus size={15} />} onPress={() => startCreate()}>
              {t('notify.add')}
            </Button>
          </div>
        ) : null}

        {/*
          The ungrouped-monitor warning, once, above the channels rather than
          per card.

          A scoped channel silently excludes every monitor that has no group -
          the routing rule is deliberate, but its consequence is invisible from
          the channel side. So the sentence names the two facts together and
          gives the count. `warning` and not `danger`, and no `role="alert"`:
          nothing is broken, it is a consequence of a configuration that may be
          exactly what was intended.

          未分组监控项警告只在渠道列表上方显示一次，不重复放在每张卡上。
          指定范围的渠道会静默排除所有未分组监控项，这是有意的路由规则，
          但后果在渠道侧不可见，因此文案同时说明两点并给出数量。使用 warning 而非
          danger，且不加 `role="alert"`：这可能是预期配置，并不代表故障。
        */}
        {showUngroupedWarning ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3">
            <Info className="mt-0.5 shrink-0 text-warning-700" size={16} />
            <p className="min-w-0 text-tiny text-default-700">{t('notify.ungroupedWarning', { n: ungrouped })}</p>
          </div>
        ) : null}

        {channels && channels.length > 0 ? (
          <>
            {stats ? <DeliveryStrip channels={channels} stats={stats} /> : null}
            {statsError ? <div role="alert" className="flex items-center gap-2 text-small text-danger">{t('notify.statsFailed')}<Button size="sm" variant="light" onPress={() => void refreshStats()}>{t('action.retry')}</Button></div> : null}
          </>
        ) : null}

        {loadError ? (
          <Panel>
            <div role="alert" className="flex flex-wrap items-center gap-3 text-small text-danger">
              <p>{t('notify.loadFailed')}</p>
              <Button size="sm" variant="light" onPress={() => void load()}>{t('action.retry')}</Button>
            </div>
          </Panel>
        ) : null}

        {channels === null && loadError ? null : channels === null ? (
          <div className="flex flex-col gap-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-24 rounded-[14px]" />
            ))}
          </div>
        ) : channels.length === 0 ? (
          <Panel>
            <EmptyState
              art={<BellArt />}
              title={t('notify.empty')}
              hint={t('notify.emptyHint')}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {(Object.keys(NOTIFICATION_META) as NotificationType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => startCreate(type)}
                      className="polaris-card polaris-card-press flex items-center gap-2 py-1.5 pr-3 pl-1.5 text-tiny font-medium"
                    >
                      <ProviderTile type={type} size="sm" />
                      {t(NOTIFICATION_META[type].labelKey)}
                    </button>
                  ))}
                </div>
              }
            />
          </Panel>
        ) : (
          <ul ref={cards} className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {channels.map((c) => <ChannelRow key={c.id} c={c} stat={stats?.[c.id]} busy={busy} groupName={groupName} toggleActive={toggleActive} test={test} onEdit={(c) => { formSession.current++; setEditing(c); setCreating(false); setFormOpen(true); }} onDelete={setPendingDelete} />)}
          </ul>
        )}

        {channels && channels.length > 0 ? <DeliveryLog channels={channels} revision={logRevision} /> : null}
      </div>

      <ChannelForm
        open={formOpen}
        session={formSession.current}
        channel={editing}
        groups={groups}
        initialType={initialType}
        onClose={() => {
          formSession.current++;
          setFormOpen(false);
          setEditing(null);
          setCreating(false);
        }}
        onSaved={async (session) => {
          if (formSession.current === session) {
            setFormOpen(false);
            setEditing(null);
            setCreating(false);
            formSession.current++;
          }
          await load();
          toast.success(t('toast.saved'));
        }}
        isCreate={creating}
      />

      <Modal isOpen={pendingDelete !== null} onClose={() => setPendingDelete(null)} size="md">
        <ModalContent>
          <ModalHeader className="flex items-center gap-3">
            <IconTile icon={<Trash2 />} hue="danger" />
            {t('action.delete')}
          </ModalHeader>
          <ModalBody>
            <p className="font-medium">{pendingDelete?.name}</p>
            <p className="text-small text-default-500">{t('notify.deleteHint')}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setPendingDelete(null)}>
              {t('action.cancel')}
            </Button>
            <Button color="danger" onPress={() => void confirmDelete()}>
              {t('action.delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}

/** A provider, as its vendor's own mark on the console's white tile. / 在控制台白色图标块上显示服务商自身标志。 */
function ProviderTile({ type, size = 'md' }: { type: string; size?: 'sm' | 'md' }) {
  return <ProviderLogo type={type} size={size === 'sm' ? 'xs' : 'lg'} />;
}

function typeLabel(type: string, t: ReturnType<typeof useTranslations>): string {
  const meta = NOTIFICATION_META[type as NotificationType];
  return meta ? t(meta.labelKey) : type;
}

/** Twenty-four hourly columns, one series, so a burst of alerts has a shape. / 用 24 个小时柱组成单序列，展示告警突发的形态。 */
function HourlyBars({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  return (
    <div className="flex h-8 min-w-0 flex-1 items-end gap-[2px]" aria-hidden="true">
      {hours.map((count, index) => (
        <span
          key={index}
          className={clsx('min-w-[2px] flex-1 rounded-t-[2px]', count ? 'bg-[var(--polaris-ink)] opacity-70' : 'bg-[var(--polaris-rail-empty)]')}
          style={{ height: count ? `${Math.max(14, (count / max) * 100)}%` : '2px' }}
        />
      ))}
    </div>
  );
}

/** The channel-level summary strip: what is configured, and how delivery is going. / 渠道级汇总栏：展示配置情况及发送状态。 */
function DeliveryStrip({
  channels,
  stats,
}: {
  channels: NotificationChannel[];
  stats: Record<string, ChannelDeliveryStats>;
}) {
  const t = useTranslations('admin');
  const values = Object.values(stats);
  const sent = values.reduce((sum, s) => sum + s.sent24h, 0);
  const failed = values.reduce((sum, s) => sum + s.failed24h, 0);
  const latency = values.filter((s) => s.sent24h > 0);
  const avgLatency = sent ? latency.reduce((sum, s) => sum + s.avgLatencyMs * s.sent24h, 0) / sent : null;
  const active = channels.filter((c) => c.active === 1).length;

  return (
    <StatBand className="grid-cols-2 xl:grid-cols-4">
      <StatCell
        icon={<BellRing />}
        label={t('notify.statChannels')}
        value={channels.length}
        sub={t('notify.statActive', { n: active })}
      />
      <StatCell
        icon={<Send />}
        label={t('notify.sent24h')}
        value={sent}
        sub={failed ? t('notify.failedCount', { n: failed }) : t('notify.delivered')}
      >
        <HourlyBars hours={Object.values(stats).reduce<number[]>((acc, stat) => stat.hourly.map((n, i) => n + (acc[i] ?? 0)), [])} />
      </StatCell>
      <StatCell
        icon={<CircleCheck />}
        label={t('notify.statDelivery')}
        value={sent ? formatPercent(((sent - failed) / sent) * 100) : '—'}
        tone={failed && sent && (sent - failed) / sent < 0.95 ? 'warn' : undefined}
        sub={<Meter value={sent ? ((sent - failed) / sent) * 100 : null} tone={failed ? 'warn' : 'primary'} className="mt-1.5" />}
      />
      <StatCell icon={<Timer />} label={t('notify.statLatency')} value={formatMs(avgLatency)} />
    </StatBand>
  );
}

/**
 * Recent delivery attempts, newest first.
 *
 * Hidden until there is at least one row: a deployment that has never alerted
 * has nothing to show, and an empty "Deliveries" box would read as a fault.
 * 无记录时隐藏，避免空框被当成故障。
 */
function DeliveryLog({ channels, revision }: { channels: NotificationChannel[]; revision: number }) {
  const t = useTranslations('admin');
  const ago = useTimeAgo();
  const [rows, setRows] = useState<DeliveryRecord[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const byId = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);

  useEffect(() => {
    let alive = true;
    notificationsApi.notificationDeliveries(8)
      // A failure leaves the section hidden rather than surfacing a second
      // error beside the one the panel already reports.
      // 读取失败时隐藏区块，避免在面板已有错误旁再显示第二个错误。
      .then((res) => { if (alive) { setRows(res.deliveries); setLoadError(false); } })
      .catch(() => { if (alive) setLoadError(true); });
    return () => {
      alive = false;
    };
  }, [revision, retry]);

  if (loadError) return <div role="alert" className="flex items-center gap-2 text-small text-danger">{t('notify.deliveriesFailed')}<Button size="sm" variant="light" onPress={() => setRetry(value => value + 1)}>{t('action.retry')}</Button></div>;
  if (rows.length === 0) return null;

  return (
    <section className="polaris-card overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--polaris-line)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">{t('notify.deliveries')}</h3>
          <p className="text-[12px] text-[var(--polaris-ink-3)]">{t('notify.deliveriesHint')}</p>
        </div>
      </div>
      <ul className="polaris-divide">
        {rows.map((row) => {
          const channel = byId.get(row.channel_id);
          const verb = row.status === 0 ? 'insights.eventDown' : row.status === 1 ? 'insights.eventUp' : 'insights.eventWarn';
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <ProviderTile type={channel?.type ?? 'webhook'} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-tiny">
                  {/*
                    A row with no monitor is a test send, not a deleted monitor.
                    The Worker records both kinds in the same table; `monitor_id`
                    is null for a test, and saying "deleted monitor" there would
                    describe the opposite of what happened.

                    没有关联监控项的记录是测试发送，而非监控项已删除。Worker 将两类记录
                    存在同一张表；测试发送的 `monitor_id` 为 null，称其为“已删除”会颠倒事实。
                  */}
                  <span className="font-medium">
                    {row.monitor_id === null ? t('notify.testSend') : (row.monitor_name ?? t('insights.deletedMonitor'))}
                  </span>{' '}
                  <span className="text-default-500">{t(verb)}</span>
                  <span className="text-default-400"> → {channel?.name ?? '—'}</span>
                </span>
                {row.error ? <span className="block truncate text-[11px] text-danger-600">{row.error}</span> : null}
              </span>
              <span className="text-[11px] text-default-400 tabular-nums">{row.latency_ms}ms</span>
              <StatusPill tone={row.ok ? 'up' : 'down'} label={row.ok ? t('notify.delivered') : t('notify.failed')} />
              <span className="w-20 text-right text-[11px] text-default-400">{ago(row.created_at)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Create/edit form driven by NOTIFICATION_META; groups are passed in. / 由 NOTIFICATION_META 驱动的创建/编辑表单；分组由外部传入。 */
function ChannelForm({
  open,
  session,
  channel,
  isCreate,
  groups,
  initialType,
  onClose,
  onSaved,
}: {
  open: boolean;
  session: number;
  channel: NotificationChannel | null;
  isCreate: boolean;
  groups: MonitorGroup[];
  /** The provider to start a new channel on, when one was picked before opening. / 打开前已选择服务商时，新渠道使用该初始类型。 */
  initialType?: NotificationType | null;
  onClose: () => void;
  onSaved: (session: number) => void;
}) {
  const t = useTranslations('admin');
  const { locale } = useLocale();
  const apiErrorMessage = useApiErrorMessage();
  const [name, setName] = useState('');
  const [type, setType] = useState<NotificationType>('telegram');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [language, setLanguage] = useState<NotificationLanguage>(defaultNotificationLanguage);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const currentSession = useRef(session);
  currentSession.current = session;
  const [error, setError] = useState<string | null>(null);

  // Re-seed whenever the drawer opens on a different channel, so one channel's
  // secret can never be submitted under another's name.
  // 抽屉打开到不同渠道时重新填充，确保不会以另一个渠道的名称提交原渠道的密钥。
  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setName(channel?.name ?? '');
    setType(channel?.type ?? initialType ?? 'telegram');
    setConfig(channel?.config ?? {});
    setLanguage(resolveNotificationLanguage(channel ? channel.config.language : locale));
    setGroupIds(channel ? scopeIds(channel) : []);
    setActive(channel ? channel.active === 1 : true);
    setError(null);
  }, [open, channel, initialType, locale, session]);

  const meta = NOTIFICATION_META[type];
  const missing = meta.fields.filter((f) => notificationFieldRequired(type, f.key, config) && !(config[f.key] ?? '').trim());
  const canSave = Boolean(name.trim()) && missing.length === 0 && !saving;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: NotificationInput = {
        name: name.trim(),
        type,
        config: { ...config, language },
        // Always sent, empty array included - see `NotificationInput.group_ids`
        // for why omitting it is not the same submission.
        // 始终发送范围，包括空数组；省略字段的含义不同，详见 `NotificationInput.group_ids`。
        group_ids: groupIds,
        active: active ? 1 : 0,
      };
      if (channel) await notificationsApi.updateNotification(channel.id, payload);
      else await notificationsApi.createNotification(payload);
      onSaved(session);
    } catch (e) {
      if (currentSession.current === session) setError(apiErrorMessage(e));
    } finally {
      if (currentSession.current === session) setSaving(false);
    }
  }

  return (
    <Drawer
      isOpen={open}
      onClose={onClose}
      placement="right"
      size="xl"
      scrollBehavior="inside"
      classNames={{ base: 'bg-[var(--polaris-canvas)]' }}
    >
      <DrawerContent>
        <DrawerHeader className="flex items-center gap-3">
          <ProviderTile type={type} />
          <div className="min-w-0">
            <p className="text-medium font-semibold">{isCreate ? t('notify.add') : t('notify.edit')}</p>
            <p className="text-tiny font-normal text-default-500">{t(meta.labelKey)}</p>
          </div>
        </DrawerHeader>
        <DrawerBody className="polaris-scroll-x min-h-0 gap-4">
          <Input
            autoFocus
            isRequired
            variant="bordered"
            label={t('notify.name')}
            placeholder={t('notify.namePlaceholder')}
            value={name}
            onValueChange={setName}
            isDisabled={saving}
          />

          <Select
            items={(Object.keys(NOTIFICATION_META) as NotificationType[]).map((type) => ({ type, label: t(NOTIFICATION_META[type].labelKey) }))}
            variant="bordered"
            label={t('notify.type')}
            selectedKeys={[type]}
            disallowEmptySelection
            isDisabled={saving || Boolean(channel)}
            // Provider is locked after creation; switching means a new channel. / 创建后锁定提供商；要换就新建渠道。
            description={channel ? undefined : t('notify.typeLocked')}
            onChange={(e) => {
              setType(e.target.value as NotificationType);
              setConfig({});
            }}
          >
            {(item) => <SelectItem key={item.type} textValue={item.label}>{item.label}</SelectItem>}
          </Select>

          {/* Under the Type select, not above the form: this sentence describes
              the provider that is currently selected, so it reads as the
              explanation of that choice and of the fields below it.
              说明放在类型选择器下方而非表单上方，因为它解释当前服务商选择及下方字段。 */}
          <p className="text-small text-default-500">{t(meta.hintKey)}</p>

          {meta.fields.map((f) => (
            <Input
              key={f.key}
              variant="bordered"
              isRequired={notificationFieldRequired(type, f.key, config)}
              type={f.secret ? 'password' : 'text'}
              label={t(f.labelKey)}
              description={t(f.hintKey)}
              value={config[f.key] ?? ''}
              onValueChange={(v) => setConfig((c) => ({ ...c, [f.key]: v }))}
              isDisabled={saving}
            />
          ))}

          <Select
            items={messageLanguages}
            variant="bordered"
            label={t('notify.messageLanguage')}
            description={t('notify.messageLanguageHint')}
            selectedKeys={new Set<NotificationLanguage>([language])}
            disallowEmptySelection
            isDisabled={saving}
            onSelectionChange={(keys) => {
              if (keys === 'all') return;
              const selected = [...keys][0];
              if (isNotificationLanguage(selected)) setLanguage(selected);
            }}
          >
            {(item) => <SelectItem key={item.key} textValue={item.name}>{item.name}</SelectItem>}
          </Select>

          <div className="polaris-well flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
            <Switch size="sm" isSelected={active} isDisabled={saving} onValueChange={setActive}>
              {t('notify.enabled')}
            </Switch>
            <span className="text-tiny text-default-500">{t('notify.enabledHint')}</span>
          </div>

          {/*
            Scope.

            The heading sits outside the select so the explanation cannot be read
            as belonging to the provider fields above it - this is a separate
            question ("who gets paged") from "how do we reach them".

            `selectionMode="multiple"` with `onSelectionChange`, exactly as the
            monitor form's tag picker: a native select cannot express multiple
            selection, so the shared selection object is the only signal, and
            `'all'` is handled rather than ignored because it is what the
            collection reports when its own select-all is used.

            **Empty is "every monitor", not "nothing".** That inversion is the
            whole risk of this control, so it is stated twice - in the
            description, which is readable before the popover is ever opened, and
            again in the line below, which is what stays on screen at the moment
            Save is pressed. An operator who reads an empty multi-select as "no
            groups" would believe they had silenced the channel when they had in
            fact made it universal.

            Rendered even when the deployment has no groups, which is where the
            monitor list's group filter hides itself. The two are not the same
            case: a filter with no options cannot filter anything and reads as
            broken, while this field's empty state is a real, meaningful scope -
            and hiding it would hide the one sentence that says so. With no groups
            to pick, the description and the placeholder are the entire content,
            and they are the correct content.

            范围标题放在选择器外，避免与上方服务商字段混淆：这是“通知哪些监控项”，
            不是“如何发送”。使用与监控表单标签选择器相同的多选及 onSelectionChange；
            原生 select 不能表达多选，因此依赖共享选择对象，并处理集合全选返回的 `all`。
            空范围表示所有监控项，而非没有监控项；这是主要风险，因此在打开弹出层前可读的
            说明和保存时仍可见的下方文字中各说明一次，避免用户误以为已静音渠道。
            即使没有分组也显示：无选项的列表筛选器无法筛选，看起来像故障；而此字段的空值
            是真实范围，隐藏会同时隐藏解释。没有分组可选时，说明和占位符就是正确的内容。
          */}
          <div className="flex flex-col gap-2">
            <p className="text-small font-medium">{t('notify.scope')}</p>

            <Select
              items={groups}
              variant="bordered"
              selectionMode="multiple"
              label={t('notify.scopeGroups')}
              description={t('notify.scopeHint')}
              selectedKeys={new Set(groupIds)}
              isDisabled={saving}
              onSelectionChange={(keys) => {
                if (keys === 'all') setGroupIds(groups.map((g) => g.id));
                else setGroupIds([...keys].map(String));
              }}
            >
              {(group) => (
                // The name as a child, so React escapes it. Only the id becomes a
                // key, and keys are not markup.
                // 名称作为子节点交给 React 转义；只有 ID 用作 key，而 key 不是标记内容。
                <SelectItem key={group.id} textValue={group.name}>{group.name}</SelectItem>
              )}
            </Select>

            {groupIds.length === 0 ? null : (
              // Supplying `n` matters: a missing ICU value breaks the form. / 必须传 `n`；缺少 ICU 参数会破坏表单。
              <p className="text-tiny text-default-500">
                {t('notify.scopeSelected', { n: groupIds.length })}
              </p>
            )}
          </div>

          {error ? (
            <p className="rounded-lg border border-danger/20 bg-danger/[0.06] px-3 py-2 text-small text-danger-600">
              {error}
            </p>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="light" onPress={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            color="primary"
            onPress={() => void save()}
            isDisabled={!canSave}
            startContent={saving ? <Loader2 className="animate-spin" size={15} /> : null}
          >
            {saving ? t('action.saving') : t('action.save')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function ChannelRow({ c, stat, busy, groupName, toggleActive, test, onEdit, onDelete }: {
  c: NotificationChannel;
  stat: ChannelDeliveryStats | undefined;
  busy: string | null;
  groupName: (id: string) => string;
  toggleActive: (channel: NotificationChannel) => Promise<void>;
  test: (channel: NotificationChannel) => Promise<void>;
  onEdit: (channel: NotificationChannel) => void;
  onDelete: (channel: NotificationChannel) => void;
}) {
  const t = useTranslations('admin');
  const ago = useTimeAgo();


  return (
    <li key={c.id} className={clsx('polaris-card flex flex-col gap-3 p-4', !c.active && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <ProviderTile type={c.type} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2">
            <span className="truncate text-small font-semibold">{c.name}</span>
            <span className="shrink-0 text-[11px] text-default-400">{typeLabel(c.type, t)}</span>
          </p>
          {/* Telegram 显示 chat_id；URL 仅缩略末段以便辨识。 / Show Telegram chat_id; abbreviate the last URL segment for identification. */}
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-default-400">
            {c.type === 'telegram'
              ? (c.config.chat_id ?? '—')
              : (c.config.webhook_url ?? c.config.url ?? '').replace(/\/[^/]+$/, '/…') || '—'}
          </p>
        </div>
        <Switch
          size="sm"
          isSelected={c.active === 1}
          isDisabled={busy === c.id}
          onValueChange={() => void toggleActive(c)}
          aria-label={t('notify.enabled')}
        />
      </div>

      {/*
                    The scope, in the same slot for every channel. A scoped
                    channel and an unscoped one differ in who gets paged, which
                    is the one thing this card is for - so it cannot be left to
                    the edit modal.

                    所有渠道在同一位置显示范围；指定和未指定范围决定哪些监控项会触发通知，
                    这是卡片的核心信息，不能只放在编辑弹窗中。
                  */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-default-400">{t('notify.scope')}</span>
        {scopeIds(c).length === 0 ? (
          <span className="inline-flex h-5 items-center rounded-md bg-default-100 px-1.5 text-[11px] font-medium text-default-600">
            {t('notify.scopeAll')}
          </span>
        ) : (
          scopeIds(c).map((id) => (
            <span
              key={id}
              className="inline-flex h-5 items-center rounded-full border border-[var(--polaris-line)] px-2 text-[11px] text-[var(--polaris-ink-2)]"
            >
              {groupName(id)}
            </span>
          ))
        )}
      </div>

      <p className="text-[11px] text-default-400">
        {t('notify.messageLanguage')}: {messageLanguages.find(({ key }) => key === resolveNotificationLanguage(c.config.language))?.name}
      </p>

      {/* Delivery figures from `/api/notifications/stats`. A channel
                      absent from the map has not sent in the window, which is
                      why this block renders nothing rather than zeroes.
                      发送统计来自 `/api/notifications/stats`；映射中缺失的渠道在该窗口没有发送，
                      因此此处不显示内容，而不是显示零值。 */}
      {stat ? (
        <div className="polaris-well flex items-end gap-4 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[11.5px] text-[var(--polaris-ink-4)]">{t('notify.sent24h')}</p>
            <p className="mt-0.5 text-small font-semibold tabular-nums">
              {stat.sent24h}
              {stat.failed24h ? (
                <span className="ml-1.5 text-[11px] font-medium text-danger-600">
                  {t('notify.failedCount', { n: stat.failed24h })}
                </span>
              ) : null}
            </p>
          </div>
          <HourlyBars hours={stat.hourly} />
          <div className="shrink-0 text-right">
            <p className="text-[11px] text-default-400">{t('notify.lastSent')}</p>
            <p className="mt-0.5 text-tiny font-medium">{stat.lastSentAt ? ago(stat.lastSentAt) : '—'}</p>
          </div>
        </div>
      ) : null}

      <div className="-mb-1 flex items-center gap-1 border-t border-[var(--polaris-line-soft)] pt-2">
        <span className="mr-auto text-[11px] text-default-400">
          {c.active === 1 ? t('notify.enabled') : t('notify.disabled')}
        </span>
        <Button
          size="sm"
          variant="light"
          aria-label={t('notify.sendTest')}
          isDisabled={busy === c.id}
          onPress={() => void test(c)}
          startContent={busy === c.id ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
        >
          <span className="hidden sm:inline">{t('notify.sendTest')}</span>
        </Button>
        <Button
          size="sm"
          variant="light"
          aria-label={t('action.edit')}
          onPress={() => {
            onEdit(c);
          }}
          startContent={<Pencil size={15} />}
        >
          <span className="hidden sm:inline">{t('action.edit')}</span>
        </Button>
        <Button
          size="sm"
          variant="light"
          className="text-danger"
          aria-label={t('action.delete')}
          onPress={() => onDelete(c)}
          startContent={<Trash2 size={15} />}
        >
          <span className="hidden sm:inline">{t('action.delete')}</span>
        </Button>
      </div>
    </li>
  );

}
