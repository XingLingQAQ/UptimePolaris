import { maintenanceOccurrence } from '../settings/maintenance';
import type { MaintenanceWindow } from '../settings/store';
import { readAll } from '../settings/store';
import type { Env } from '../../types';
import type {
  MaintenanceContent,
  PublicMaintenancePeriod,
  PublicMaintenanceState,
} from '../../../../../shared/maintenance';

export type { PublicMaintenancePeriod } from '../../../../../shared/maintenance';
export interface MaintenanceOptions extends MaintenanceContent {
  enabled: boolean;
  announcement?: MaintenanceContent;
}

export function maintenanceState(
  windows: MaintenanceWindow[],
  at = new Date(),
  options: MaintenanceOptions = { enabled: false, title: '', description: '' },
): PublicMaintenanceState {
  const now = at.getTime();
  const periods = windows
    .map((window) => {
      const { start, end } = maintenanceOccurrence(window, at);
      return { start, end };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const active = periods.find(
    (period) => period.start <= now && now < period.end,
  );
  const project = (
    period: (typeof periods)[number],
  ): PublicMaintenancePeriod => ({
    title: options.announcement?.title.trim() ?? '',
    description: options.announcement?.description.trim() ?? '',
    startsAt: new Date(period.start).toISOString(),
    endsAt: new Date(period.end).toISOString(),
  });
  return {
    serverNow: at.toISOString(),
    active: options.enabled || Boolean(active),
    source: options.enabled
      ? ('manual' as const)
      : active
        ? ('scheduled' as const)
        : null,
    title: options.title.trim(),
    description: options.description.trim(),
    startsAt:
      !options.enabled && active ? new Date(active.start).toISOString() : null,
    endsAt:
      !options.enabled && active ? new Date(active.end).toISOString() : null,
    scheduled: periods.filter((period) => period.start > now).map(project),
  };
}

export async function publicMaintenance(env: Env) {
  const { values } = await readAll(env, true);
  return maintenanceState(
    values['maintenance.scheduleEnabled']
      ? (values['alerts.maintenanceWindows'] as MaintenanceWindow[])
      : [],
    new Date(),
    {
      enabled: values['maintenance.enabled'] === true,
      title: values['maintenance.title'] as string,
      description: values['maintenance.description'] as string,
      announcement: {
        title: values['maintenance.announcementTitle'] as string,
        description: values['maintenance.announcementDescription'] as string,
      },
    },
  );
}

/** The shape `Notices.tsx` consumes. Kept structural - the UI owns the full type. / `Notices.tsx` 消费的数据结构；此处只定义结构，完整类型由界面维护。 */
export interface PublicMaintenanceNotice {
  id: number;
  title: string;
  description: string;
  strategy: 'scheduled';
  intervalDay: number;
  active: boolean;
  dateRange: string[];
  timeRange: Array<{ hours: number; minutes: number }>;
  weekdays: number[];
  daysOfMonth: number[];
  timeslotList: Array<{ startDate: string; endDate: string }>;
  cron: string;
  durationMinutes: number | null;
  timezone: string;
  timezoneOption: string;
  /** `+00:00` - the windows are stored and evaluated in UTC. / `+00:00`：维护窗口按 UTC 存储和计算。 */
  timezoneOffset: string;
  status: 'under-maintenance' | 'scheduled';
}

/**
 * `YYYY-MM-DDTHH:MM:00Z` — an explicitly UTC instant.
 *
 * Without the `Z`, ECMAScript parses the string as local time: a UTC+8 browser
 * read a 17:00 UTC window as 09:00Z, then added the offset again for display,
 * so the notice showed a window that had already ended.
 * 去掉 Z 会被当成本地时间，UTC+8 浏览器会把窗口显示成已结束。
 */
function isoMinute(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00Z`
  );
}

/**
 * Build notices for every configured window.
 *
 * `now` is epoch seconds, the unit the rest of this Worker uses; date
 * arithmetic converts once at entry, because mixing units produced windows
 * dated 1970. A window without `active` is still listed: presence in the list
 * is the operator saying these hours matter.
 * now 用秒级时间戳，混用单位会生成 1970 年的窗口；窗口在列表中即表示启用。
 */
export function buildMaintenanceNotices(
  windows: MaintenanceWindow[],
  nowSeconds: number,
  content: MaintenanceContent = { title: '', description: '' },
): PublicMaintenanceNotice[] {
  const now = nowSeconds * 1000;
  return windows.flatMap((window, index) => {
    const { start, end } = maintenanceOccurrence(window, new Date(now));
    const active = start <= now && now < end;
    if (end <= now) return [];
    const starts = new Date(start),
      ends = new Date(end);
    const startTime = starts.toISOString().slice(11, 16),
      endTime = ends.toISOString().slice(11, 16);

    return {
      id: index + 1,
      title:
        content.title.trim() ||
        `${window.kind === 'once' ? starts.toISOString().slice(0, 10) + ' ' : ''}${startTime}–${endTime} UTC`,
      description: content.description.trim(),
      strategy: 'scheduled' as const,
      intervalDay: 0,
      active: true,
      dateRange: [isoMinute(start), isoMinute(end)],
      timeRange: [
        { hours: starts.getUTCHours(), minutes: starts.getUTCMinutes() },
        { hours: ends.getUTCHours(), minutes: ends.getUTCMinutes() },
      ],
      weekdays: window.kind === 'weekly' ? [window.day] : [],
      daysOfMonth: [],
      timeslotList: [{ startDate: isoMinute(start), endDate: isoMinute(end) }],
      cron: '',
      durationMinutes: Math.round((end - start) / 60_000),
      timezone: 'UTC',
      timezoneOption: 'UTC',
      timezoneOffset: '+00:00',
      status: active ? 'under-maintenance' : 'scheduled',
    };
  });
}
