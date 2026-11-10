import { percentOf } from '@/lib/resource-metrics';
import type { FleetAgent } from './types';

export function peakResourcePercent(agent: FleetAgent): number | null {
  const values = [agent.cpu_usage, percentOf(agent.mem_used, agent.mem_total), percentOf(agent.disk_used, agent.disk_total)]
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}
