import { Modal } from '@/components/ui/MotionOverlays';
import { requestJson } from '@/api/client';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch } from '@heroui/react';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { AgentRuntimeConfig } from '../../../../shared/agent-runtime-config';
import { groupAgentBuilds, safeInstallCommand } from '../../../../shared/agent-install';
import { AgentCommandHelp } from './AgentCommandHelp';

export function AgentReinstallDialog({ token, config, onClose }: { token: string; config: AgentRuntimeConfig | null; onClose: () => void }) {
  const t = useTranslations('admin');
  const rootT = useTranslations();
  const apiErrorMessage = useApiErrorMessage();
  const [platforms, setPlatforms] = useState<Array<{ key: string; version: string }> | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState('');
  const [registerCommand, setRegisterCommand] = useState(true);
  const endpoint = window.location.origin;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void requestJson<{ platforms: Array<{ key: string; version: string }> }>('/api/public/agent/capabilities', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setPlatforms(result.platforms); })
      .catch((failure) => { if (!controller.signal.aborted) setError(apiErrorMessage(failure)); });
    return () => controller.abort();
  }, [attempt, apiErrorMessage]);
  const copy = async (command: string, key: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(key); }
    catch { setError(apiErrorMessage('clipboard_copy_failed')); }
  };
  return (
    <Modal isOpen onClose={onClose} size="3xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>{t('agents.reinstall')}</ModalHeader>
        <ModalBody className="gap-4">
          <p className="text-small text-default-500">{t('agents.reinstallHint')}</p>
          <Switch isSelected={registerCommand} onValueChange={setRegisterCommand}>{t('agent.registerCommand')}</Switch>
          <p className="text-tiny text-default-500">{t('agent.autoDetectArch')}</p>
          {error ? <div role="alert" className="text-small text-danger"><p>{error}</p><Button size="sm" variant="light" onPress={() => setAttempt((value) => value + 1)}>{t('action.retry')}</Button></div> : null}
          {!platforms && !error ? <p role="status" className="text-small text-default-500">{t('agent.buildsLoading')}</p> : null}
          {platforms?.length === 0 ? <p className="text-small text-default-500">{t('agent.noBuilds')}</p> : null}
          {groupAgentBuilds(platforms ?? []).map((build) => {
            const platform = build.os;
            const plan = safeInstallCommand({ platformKey: build.downloadKey, endpoint, token, mode: 'system',
              operation: 'reinstall', detectPlatform: true, registerCommand,
              sampleInterval: config?.sample_interval_secs ?? 5, reportInterval: config?.report_interval_secs ?? 60,
              includeNics: config?.include_nics.join(',') ?? '', excludeNics: config?.exclude_nics.join(',') ?? '',
              includeMounts: config?.include_mounts.join(',') ?? '', excludeMounts: config?.exclude_mounts.join(',') ?? '',
              installDir: '', serviceName: 'polaris-agent', autoUpdate: config?.auto_update === true,
            }, platform);
            return <section key={build.key} className="polaris-well p-3.5">
              <div className="mb-2 flex items-center justify-between gap-3"><h3 className="font-mono text-small font-medium">{build.label} · {build.version}</h3><Button isIconOnly size="sm" variant="light" aria-label={`${t('action.copy')} ${build.label}`} isDisabled={!plan.command} onPress={() => plan.command && void copy(plan.command, build.key)}>{copied === build.key ? <Check size={15} /> : <Copy size={15} />}</Button></div>
              {plan.command ? <code className="block break-all font-mono text-tiny leading-relaxed whitespace-pre-wrap">{plan.command}</code> : <p className="text-tiny text-danger">{rootT('error.invalidRequest')}</p>}
            </section>;
          })}
          {registerCommand ? <AgentCommandHelp mode="system" /> : null}
        </ModalBody>
        <ModalFooter><Button variant="light" onPress={onClose}>{t('agents.close')}</Button></ModalFooter>
      </ModalContent>
    </Modal>
  );
}
