import { useMotionList } from '@/lib/useMotionList';
import { Drawer, Modal, Select } from '@/components/ui/MotionOverlays';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
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
} from '@heroui/react';
import {
  Folder,
  Layers,
  Monitor,
  Pencil,
  Plus,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import type { GroupType, ManagedGroup } from '../../../../shared/groups';
import { StatusDot } from '@/components/ui/StatusDot';
import { toast } from '@/components/ui/toast';
import { AgentDetailDialog } from '../agents/AgentDetailDialog';
import { AgentEditDrawer } from '../agents/AgentEditDrawer';
import type { FleetAgent } from '../agents/types';
import { EmptyState } from '../components/ConsolePrimitives';
import { IconTile } from '../components/IconTile';
import { FoldersArt } from '../components/illustrations';
import { Panel, PanelHeader } from '../components/Panel';
import { MonitorForm } from '../monitors/MonitorForm';
import { MonitorQuickView } from '../monitors/MonitorQuickView';
import { monitorsApi } from '../monitors/api';
import { toneForStatus } from '../monitors/presentation';
import type {
  OverviewMonitor,
  Monitor as MonitorRecord,
} from '../monitors/types';
import { useFleet, useOverview } from '../useConsoleData';
import { usePresentation } from '../settings/presentation-api';
import { formatAvailability } from '../format';
import { managementApi } from './api';

const TYPE_ICON = { monitor: Monitor, agent: Server, common: Layers };

// 统一展示两类分组，成员编辑与删除仍按各自的实体范围执行。
// Present both group kinds together while editing and deleting members within their own entity scopes.
export function GroupsPanel({
  header = 'panel',
}: {
  header?: 'panel' | 'toolbar' | 'none';
}) {
  const t = useTranslations('admin'),
    message = useApiErrorMessage();
  const cards = useMotionList<HTMLUListElement>();
  const presentation = usePresentation();
  const enabled = presentation.data?.config.agentEnabled === true;
  const data = useSWR(['managed-groups', enabled], () => managementApi.list());
  const overview = useOverview(),
    fleet = useFleet(enabled);
  const [editor, setEditor] = useState<ManagedGroup | 'new' | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{
    group: ManagedGroup;
    scope: 'all' | 'monitor' | 'agent';
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [monitor, setMonitor] = useState<OverviewMonitor | null>(null),
    [agent, setAgent] = useState<FleetAgent | null>(null);
  const [editingAgent, setEditingAgent] = useState<FleetAgent | null>(null);
  const [editingMonitor, setEditingMonitor] = useState<MonitorRecord | null>(
    null,
  );
  const group = data.data?.groups.find((item) => item.key === opened) ?? null;
  const ungroupedMonitors =
    overview.data?.monitors.filter((item) => !item.group_id).length ?? 0;
  const ungroupedAgents = enabled
    ? (fleet.data?.agents.filter((item) => !item.group_id).length ?? 0)
    : 0;
  const refresh = useCallback(async () => {
    await Promise.all([
      data.mutate(),
      overview.mutate(),
      ...(enabled ? [fleet.mutate()] : []),
    ]);
  }, [data.mutate, overview.mutate, fleet.mutate, enabled]);
  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    setError('');
    try {
      await managementApi.remove(deleting.group.key, deleting.scope);
      setDeleting(null);
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const add = (
    <Button
      size="sm"
      color="primary"
      startContent={<Plus size={15} />}
      isDisabled={!data.data}
      onPress={() => setEditor('new')}
    >
      {t('groups.add')}
    </Button>
  );
  return (
    <>
      {header === 'panel' ? (
        <Panel>
          <PanelHeader
            icon={<Folder />}
            hue="indigo"
            title={t('groups.title')}
            description={t('groups.desc')}
            actions={add}
          />
        </Panel>
      ) : (
        <div className="flex justify-end">{add}</div>
      )}
      {data.error || presentation.error ? (
        <Panel>
          <p role="alert" className="text-small text-danger">
            {message(data.error ?? presentation.error)}
          </p>
          <Button
            size="sm"
            variant="light"
            onPress={() => {
              void data.mutate();
              void presentation.mutate();
            }}
          >
            {t('action.retry')}
          </Button>
        </Panel>
      ) : null}
      {!data.data ? (
        !data.error && <Skeleton className="h-44 rounded-xl" />
      ) : data.data.groups.length === 0 ? (
        <Panel>
          <EmptyState
            art={<FoldersArt />}
            title={t('groups.empty')}
            hint={t('groups.emptyHint')}
            action={add}
          />
        </Panel>
      ) : (
        <ul ref={cards} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.data.groups.map((item) => <GroupCard key={item.key} item={item} monitors={overview.data?.monitors ?? []} onOpen={setOpened} onEdit={setEditor} onDelete={(item) => { setError(''); setDeleting({ group: item, scope: 'all' }); }} />)}
        </ul>
      )}
      {ungroupedMonitors + ungroupedAgents > 0 ? (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-small text-default-500">
          <span>{t('quick.ungrouped')}</span>
          {ungroupedMonitors > 0 ? (
            <span>
              {t('groups.monitorMembers', { count: ungroupedMonitors })}
            </span>
          ) : null}
          {ungroupedAgents > 0 ? (
            <span>{t('groups.agentMembers', { count: ungroupedAgents })}</span>
          ) : null}
        </p>
      ) : null}
      {editor ? (
        <GroupForm
          group={editor === 'new' ? null : editor}
          agentEnabled={enabled}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await refresh();
            toast.success(t('groups.saved'));
          }}
        />
      ) : null}
      <Drawer
        isOpen={!!group}
        onClose={() => setOpened(null)}
        size="xl"
        placement="right"
        scrollBehavior="inside"
      >
        <DrawerContent className="bg-[var(--polaris-canvas)]">
          <DrawerHeader className="flex flex-col gap-1 pr-12">
            <span>{group?.name}</span>
            <span className="text-small font-normal text-default-500">
              {group ? t(`groups.type_${group.type}`) : ''}
            </span>
          </DrawerHeader>
          <DrawerBody className="gap-7 py-5">
            {group?.monitorId ? (
              <MemberSection
                group={group}
                kind="monitor"
                items={(overview.data?.monitors ?? []).map((item) => ({
                  id: item.id,
                  name: item.name,
                  groupId: item.group_id,
                  tone: item.active ? toneForStatus(item.st) : 'idle',
                }))}
                loading={overview.isLoading}
                error={overview.error}
                onRetry={() => void overview.mutate()}
                onView={(id) =>
                  setMonitor(
                    overview.data?.monitors.find((item) => item.id === id) ??
                      null,
                  )
                }
                onChanged={refresh}
                onDelete={() => {
                  setError('');
                  setDeleting({ group, scope: 'monitor' });
                }}
              />
            ) : null}
            {group?.agentId && enabled ? (
              <MemberSection
                group={group}
                kind="agent"
                items={(fleet.data?.agents ?? []).map((item) => ({
                  id: item.id,
                  name: item.name,
                  groupId: item.group_id,
                  tone:
                    !item.active || item.online === null
                      ? 'idle'
                      : item.online
                        ? 'up'
                        : 'down',
                }))}
                loading={fleet.isLoading}
                error={fleet.error}
                onRetry={() => void fleet.mutate()}
                onView={(id) =>
                  setAgent(
                    fleet.data?.agents.find((item) => item.id === id) ?? null,
                  )
                }
                onChanged={refresh}
                onDelete={() => {
                  setError('');
                  setDeleting({ group, scope: 'agent' });
                }}
              />
            ) : null}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
      <MonitorQuickView
        monitor={monitor}
        groupName={group?.name}
        busy={busy}
        onClose={() => setMonitor(null)}
        onEdit={() => {
          if (!monitor || busy) return;
          setBusy(true);
          void monitorsApi
            .listMonitors()
            .then((result) => {
              const item = result.monitors.find(
                (item) => item.id === monitor.id,
              );
              if (!item) throw new Error('not_found');
              setEditingMonitor(item);
              setMonitor(null);
            })
            .catch((reason) => toast.error(message(reason)))
            .finally(() => setBusy(false));
        }}
        onToggle={() => {
          if (!monitor) return;
          setBusy(true);
          void monitorsApi
            .updateMonitor(monitor.id, { active: monitor.active ? 0 : 1 })
            .then(async () => {
              setMonitor(null);
              await refresh();
            })
            .catch((reason) => toast.error(message(reason)))
            .finally(() => setBusy(false));
        }}
      />
      {agent ? (
        <AgentDetailDialog
          agent={agent}
          onClose={() => setAgent(null)}
          onEdit={() => {
            setAgent(null);
            setEditingAgent(agent);
          }}
        />
      ) : null}
      {editingAgent ? (
        <AgentEditDrawer
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
          onUpdated={() => void refresh()}
        />
      ) : null}
      <Drawer
        isOpen={editingMonitor !== null}
        onClose={() => setEditingMonitor(null)}
        size="xl"
        placement="right"
        scrollBehavior="inside"
      >
        <DrawerContent>
          <DrawerHeader>{t('action.edit')}</DrawerHeader>
          <DrawerBody className="min-h-0 pb-0">
            {editingMonitor ? (
              <MonitorForm
                monitor={editingMonitor}
                defaults={overview.data?.defaults}
                onSaved={async () => {
                  setEditingMonitor(null);
                  await refresh();
                }}
                onCancel={() => setEditingMonitor(null)}
              />
            ) : null}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
      <Modal
        isOpen={!!deleting}
        onClose={() => !busy && setDeleting(null)}
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
      >
        <ModalContent>
          <ModalHeader>
            {t('action.delete')} · {deleting?.group.name}
          </ModalHeader>
          <ModalBody>
            <p className="text-small text-default-600">
              {t('groups.deleteMembersHint')}
            </p>
            {error ? (
              <p role="alert" className="text-small text-danger">
                {error}
              </p>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              isDisabled={busy}
              onPress={() => setDeleting(null)}
            >
              {t('action.cancel')}
            </Button>
            <Button
              color="danger"
              isLoading={busy}
              onPress={() => void remove()}
            >
              {t('action.delete')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}

function GroupHealth({ members }: { members: OverviewMonitor[] }) {
  const t = useTranslations('admin.groups');
  if (!members.length) return null;
  const observed = members.filter(
    (member) => member.active && member.has_history,
  );
  const average = observed.length
    ? observed.reduce((total, member) => total + member.uptime, 0) /
      observed.length
    : null;
  return (
    <div className="flex items-center gap-3 px-4 pb-3">
      <span className="text-tiny text-default-500">
        {t('avgUptime')} {formatAvailability(average)}
      </span>
      <div aria-hidden="true" className="ml-auto flex items-center gap-1">
        {members.slice(0, 20).map((member) => (
          <StatusDot
            key={member.id}
            tone={member.active ? toneForStatus(member.st) : 'idle'}
          />
        ))}
      </div>
    </div>
  );
}

function GroupForm({
  group,
  agentEnabled,
  onClose,
  onSaved,
}: {
  group: ManagedGroup | null;
  agentEnabled: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('admin'),
    message = useApiErrorMessage();
  const [name, setName] = useState(group?.name ?? ''),
    [weight, setWeight] = useState(String(group?.weight ?? 0));
  const [type, setType] = useState<GroupType>(
    group?.type ?? (agentEnabled ? 'common' : 'monitor'),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const resetCount =
    (type === 'agent' ? (group?.monitorCount ?? 0) : 0) +
    (type === 'monitor' ? (group?.agentCount ?? 0) : 0);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await managementApi.save(group?.key ?? null, {
        name: name.trim(),
        weight: Number(weight),
        type: agentEnabled ? type : 'monitor',
        confirm_membership_reset: confirmed,
      });
      await onSaved();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      isOpen
      onClose={() => !busy && onClose()}
      isDismissable={!busy}
      isKeyboardDismissDisabled={busy}
      size="xl"
      placement="right"
    >
      <DrawerContent className="bg-[var(--polaris-canvas)]">
        <DrawerHeader>{t(group ? 'groups.edit' : 'groups.add')}</DrawerHeader>
        <DrawerBody className="gap-4 py-5">
          <Input
            autoFocus
            isRequired
            label={t('groups.name')}
            value={name}
            maxLength={100}
            onValueChange={setName}
            isDisabled={busy}
          />
          {agentEnabled ? (
            <Select
              label={t('groups.type')}
              description={
                type === 'common' ? t('groups.commonHint') : undefined
              }
              selectedKeys={[type]}
              onChange={(event) => {
                setType(event.target.value as GroupType);
                setConfirmed(false);
              }}
              isDisabled={busy}
              disallowEmptySelection
            >
              {(['common', 'monitor', 'agent'] as const).map((value) => (
                <SelectItem key={value}>{t(`groups.type_${value}`)}</SelectItem>
              ))}
            </Select>
          ) : null}
          <Input
            type="number"
            label={t('groups.weight')}
            description={t('groups.weightHint')}
            value={weight}
            min={-100000}
            max={100000}
            onValueChange={setWeight}
            isDisabled={busy}
          />
          {resetCount > 0 ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 text-small text-warning-700"
            >
              <p>{t('groups.convertWarning', { count: resetCount })}</p>
              <Button
                size="sm"
                color="warning"
                variant={confirmed ? 'solid' : 'flat'}
                onPress={() => setConfirmed(!confirmed)}
              >
                {t(
                  confirmed
                    ? 'groups.convertConfirmed'
                    : 'groups.confirmUngroup',
                )}
              </Button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="light" isDisabled={busy} onPress={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            color="primary"
            isLoading={busy}
            isDisabled={
              !name.trim() ||
              !Number.isInteger(Number(weight)) ||
              Math.abs(Number(weight)) > 100000 ||
              (resetCount > 0 && !confirmed)
            }
            onPress={() => void save()}
          >
            {t('action.save')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function MemberSection({
  group,
  kind,
  items,
  loading,
  error,
  onRetry,
  onView,
  onChanged,
  onDelete,
}: {
  group: ManagedGroup;
  kind: 'monitor' | 'agent';
  items: Array<{
    id: string;
    name: string;
    groupId: string | null;
    tone: Parameters<typeof StatusDot>[0]['tone'];
  }>;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onView: (id: string) => void;
  onChanged: () => Promise<void>;
  onDelete: () => void;
}) {
  const t = useTranslations('admin'),
    message = useApiErrorMessage();
  const [adding, setAdding] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState('');
  const memberList = useMotionList<HTMLUListElement>();
  const id = kind === 'monitor' ? group.monitorId : group.agentId;
  const members = items.filter((item) => item.groupId === id),
    available = items.filter((item) => item.groupId === null);
  const Icon = TYPE_ICON[kind];
  useEffect(() => {
    setAdding(false);
    setSelected(new Set());
    setFailure('');
  }, [group.key]);
  async function change(action: 'add' | 'remove', ids: string[]) {
    if (busy) return;
    setBusy(true);
    setFailure('');
    try {
      await managementApi.members(group.key, kind, action, ids);
      await onChanged();
      setAdding(false);
      setSelected(new Set());
    } catch (reason) {
      setFailure(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-small font-semibold">
          <Icon size={16} />
          {t(`groups.${kind}Members`, { count: members.length })}
        </h3>
        <Button
          size="sm"
          variant="light"
          isDisabled={busy || loading || !!error}
          onPress={() => setAdding(!adding)}
        >
          {t('groups.addExisting')}
        </Button>
        <Button
          size="sm"
          variant="light"
          color="danger"
          startContent={<Trash2 size={14} />}
          isDisabled={busy}
          onPress={onDelete}
        >
          {t(
            kind === 'monitor'
              ? 'groups.deleteMonitorSide'
              : 'groups.deleteAgentSide',
          )}
        </Button>
      </div>
      {error ? (
        <div role="alert" className="text-small text-danger">
          {message(error)}
          <Button size="sm" variant="light" onPress={onRetry}>
            {t('action.retry')}
          </Button>
        </div>
      ) : loading ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : (
        <>
          {adding ? (
            <div className="flex flex-col gap-3">
              <Select
                selectionMode="multiple"
                label={t('groups.selectMembers')}
                selectedKeys={selected}
                onSelectionChange={(keys) =>
                  setSelected(
                    keys === 'all'
                      ? new Set(available.map((item) => item.id))
                      : new Set([...keys].map(String)),
                  )
                }
                isDisabled={busy}
              >
                {available.map((item) => (
                  <SelectItem key={item.id}>{item.name}</SelectItem>
                ))}
              </Select>
              <p className="text-tiny text-default-500">
                {t('groups.moveHint')}
              </p>
              <div>
                <Button
                  size="sm"
                  color="primary"
                  isLoading={busy}
                  isDisabled={!selected.size}
                  onPress={() => void change('add', [...selected])}
                >
                  {t('groups.addExisting')}
                </Button>
              </div>
            </div>
          ) : null}
          {members.length ? (
            <ul ref={memberList} className="divide-y divide-[var(--polaris-line-soft)]">
              {members.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-2">
                  <StatusDot tone={item.tone} />
                  <button
                    type="button"
                    className="min-w-0 flex-1 break-words rounded text-left text-small hover:text-primary focus-visible:outline-primary"
                    onClick={() => onView(item.id)}
                  >
                    {item.name}
                  </button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    aria-label={`${t('groups.removeMember')} ${item.name}`}
                    isDisabled={busy}
                    onPress={() => void change('remove', [item.id])}
                  >
                    <X size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-small text-default-500">
              {t('groups.noMembers')}
            </p>
          )}
        </>
      )}
      {failure ? (
        <p role="alert" className="text-small text-danger">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

function GroupCard({ item, monitors, onOpen, onEdit, onDelete }: {
  item: ManagedGroup;
  monitors: OverviewMonitor[];
  onOpen: (key: string) => void;
  onEdit: (group: ManagedGroup) => void;
  onDelete: (group: ManagedGroup) => void;
}) {
  const t = useTranslations('admin');
  const Icon = TYPE_ICON[item.type];
  return (<li key={item.key} className="polaris-card flex flex-col">
    <div className="flex items-start gap-3 p-4 pb-0">
      <IconTile icon={<Icon />} hue="indigo" />
      <button type="button" className="min-w-0 flex-1 rounded text-left outline-offset-4 focus-visible:outline-primary" onClick={() => onOpen(item.key)}>
        <span className="block break-words text-small font-semibold hover:text-primary">
          {item.name}
        </span>
        <span className="mt-1 block text-tiny text-default-500">
          {t(`groups.type_${item.type}`)}
        </span>
      </button>
      <Button isIconOnly size="sm" variant="light" aria-label={`${t('action.edit')} ${item.name}`} onPress={() => onEdit(item)}>
        <Pencil size={15} />
      </Button>
    </div>
    <button type="button" className="flex flex-1 flex-wrap gap-x-5 gap-y-2 px-4 py-4 text-left text-small hover:text-primary focus-visible:outline-primary" aria-label={`${t('groups.viewMembers')} ${item.name}`} onClick={() => onOpen(item.key)}>
      {item.monitorId ? (<span className="flex items-center gap-2">
        <Monitor size={15} />
        {t('groups.monitorMembers', { count: item.monitorCount })}
      </span>) : null}
      {item.agentId ? (<span className="flex items-center gap-2">
        <Server size={15} />
        {t('groups.agentMembers', { count: item.agentCount })}
      </span>) : null}
    </button>
    {item.monitorId ? (<GroupHealth members={monitors.filter((monitor) => monitor.group_id === item.monitorId)} />) : null}
    <div className="flex items-center justify-between border-t border-[var(--polaris-line-soft)] px-4 py-2">
      <span className="text-tiny text-default-500">
        {t('groups.weight')} {item.weight}
      </span>
      <Button isIconOnly size="sm" variant="light" color="danger" aria-label={`${t('action.delete')} ${item.name}`} onPress={() => {
        onDelete(item);
      }}>
        <Trash2 size={15} />
      </Button>
    </div>
  </li>);
}
