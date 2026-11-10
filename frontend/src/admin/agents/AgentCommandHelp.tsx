import { Button } from '@heroui/react';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { toast } from '@/components/ui/toast';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import type { InstallMode } from '../../../../shared/agent-install';
import { AGENT_SHORT_COMMAND } from '../../../../shared/project';

export function AgentCommandHelp({ mode }: { mode: InstallMode }) {
  const t = useTranslations('admin');
  const apiErrorMessage = useApiErrorMessage();
  const [copied, setCopied] = useState('');
  const copy = async (command: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(command); }
    catch { toast.error(apiErrorMessage('clipboard_copy_failed')); }
  };
  const commands = (mode === 'manual'
    ? ['run', 'command status', '--help']
    : ['status', 'restart', 'logs -f']).map(action => `${AGENT_SHORT_COMMAND} ${action}`);
  return (
    <section className="polaris-well p-3.5">
      <p className="text-small font-medium">{t('agent.manageCommand')}</p>
      <p className="mt-1 text-tiny text-default-500">{t(mode === 'system' ? 'agent.manageSystemCommandHint' : 'agent.manageCommandHint')}</p>
      <div className="mt-3 flex flex-col gap-1.5">
        {commands.map((command) => (
          <div key={command} className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-tiny">{command}</code>
            <Button isIconOnly size="sm" variant="light" aria-label={`${t('action.copy')} ${command}`} onPress={() => void copy(command)}>{copied === command ? <Check size={13} /> : <Copy size={13} />}</Button>
          </div>
        ))}
      </div>
    </section>
  );
}
