import type { OverviewMonitor } from '../monitors/types';
import type { AdminEvent } from '../overview-types';

export interface EventRow extends AdminEvent {
  /** The monitor's name, or null when it has since been deleted. / 监控项名称；已删除时为 null。 */
  name: string | null;
  monitor: OverviewMonitor | null;
}

/** Events joined to the monitors they belong to, newest first. / 将事件与所属监控项关联，按时间从新到旧。 */
export function joinEvents(events: AdminEvent[], monitors: OverviewMonitor[]): EventRow[] {
  const byId = new Map(monitors.map((m) => [m.id, m]));
  return [...events]
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id)
    .map((event) => {
      const monitor = byId.get(event.monitor_id) ?? null;
      return { ...event, name: monitor?.name ?? null, monitor };
    });
}

/** Down transitions since local midnight - "how bad has today been". / 自本地午夜以来转为故障的次数，表示今日故障情况。 */
export function incidentsToday(events: AdminEvent[]): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.getTime() / 1000;
  return events.filter((e) => e.status === 0 && e.created_at >= since).length;
}
