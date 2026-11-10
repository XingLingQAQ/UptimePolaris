import { Drawer } from '@/components/ui/MotionOverlays';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, Input, Switch } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { RefreshCw } from 'lucide-react';
import { parseAgentRuntimeConfig, type AgentConfigurationState } from '../../../../shared/agent-runtime-config';
import { AgentRuntimeFields } from './AgentRuntimeFields';
import { AgentReinstallDialog } from './AgentReinstallDialog';
import { KeyValueList } from '../components/ConsolePrimitives';
import { agentsApi, taxonomyApi } from './api';
import { TaxonomyFields, useAgentTaxonomy } from './Taxonomy';
import { configEditConflicts, syncConfigEdit, type ConfigEdit } from './config-edit';
import type { AgentDetailResponse, FleetAgent } from './types';

/** 编辑 Agent 的基本信息和期望运行配置，并跟踪配置应用状态。 / Edit Agent details and desired runtime configuration, and track its application status. */
export function AgentEditDrawer({ agent, onClose, onUpdated }: {
  agent: FleetAgent;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const t = useTranslations('admin.agents');
  const adminT = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const taxonomy = useAgentTaxonomy();
  const [groupId, setGroupId] = useState<string | null>(agent.group_id ?? null);
  const [tagIds, setTagIds] = useState<string[]>((agent.tags ?? []).map(tag => tag.id));
  const [savedTaxonomy, setSavedTaxonomy] = useState({ groupId: agent.group_id ?? null, tagIds: (agent.tags ?? []).map(tag => tag.id).sort() });
  const [name, setName] = useState(agent.name);
  const [active, setActive] = useState(agent.active);
  const [probeEnabled, setProbeEnabled] = useState(agent.probe_enabled !== false);
  const [isPublic, setIsPublic] = useState(agent.is_public === 1);
  const [savedPublic, setSavedPublic] = useState(agent.is_public === 1);
  const [saved, setSaved] = useState({ name: agent.name, active: agent.active, probeEnabled: agent.probe_enabled !== false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<AgentDetailResponse | null>(null);
  const [detailError, setDetailError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [runtime, setRuntime] = useState<AgentConfigurationState | null>(null);
  const [configEdit, setConfigEdit] = useState<ConfigEdit | null>(null);
  const draft = configEdit?.draft ?? null;
  const [runtimeError, setRuntimeError] = useState('');
  const [reinstall, setReinstall] = useState(false);
  const mounted = useRef(true);
  const saving = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setDetailError('');
    void agentsApi.agentDetail(agent.id).then((value) => {
      if (!cancelled) setDetail(value);
    }).catch((reason) => {
      if (!cancelled) setDetailError(apiErrorMessage(reason));
    });
    return () => { cancelled = true; };
  }, [agent.id, attempt, apiErrorMessage]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await agentsApi.configuration(agent.id);
        if (cancelled) return;
        setRuntime(value);
        setRuntimeError('');
        setConfigEdit((previous) => syncConfigEdit(previous, value));
        timer = setTimeout(() => void refresh(), value.status === 'pending' || value.status === 'error' ? 3000 : 10000);
      } catch (failure) { if (!cancelled) setRuntimeError(apiErrorMessage(failure)); }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [agent.id, attempt, apiErrorMessage, runtime?.desired_revision]);

  const configuration = parseAgentRuntimeConfig(draft);
  const configChanged = configuration !== null && JSON.stringify(configuration) !== JSON.stringify(configEdit?.baseline);
  const configConflict = configEditConflicts(configEdit, runtime);
  const configInvalid = draft !== null && configuration === null;
  const taxonomyChanged = taxonomy.enabled && (groupId !== savedTaxonomy.groupId || JSON.stringify([...tagIds].sort()) !== JSON.stringify(savedTaxonomy.tagIds));
  const visibilityChanged = taxonomy.enabled && isPublic !== savedPublic;
  const changed = visibilityChanged || taxonomyChanged || name.trim() !== saved.name || active !== saved.active || probeEnabled !== saved.probeEnabled || configChanged;
  const save = async () => {
    if (saving.current || !name.trim() || !changed || configInvalid || configChanged && (!runtime?.allowed || configConflict)) return;
    saving.current = true;
    setBusy(true);
    setError('');
    const next = { name: name.trim(), active, probeEnabled };
    const writes: Array<{ field: 'name' | 'active' | 'probeEnabled' | 'runtime' | 'taxonomy' | 'visibility'; request: Promise<unknown> }> = [
      ...(visibilityChanged ? [{ field: 'visibility' as const, request: agentsApi.setVisibility([agent.id], isPublic) }] : []),
      ...(next.name !== saved.name ? [{ field: 'name' as const, request: agentsApi.renameAgent(agent.id, next.name) }] : []),
      ...(next.active !== saved.active ? [{ field: 'active' as const, request: agentsApi.setAgentActive(agent.id, next.active) }] : []),
      ...(next.probeEnabled !== saved.probeEnabled ? [{ field: 'probeEnabled' as const, request: agentsApi.setAgentProbeEnabled(agent.id, next.probeEnabled) }] : []),
      ...(taxonomyChanged ? [{ field: 'taxonomy' as const, request: taxonomyApi.assign(agent.id, groupId, tagIds) }] : []),
      ...(configChanged && configuration && runtime ? [{ field: 'runtime' as const, request: agentsApi.saveConfiguration(agent.id, configuration, configEdit?.revision ?? null) }] : []),
    ];
    // 每项独立保存；只更新成功项的基线，失败项可继续重试。 / Save each item independently; update the baseline only for successful items so failures can be retried.
    const results = await Promise.allSettled(writes.map((write) => write.request));
    if (!mounted.current) return;
    const baseline = { ...saved };
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures.push(apiErrorMessage(result.reason));
        if (writes[index].field === 'runtime') setAttempt((value) => value + 1);
      }
      else if (writes[index].field === 'name') baseline.name = next.name;
      else if (writes[index].field === 'active') baseline.active = next.active;
      else if (writes[index].field === 'probeEnabled') baseline.probeEnabled = next.probeEnabled;
      else if (writes[index].field === 'taxonomy') setSavedTaxonomy({ groupId, tagIds: [...tagIds].sort() });
      else if (writes[index].field === 'visibility') setSavedPublic(isPublic);
      else {
        const revision = (result.value as { revision: string }).revision;
        setConfigEdit({ draft: configuration, baseline: configuration, revision });
        setRuntime((previous) => previous ? { ...previous, desired: configuration, desired_revision: revision, status: 'pending', error: null } : previous);
      }
    });
    setSaved(baseline);
    setBusy(false);
    saving.current = false;
    if (failures.length < results.length) onUpdated();
    if (failures.length) {
      setError([...(failures.length < results.length ? [t('savePartial')] : []), ...failures].join('\n'));
    } else {
      toast.success(t('savedToast'));
      onClose();
    }
  };

  return (
    <Drawer isOpen onClose={() => !busy && onClose()} isDismissable={!busy} isKeyboardDismissDisabled={busy} placement="right" size="xl" scrollBehavior="inside" classNames={{ base: 'bg-[var(--polaris-canvas)]' }}>
      <DrawerContent>
        <DrawerHeader className="flex flex-col gap-1 border-b border-[var(--polaris-line)] bg-[var(--polaris-card)] pr-12">
          <span>{t('editTitle')}</span>
          <span className="text-tiny font-normal text-default-500">{agent.name}</span>
        </DrawerHeader>
        <DrawerBody className="polaris-scroll-x gap-5 py-5">
          <Input label={t('colName')} value={name} onValueChange={setName} maxLength={200} isRequired isDisabled={busy} autoFocus />
          {taxonomy.enabled ? <TaxonomyFields groups={taxonomy.groups} tags={taxonomy.tags} groupId={groupId} tagIds={tagIds} onGroupChange={setGroupId} onTagsChange={setTagIds} disabled={busy || !!taxonomy.error} /> : null}
          {taxonomy.error ? <p role="alert" className="text-small text-danger">{apiErrorMessage(taxonomy.error)}</p> : null}
          {taxonomy.enabled ? <Switch isSelected={isPublic} onValueChange={setIsPublic} isDisabled={busy}>{adminT('action.showOnPublic')}</Switch> : null}
          <section className="flex flex-col gap-3" aria-label={t('sectionInstall')}>
            <h3 className="text-small font-semibold">{t('sectionInstall')}</h3>
            <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
              <div className="min-w-0">
                <p className="text-tiny font-medium">{t('agentActive')}</p>
                <p className="mt-0.5 text-tiny text-default-500">{t('agentActiveHint')}</p>
              </div>
              <Switch size="sm" classNames={{ base: 'shrink-0', label: 'whitespace-nowrap' }} isSelected={active} onValueChange={setActive} isDisabled={busy}>{active ? t('agentActiveOn') : t('agentActiveOff')}</Switch>
            </div>
            <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
              <div className="min-w-0">
                <p id={`probe-label-${agent.id}`} className="text-tiny font-medium">{t('probeEnabled')}</p>
                <p id={`probe-hint-${agent.id}`} className="mt-0.5 text-tiny text-default-500">{t('addProbeNodeHint')}</p>
              </div>
              <Switch size="sm" name="probe_enabled" aria-labelledby={`probe-label-${agent.id}`} aria-describedby={`probe-hint-${agent.id}`} classNames={{ base: 'shrink-0', label: 'whitespace-nowrap' }} isSelected={probeEnabled} onValueChange={setProbeEnabled} isDisabled={busy}>{probeEnabled ? t('agentActiveOn') : t('agentActiveOff')}</Switch>
            </div>
          </section>
          <section className="flex flex-col gap-3" aria-label={t('configTitle')}>
            <div className="flex items-center justify-between gap-3"><h3 className="text-small font-semibold">{t('configTitle')}</h3><div className="flex items-center gap-1"><Button isIconOnly size="sm" variant="light" aria-label={t('refresh')} isDisabled={busy} onPress={() => setAttempt((value) => value + 1)}><RefreshCw size={15} /></Button><Button size="sm" variant="flat" isDisabled={!detail?.install?.token || busy} onPress={() => setReinstall(true)}>{t('reinstall')}</Button></div></div>
            <p className="text-tiny text-default-500">{t('configHint')}</p>
            {runtime ? <>
              {!runtime.supported ? <p role="status" className="polaris-well p-3 text-small text-default-500">{t('configUnreported')}</p> : <>
                <p role="status" className={runtime.status === 'error' ? 'text-tiny text-danger' : 'text-tiny text-default-500'}>{t(runtime.status === 'pending' ? 'configPending' : runtime.status === 'error' ? 'configFailed' : 'configSynced')}</p>
                {runtime.error ? <p className="break-words text-tiny text-danger">{runtime.error}</p> : null}
                {!runtime.allowed ? <p className="text-tiny text-default-500">{t('configPermission')}</p> : null}
                {configConflict ? <div role="alert" className="text-small text-danger"><p>{t('configConflict')}</p><Button size="sm" variant="light" isDisabled={busy} onPress={() => { const latest = runtime.desired ?? runtime.current; setConfigEdit({ draft: latest, baseline: latest, revision: runtime.desired_revision }); }}>{t('reloadConfig')}</Button></div> : null}
                {draft ? <AgentRuntimeFields value={draft} onChange={(value) => setConfigEdit((previous) => previous ? { ...previous, draft: value } : previous)} disabled={busy || !runtime.allowed} autoUpdateSupported={runtime.installation?.auto_update_supported === true} /> : null}
                {runtime.installation ? <KeyValueList items={[
                  { label: adminT('agent.installMode'), value: runtime.installation.service_tier ?? '—' },
                  { label: t('configFile'), value: runtime.installation.config_path, mono: true },
                  { label: t('executableFile'), value: runtime.installation.executable_path, mono: true },
                ]} /> : null}
              </>}
            </> : !runtimeError ? <p role="status" className="text-small text-default-500">{t('loading')}</p> : null}
            {runtimeError ? <div role="alert" className="text-small text-danger"><p>{runtimeError}</p><Button size="sm" variant="light" onPress={() => setAttempt((value) => value + 1)}>{adminT('action.retry')}</Button></div> : null}
            {detailError ? (
              <div role="alert" className="flex items-center gap-2 text-small text-danger">
                <span>{detailError}</span>
                <Button size="sm" variant="light" onPress={() => setAttempt((value) => value + 1)}>{adminT('action.retry')}</Button>
              </div>
            ) : null}
          </section>
          {error ? <p role="alert" className="whitespace-pre-line text-small text-danger">{error}</p> : null}
        </DrawerBody>
        <DrawerFooter className="border-t border-[var(--polaris-line)] bg-[var(--polaris-card)]">
          <Button variant="light" onPress={onClose} isDisabled={busy}>{t('cancel')}</Button>
          <Button color="primary" isLoading={busy} isDisabled={!changed || !name.trim() || configInvalid || configChanged && (!runtime?.allowed || configConflict)} onPress={() => void save()}>{adminT('action.save')}</Button>
        </DrawerFooter>
      </DrawerContent>
      {reinstall && detail?.install?.token ? <AgentReinstallDialog token={detail.install.token} config={runtime?.desired ?? runtime?.current ?? null} onClose={() => setReinstall(false)} /> : null}
    </Drawer>
  );
}
