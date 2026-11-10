import { Drawer } from '@/components/ui/MotionOverlays';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader } from '@heroui/react';
import { ArrowUpCircle, Check, Clock3, Loader2, RefreshCw, RotateCw, SearchCheck, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast';
import { useLocale, useTranslations } from 'use-intl';
import { StatusPill } from '../monitors/MonitorIndicators';
import { agentsApi } from './api';
import type { AgentCommandRecord, BatchCommandAction, FleetAgent } from './types';
import { useAgentCommands } from './useAgentCommands';

const ACTIONS = [
  { action: 're_report', label: 'commandReReport', icon: RefreshCw },
  { action: 'check_update', label: 'commandCheckUpdate', icon: SearchCheck },
  { action: 'restart', label: 'commandRestart', icon: RotateCw },
  { action: 'upgrade', label: 'commandUpgrade', icon: ArrowUpCircle },
] as const;

export function AgentCommandsDialog({ agent, onClose, onCommandsLoaded }: {
  agent: FleetAgent;
  onClose: () => void;
  onCommandsLoaded: (id: string, commands: AgentCommandRecord[]) => void;
}) {
  const t = useTranslations('admin.agents');
  const adminT = useTranslations('admin');
  const locale = useLocale();
  const errorMessage = useApiErrorMessage();
  const { history, error, refreshing, refresh } = useAgentCommands({
    agentId: agent.id, enabled: true, mode: 'dialog', onCommandsLoaded,
  });
  const [busy, setBusy] = useState<BatchCommandAction | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const blocked = !history ? null : !history.enabled ? t('commandsHint')
    : !agent.capabilities.includes('commands') ? t('commandUnsupported')
      : !agent.active ? t('statePaused') : agent.online !== true ? t('commandOffline') : null;

  async function issue(action: BatchCommandAction) {
    if (locked.current || !history || blocked || error) return;
    locked.current = true;
    setBusy(action);
    try {
      await agentsApi.issueCommand(agent.id, action);
      toast.success(t('commandQueued'));
      if (mounted.current) refresh();
    } catch (failure) {
      toast.error(errorMessage(failure));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <Drawer isOpen onClose={onClose} placement="right" size="lg" scrollBehavior="inside">
      <DrawerContent className="bg-[var(--polaris-panel)]">
        <DrawerHeader className="flex flex-col gap-1 border-b border-[var(--polaris-line)] px-6 py-5">
          <span className="flex items-center gap-2 text-[16px]"><SquareTerminal size={18} />{t('sectionCommands')}</span>
          <span className="pr-6 text-[13px] font-normal text-[var(--polaris-ink-3)]">{agent.name}</span>
        </DrawerHeader>
        <DrawerBody className="gap-5 px-6 py-5">
          {!history && !error ? <div role="status" className="flex items-center gap-2 py-6 text-small text-default-500"><Loader2 size={16} className="animate-spin" />{t('loading')}</div> : null}
          {error ? <div role="alert" className="polaris-well space-y-2 px-4 py-3 text-[13px] text-danger-600"><p>{errorMessage(error)}</p><Button size="sm" variant="light" onPress={refresh}>{adminT('action.retry')}</Button></div> : null}
          {blocked ? <p className="polaris-well px-4 py-3 text-[13px] leading-relaxed text-[var(--polaris-ink-3)]">{blocked}</p> : null}
          {history ? (
            <div className="grid grid-cols-2 gap-2">
              {ACTIONS.map(({ action, label, icon: Icon }) => (
                <Button key={action} variant="bordered" className="h-11 justify-start" startContent={busy === action ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />} isDisabled={busy !== null || Boolean(blocked) || Boolean(error) || history.commands.some(row => row.action === action && (row.state === 'pending' || row.state === 'leased')) || action === 'upgrade' && agent.version_state !== 'behind'} onPress={() => void issue(action)}>
                  {t(label)}
                </Button>
              ))}
            </div>
          ) : null}
          {history ? <section className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-semibold">{t('commandHistory')}</h3>
              <Button isIconOnly size="sm" variant="light" aria-label={t('refresh')} isDisabled={refreshing} onPress={refresh}><RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} /></Button>
            </div>
            {history.commands.length === 0 ? <div className="polaris-well flex flex-col items-center gap-2 px-4 py-8 text-center text-[13px] text-[var(--polaris-ink-3)]"><Clock3 size={20} className="text-[var(--polaris-ink-4)]" />{t('commandsEmpty')}</div> : <ul className="polaris-card polaris-divide overflow-hidden">
              {history.commands.map(row => {
                const pending = row.state === 'pending' || row.state === 'leased';
                const ok = row.state === 'completed' && row.ok === 1;
                const Icon = pending ? Loader2 : ok ? Check : row.state === 'expired' ? Clock3 : X;
                return <li key={row.id} className="flex gap-3 px-4 py-3">
                  <span className="mt-0.5 shrink-0 text-[var(--polaris-ink-4)]"><Icon size={15} className={pending ? 'animate-spin' : undefined} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-medium">{t(`command_${row.action}`)}</span><StatusPill tone={pending ? 'pending' : ok ? 'up' : row.state === 'expired' ? 'idle' : 'down'} label={t(pending ? 'commandPending' : ok ? 'commandOk' : row.state === 'expired' ? 'commandExpired' : 'commandFailed')} /></div>
                    <time dateTime={new Date(row.queued_at * 1000).toISOString()} className="polaris-num mt-1 block text-[11.5px] text-[var(--polaris-ink-4)]">{new Date(row.queued_at * 1000).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}</time>
                    {row.message ? <p className="mt-1.5 break-words text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{row.message}</p> : null}
                  </div>
                </li>;
              })}
            </ul>}
          </section> : null}
        </DrawerBody>
        <DrawerFooter className="border-t border-[var(--polaris-line)]"><Button variant="light" onPress={onClose}>{t('close')}</Button></DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
