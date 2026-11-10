export type GroupType = 'monitor' | 'agent' | 'common';
export interface ManagedGroup {
  key: string;
  name: string;
  type: GroupType;
  weight: number;
  monitorId: string | null;
  agentId: string | null;
  monitorCount: number;
  agentCount: number;
}
