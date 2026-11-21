import { useMemo } from 'react';
import { usePresentation } from '../settings/presentation-api';
import { NAV } from './nav';
import { useAgentManagement } from '../agents/useAgentManagement';

export function useNavigation() {
  const aiEnabled = usePresentation().data?.config.aiEnabled === true;
  const agentsEnabled = useAgentManagement().enabled;
  return useMemo(() => NAV.filter((entry) => (entry.href !== '/admin/ai' || aiEnabled) && (entry.href !== '/admin/agents' || agentsEnabled)), [aiEnabled, agentsEnabled]);
}
