import { getMonitorStatusKey } from '@/lib/monitor-status';
import type { HeartbeatData, Monitor, MonitorFilterStatus } from '@/types/monitor';

export const filterMonitorByStatus = (
  monitor: Monitor,
  filterStatus: MonitorFilterStatus,
  heartbeatList: HeartbeatData
) => {
  if (filterStatus === 'all') return true;
  const lastHeartbeat = heartbeatList[monitor.id]?.at(-1);
  if (!lastHeartbeat) return false;
  return getMonitorStatusKey(lastHeartbeat.status, monitor.sourceAvailable !== false) === filterStatus;
};
