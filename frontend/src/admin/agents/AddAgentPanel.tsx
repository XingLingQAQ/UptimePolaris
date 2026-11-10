import { Drawer, Select } from '@/components/ui/MotionOverlays';
import { requestJson } from '@/api/client';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import {
  Button,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  Input,
  SelectItem,
  Switch,
} from '@heroui/react';
import clsx from 'clsx';
import { Check, Copy, Plus, RadioTower, RefreshCw, Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  agentBinaryUrl,
  groupAgentBuilds,
  installModesForPlatform,
  safeInstallCommand,
  type InstallMode,
  type InstallPlatform,
} from '../../../../shared/agent-install';
import { AgentCommandHelp } from './AgentCommandHelp';
import { agentsApi, taxonomyApi } from './api';
import { TaxonomyFields, useAgentTaxonomy } from './Taxonomy';
import { AnimatePresence, motion } from 'framer-motion';
import { CONTENT_TRANSITION, FEEDBACK_TRANSITION } from '@/lib/motion';
import { useReducedMotion } from '@/lib/useReducedMotion';

/** 配置并创建 Agent，展示安装命令并等待首次上报。 / Configure and create an Agent, display installation commands, and wait for its first report. */
export function AddAgentPanel({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.agents');
  const reduced = useReducedMotion();
  const apiErrorMessage = useApiErrorMessage();
  const ta = useTranslations('admin');

  const taxonomy = useAgentTaxonomy();
  const [groupId, setGroupId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [taxonomyPending, setTaxonomyPending] = useState(false);
  const [step, setStep] = useState<'configure' | 'install'>('configure');
  const [name, setName] = useState('');
  const [probeEnabled, setProbeEnabled] = useState(true);
  const [isPublic, setIsPublic] = useState(false);

  const [installMode, setInstallMode] = useState<InstallMode>('system');
  const [sampleInterval, setSampleInterval] = useState('5');
  const [reportInterval, setReportInterval] = useState('60');
  const [installDir, setInstallDir] = useState('');
  const [filters, setFilters] = useState({ includeNics: '', excludeNics: '', includeMounts: '', excludeMounts: '' });
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [registerCommand, setRegisterCommand] = useState(true);
  const [platforms, setPlatforms] = useState<Array<{ key: string; version: string }>>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);
  /** Flipped when the first report arrives; unlocks "finish". / 首次上报后设为真，解锁“完成”。 */
  const [detected, setDetected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pollError, setPollError] = useState('');
  const [pollAttempt, setPollAttempt] = useState(0);
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const reset = () => {
    setStep('configure');
    setName('');
    setGroupId(null);
    setTagIds([]);
    setTaxonomyPending(false);
    setIsPublic(false);
    setProbeEnabled(true);
    setInstallMode('system');
    setSampleInterval('5');
    setReportInterval('60');
    setInstallDir('');
    setFilters({ includeNics: '', excludeNics: '', includeMounts: '', excludeMounts: '' });
    setAutoUpdate(false);
    setRegisterCommand(true);
    setBusy(false);
    setError('');
    setCreated(null);
    setDetected(false);
    setChecking(false);
    setPollError('');
    setPollAttempt(0);
    setCopiedKey(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const endpoint = window.location.origin;
  const downloadUrl = `${endpoint}/api/public/agent/download`;

  // Builds are listed once per open; the catalogue changes with releases, not
  // with the operator's clicks.
  // 每次打开时列出一次构建；构建目录随版本发布变化，不随操作人员点击变化。
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    requestJson<{ platforms?: Array<{ key: string; version: string }> }>(`${endpoint}/api/public/agent/capabilities`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        const available = data.platforms ?? [];
        setPlatforms(available);
        if (available.length > 0) setInstallMode(installModesForPlatform(available[0].key.split('-')[0] as InstallPlatform)[0]);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(apiErrorMessage(error));
      });
    return () => {
      controller.abort();
    };
  }, [open, endpoint]);

  /**
   * The cadence has to be a coherent pair: the agent samples more often than it
   * reports, and neither number is allowed past the installer's own bounds.
   *
   * 采样和上报间隔必须相互匹配：采样更频繁，且两者均不得超出安装器限制。
   */
  const cadenceInvalid =
    !/^\d+$/.test(sampleInterval) ||
    !/^\d+$/.test(reportInterval) ||
    Number(sampleInterval) < 1 ||
    Number(reportInterval) > 1800 ||
    Number(sampleInterval) > Number(reportInterval);

  /**
   * One command per published build, not one behind a picker.
   *
   * The console cannot see the target's architecture; asking the operator to
   * declare it meant guessing wrong produced an installer that refused to run.
   * Listing each build with its command removes the question.
   * 架构不可见，让用户先选会选错；每个构建直接给一条命令。
   */
  const installCommands = useMemo(() => {
    if (!created || cadenceInvalid) return [];
    return groupAgentBuilds(platforms)
      .flatMap((build) => {
        const os = build.os;
        const modes = installModesForPlatform(os);
        if (!modes.includes(installMode)) return [];
        const mode = installMode;
        const command = safeInstallCommand(
          {
            platformKey: build.downloadKey,
            detectPlatform: true,
            registerCommand,
            endpoint,
            token: created.token,
            mode,
            sampleInterval: Number(sampleInterval),
            reportInterval: Number(reportInterval),
            ...filters,
            installDir,
            autoUpdate: autoUpdate && mode !== 'docker' && mode !== 'manual',
          },
          os,
        ).command;
        return command ? [{ ...build, command }] : [];
      });
  }, [
    created,
    cadenceInvalid,
    platforms,
    installMode,
    endpoint,
    sampleInterval,
    reportInterval,
    filters,
    installDir,
    autoUpdate,
    registerCommand,
  ]);

  /** The OS family the mode labels are worded for. / 安装模式标签所针对的操作系统系列。 */
  const modeOS = (platforms[0]?.key.split('-')[0] ?? 'linux') as InstallPlatform;

  /** The mode labels the chosen platform family offers, for the selector. / 所选平台系列提供的安装模式标签，供选择器使用。 */
  const installModes = useMemo(() => {
    const os = platforms[0]?.key.split('-')[0] as InstallPlatform | undefined;
    return os ? installModesForPlatform(os) : [];
  }, [platforms]);

  /**
   * Watch for the agent's first report.
   *
   * Polled rather than pushed: the agent talks to the Worker, not to this
   * drawer, and there is no channel back to a browser tab. Three seconds is
   * short enough that an operator watching the command run sees it land, and
   * cheap enough that a drawer left open costs one small request.
   *
   * 轮询首次上报：Agent 与 Worker 通信，没有直接推送到此浏览器抽屉的通道。
   * 三秒间隔既能让观看安装的操作人员及时看到结果，也让打开的抽屉只产生少量请求。
   */
  const pollRef = useRef<number | null>(null);
  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open || !created || detected) return;
    let cancelled = false;
    const controller = new AbortController();
    const check = async () => {
      if (cancelled) return;
      setChecking(true);
      let found = false;
      try {
        const agents = await requestJson<{ agents: Array<{ id: string; last_reported_at: number | null }> }>('/api/admin/agents', { signal: controller.signal });
        if (cancelled) return;
        setPollError('');
        const row = agents.agents.find((agent) => agent.id === created.id);
        if (row?.last_reported_at) {
          found = true;
          setChecking(false);
          setDetected(true);
          stopPolling();
          await onCreatedRef.current();
        }
      } catch (failure) {
        if (!cancelled && !controller.signal.aborted && !found) setPollError(apiErrorMessage(failure));
      } finally {
        if (!cancelled && !controller.signal.aborted && !found) {
          setChecking(false);
          pollRef.current = window.setTimeout(() => void check(), 3000);
        }
      }
    };
    void check();
    return () => { cancelled = true; controller.abort(); stopPolling(); };
  }, [open, created, detected, pollAttempt, apiErrorMessage, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const canContinue = name.trim() !== '' && !cadenceInvalid;

  const create = async () => {
    if (busy || !canContinue) return;
    setBusy(true);
    setError('');
    try {
      const result = await agentsApi.createAgent({
        name: name.trim(),
        probe_enabled: probeEnabled,
        ...(taxonomy.enabled ? { is_public: isPublic } : {}),
      });
      setCreated({ id: result.id, token: result.token });
      setStep('install');
      if (taxonomy.enabled && (groupId || tagIds.length)) {
        try { await taxonomyApi.assign(result.id, groupId, tagIds); }
        catch (reason) { setTaxonomyPending(true); setError(apiErrorMessage(reason)); }
      }
      await onCreated();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  return (
    <Drawer
      isOpen={open}
      onClose={close}
      placement="right"
      size="xl"
      scrollBehavior="inside"
      classNames={{ base: 'bg-[var(--polaris-canvas)]' }}
    >
      <DrawerContent>
        <DrawerHeader className="flex items-center gap-3 border-b border-[var(--polaris-line)] bg-[var(--polaris-card)] py-4">
          <Server size={18} className="text-default-500" />
          <span className="min-w-0">
            <p className="text-medium font-semibold">{t('addTitle')}</p>
            <p className="text-tiny font-normal text-default-500">
              {step === 'configure' ? t('addSubtitle') : t('addedSubtitle')}
            </p>
          </span>
        </DrawerHeader>

        <DrawerBody className="polaris-scroll-x min-h-0 gap-4 py-5">
          <AnimatePresence initial={false} mode="wait">
          <motion.div key={step} className="flex flex-col gap-4"
            initial={{ opacity: 0, transform: reduced ? 'none' : 'translateX(10px)' }}
            animate={{ opacity: 1, transform: 'none', transition: CONTENT_TRANSITION }}
            exit={{ opacity: 0, pointerEvents: 'none', transition: FEEDBACK_TRANSITION }}>
          {step === 'configure' ? (
            <>
              <div>
                <Input
                  autoFocus
                  isRequired
                  label={t('addName')}
                  placeholder={t('addNamePlaceholder')}
                  value={name}
                  onValueChange={setName}
                />
              </div>

              {taxonomy.enabled ? <TaxonomyFields groups={taxonomy.groups} tags={taxonomy.tags} groupId={groupId} tagIds={tagIds} onGroupChange={setGroupId} onTagsChange={setTagIds} disabled={busy || !!taxonomy.error} /> : null}
              {taxonomy.error ? <p role="alert" className="text-small text-danger">{apiErrorMessage(taxonomy.error)}</p> : null}
              {taxonomy.enabled ? <Switch isSelected={isPublic} onValueChange={setIsPublic} isDisabled={busy}>{ta('action.showOnPublic')}</Switch> : null}
              <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
                <div className="min-w-0">
                  <p className="text-tiny font-medium">{t('addProbeNode')}</p>
                  <p className="mt-0.5 text-tiny text-default-500">{t('addProbeNodeHint')}</p>
                </div>
                <Switch size="sm" isSelected={probeEnabled} onValueChange={setProbeEnabled}>
                  {probeEnabled ? t('agentActiveOn') : t('agentActiveOff')}
                </Switch>
              </div>

              {/*
                The installer's settings, asked before the command exists.

                These are the choices that decide what lands on the host -
                platform, how it is supervised, how often it samples, and what
                it includes - so they belong to the configure step rather than
                to the screen that only prints the result.

                平台、进程管理方式、采样频率及包含内容决定主机上安装的内容，
                因此在配置步骤询问，而不是放在只展示命令的结果页。
              */}
              <div className="flex flex-col gap-3">
                <p className="text-tiny font-medium text-default-500">{t('installSettings')}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Select
                    items={installModes.map((value) => ({
                      key: value,
                      label: ta(value === 'manual' || value === 'docker' ? `agent.mode_${value}` : `agent.mode_${value}_${modeOS}`),
                    }))}
                    label={ta('agent.installMode')}
                    selectedKeys={installModes.includes(installMode) ? [installMode] : []}
                    onChange={(event) => setInstallMode(event.target.value as InstallMode)}
                  >
                    {(item) => <SelectItem key={item.key} textValue={item.label}>{item.label}</SelectItem>}
                  </Select>
                  <Input
                    label={ta('agent.sampleInterval')}
                    type="number"
                    min={1}
                    max={1800}
                    value={sampleInterval}
                    onValueChange={setSampleInterval}
                    isInvalid={cadenceInvalid}
                  />
                  <Input
                    label={ta('agent.reportInterval')}
                    type="number"
                    min={1}
                    max={1800}
                    value={reportInterval}
                    onValueChange={setReportInterval}
                    isInvalid={cadenceInvalid}
                    errorMessage={cadenceInvalid ? ta('agent.cadenceInvalid') : undefined}
                  />
                  <Input label={ta('agent.installDir')} value={installDir} onValueChange={setInstallDir} />
                  <Input
                    label={ta('agent.includeNics')}
                    value={filters.includeNics}
                    onValueChange={(includeNics) => setFilters((current) => ({ ...current, includeNics }))}
                  />
                  <Input
                    label={ta('agent.excludeNics')}
                    value={filters.excludeNics}
                    onValueChange={(excludeNics) => setFilters((current) => ({ ...current, excludeNics }))}
                  />
                  <Input
                    label={ta('agent.includeMounts')}
                    value={filters.includeMounts}
                    onValueChange={(includeMounts) => setFilters((current) => ({ ...current, includeMounts }))}
                  />
                  <Input
                    label={ta('agent.excludeMounts')}
                    value={filters.excludeMounts}
                    onValueChange={(excludeMounts) => setFilters((current) => ({ ...current, excludeMounts }))}
                  />
                </div>
                {/*
                  A row of the same shape as the probe switch above, rather than
                  a bare toggle under the grid: alone in the flow it read as an
                  afterthought, and the explanation it needs had nowhere to go.

                  使用与上方探测开关相同的行样式，而非网格下方的裸开关；
                  单独放置会显得像事后补充，也没有空间展示必要说明。
                */}
                {installMode !== 'docker' ? (
                  <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="text-tiny font-medium">{ta('agent.autoUpdate')}</p>
                      <p className="mt-0.5 text-tiny text-default-500">{ta('agent.autoUpdateHint')}</p>
                    </div>
                    <Switch size="sm" isSelected={autoUpdate} onValueChange={setAutoUpdate}>
                      {autoUpdate ? t('agentActiveOn') : t('agentActiveOff')}
                    </Switch>
                  </div>
                ) : null}
                <div className="polaris-well flex items-center justify-between gap-4 px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="text-tiny font-medium">{ta('agent.registerCommand')}</p>
                    <p className="mt-0.5 text-tiny text-default-500">{ta('agent.registerCommandHint')}</p>
                  </div>
                  <Switch size="sm" aria-label={ta('agent.registerCommand')} isSelected={registerCommand} onValueChange={setRegisterCommand} />
                </div>
              </div>

              {error ? <p role="alert" className="text-tiny text-danger-600">{error}</p> : null}
            </>
          ) : (
            <>
              <div
                className={clsx(
                  'flex items-start gap-3.5 rounded-xl border p-4 transition-colors duration-200 motion-reduce:transition-none',
                  detected ? 'border-success/25 bg-success/[0.05]' : pollError ? 'border-warning/30 bg-warning/[0.04]' : 'border-[var(--polaris-line)] bg-[var(--polaris-well)]',
                )}
              >
                <span aria-hidden="true" className={clsx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', detected ? 'bg-success/10 text-success-700' : pollError ? 'bg-warning/10 text-warning-700' : 'bg-[var(--polaris-canvas)] text-[var(--polaris-ink-3)] ring-1 ring-[var(--polaris-line)]')}>
                  {detected ? <Check size={22} /> : <RadioTower size={21} />}
                </span>
                <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 pt-0.5">
                  <p className={clsx('text-small font-semibold', detected ? 'text-success-700' : 'text-[var(--polaris-ink)]')}>
                    {detected ? t('detectedTitle') : t('waitingTitle')}
                  </p>
                  <p className="mt-1 text-tiny leading-5 text-[var(--polaris-ink-3)]">
                    {detected ? t('detectedHint') : t('waitingHint')}
                  </p>
                </div>
                {!detected ? <Button isIconOnly size="sm" variant="light" aria-label={t('refresh')} className="shrink-0 text-[var(--polaris-ink-3)]" isLoading={checking} isDisabled={checking} onPress={() => setPollAttempt((value) => value + 1)}><RefreshCw size={16} /></Button> : null}
              </div>
              {pollError && !detected ? <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/[0.06] px-3 py-2 text-tiny text-warning-700"><span className="min-w-0 flex-1">{pollError}</span><Button size="sm" variant="light" isDisabled={checking} onPress={() => setPollAttempt((value) => value + 1)}>{ta('action.retry')}</Button></div> : null}

              {installCommands.length > 0 ? (
                <div className="flex flex-col gap-3">
                  <p className="text-tiny font-medium text-default-500">{ta('agent.howToInstall')}</p>
                  <p className="text-tiny text-default-500">{ta('agent.autoDetectArch')}</p>

                  {installCommands.map((entry) => (
                    <div key={entry.key} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-medium tracking-wide text-default-600">{entry.label}</span>
                        <Button
                          className="ml-auto"
                          size="sm"
                          color="primary"
                          variant="flat"
                          startContent={copiedKey === entry.key ? <Check size={14} /> : <Copy size={14} />}
                          onPress={() => void copy(entry.command, entry.key)}
                        >
                          {copiedKey === entry.key ? t('installTokenCopied') : t('installTokenCopy')}
                        </Button>
                      </div>
                      <code className="break-all rounded-medium bg-content2 px-3 py-2 font-mono text-tiny text-default-700 whitespace-pre-wrap">
                        {entry.command}
                      </code>
                      <div className="flex flex-wrap items-center gap-2 text-tiny">
                        <span className="text-default-400">{ta('agent.downloadBinary')}</span>
                        {entry.builds.map((build) => <a key={build.key} href={agentBinaryUrl(downloadUrl, build.key)} className="text-primary underline-offset-2 hover:underline">{build.key.slice(entry.os.length + 1)}</a>)}
                      </div>
                    </div>
                  ))}

                  {installDir ? (
                    <span className="min-w-0 truncate text-tiny text-default-400">
                      {ta('agent.installDir')}: {installDir}
                    </span>
                  ) : null}
                </div>
              ) : (
                <p className="text-tiny text-danger-600">{error || ta('agent.cadenceInvalid')}</p>
              )}

              <p className="text-tiny text-default-400">{ta('agent.installNote')}</p>
              {registerCommand ? <AgentCommandHelp mode={installMode} /> : null}
            </>
          )}
          </motion.div>
          </AnimatePresence>
        </DrawerBody>

        {taxonomyPending && created ? <div className="px-5 text-small text-danger"><p>{ta('agentTaxonomy.assignmentFailed')}</p><Button size="sm" variant="flat" isLoading={busy} onPress={() => { setBusy(true); void taxonomyApi.assign(created.id, groupId, tagIds).then(async () => { setTaxonomyPending(false); setError(''); await onCreated(); }).catch(reason => setError(apiErrorMessage(reason))).finally(() => setBusy(false)); }}>{ta('action.retry')}</Button></div> : null}
        <DrawerFooter className="border-t border-[var(--polaris-line)] bg-[var(--polaris-card)]">
          {step === 'configure' ? (
            <>
              <Button variant="light" onPress={close}>{t('cancel')}</Button>
              <Button
                color="primary"
                startContent={<Plus size={15} />}
                isLoading={busy}
                isDisabled={!canContinue}
                onPress={() => void create()}
              >
                {t('continue')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="light" onPress={close}>{t('installLater')}</Button>
              <Button
                color="primary"
                isDisabled={!detected}
                // "Finish" means the agent is reporting; until then the only
                // honest action is to leave and come back.
                // “完成”表示 Agent 已上报；此前只能离开并稍后返回。
                onPress={close}
              >
                {t('finish')}
              </Button>
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
