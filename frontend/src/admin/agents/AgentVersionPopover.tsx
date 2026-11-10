import { Popover } from '@/components/ui/MotionOverlays';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, PopoverContent, PopoverTrigger } from '@heroui/react';
import clsx from 'clsx';
import { ArrowUpCircle, Loader2, SearchCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast';
import { useTranslations } from 'use-intl';
import { agentsApi } from './api';
import type { AgentCommandRecord, FleetAgent } from './types';
import { useAgentCommands } from './useAgentCommands';

export function AgentVersionPopover({ agent, latestVersion, onCommandsLoaded, onUpdated }: {
  agent: FleetAgent;
  latestVersion: string | null;
  onCommandsLoaded: (id: string, commands: AgentCommandRecord[]) => void;
  onUpdated: () => void;
}) {
  const t = useTranslations('admin.agents');
  const adminT = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const [open, setOpen] = useState(false);
  const { history, setHistory, error, setError, refresh } = useAgentCommands({
    agentId: agent.id, enabled: open, mode: 'version', onCommandsLoaded, onUpdated,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const issuing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = history?.commands.some((command) => command.state === 'pending' || command.state === 'leased') === true;
  const behind = agent.version_state === 'behind';
  const reason = history && !history.enabled ? t('commandsHint')
    : !agent.capabilities.includes('commands') ? t('commandUnsupported')
    : !agent.active || agent.online !== true ? t('commandOffline') : '';
  const disabled = !history || Boolean(error) || Boolean(reason) || busy !== null || pending;
  const issue = async (action: 'check_update' | 'upgrade') => {
    if (issuing.current || disabled) return;
    issuing.current = true;
    setBusy(action);
    setError(null);
    try {
      await agentsApi.issueCommand(agent.id, action);
      if (!mounted.current) return;
      toast.success(t('commandQueued'));
      setHistory(null);
      refresh();
    } catch (failure) {
      if (mounted.current) setError(failure);
    } finally {
      issuing.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  const last = history?.commands[0];

  return (
    <Popover isOpen={open} onOpenChange={setOpen} placement="bottom-start" showArrow>
      <PopoverTrigger>
        <button type="button" aria-label={t('versionDetails', { name: agent.name })} className={clsx('inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] transition-colors focus-visible:outline-2 focus-visible:outline-primary', behind ? 'bg-warning/15 font-medium text-warning-700 hover:bg-warning/25' : 'text-default-600 hover:bg-default-100')}>
          {behind ? <ArrowUpCircle size={13} aria-hidden="true" /> : null}
          <span className="font-mono">{agent.version ?? '—'}</span>
          {behind ? <span>{t('updateAvailable')}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] items-stretch gap-3 p-4">
        <div>
          <p className="truncate text-small font-semibold">{agent.name}</p>
          <p className={clsx('mt-1 text-tiny', behind ? 'text-warning-700' : 'text-default-500')}>{t(behind ? 'updateAvailable' : agent.version_state === 'current' ? 'versionCurrent' : 'versionUnknown')}</p>
        </div>
        <div className="space-y-1 text-tiny text-default-600">
          <p>{t('fieldVersion')} · <span className="font-mono">{agent.version ?? '—'}</span></p>
          <p>{adminT('agent.latestVersion', { version: latestVersion ?? '—' })}</p>
        </div>
        {!history && !error ? <p role="status" className="text-tiny text-default-500">{t('loading')}</p> : null}
        {reason ? <p className="text-tiny text-default-500">{reason}</p> : null}
        {pending ? <p role="status" className="flex items-center gap-1.5 text-tiny text-primary"><Loader2 size={12} className="animate-spin motion-reduce:animate-none" />{t('updateInProgress')}</p> : null}
        {last && !pending ? <p role="status" className={clsx('text-tiny', last.state === 'completed' && last.ok === 0 ? 'text-danger' : 'text-default-500')}>{t(`command_${last.action}`)} · {t(last.state === 'expired' ? 'commandExpired' : last.ok === 1 ? 'commandOk' : 'commandFailed')}</p> : null}
        {error ? <div role="alert" className="space-y-1 text-tiny text-danger"><p>{apiErrorMessage(error)}</p><Button size="sm" variant="light" onPress={refresh}>{adminT('action.retry')}</Button></div> : null}
        <div className="flex flex-wrap gap-2 border-t border-[var(--polaris-line)] pt-3">
          <Button size="sm" variant="flat" startContent={<SearchCheck size={14} />} isLoading={busy === 'check_update'} isDisabled={disabled} onPress={() => void issue('check_update')}>{t('commandCheckUpdate')}</Button>
          <Button size="sm" color="warning" variant="flat" startContent={<ArrowUpCircle size={14} />} isLoading={busy === 'upgrade'} isDisabled={disabled || !behind || !latestVersion} onPress={() => void issue('upgrade')}>{t('commandUpgrade')}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
