import type { Env } from '../../types';
import type { MaintenanceWindow } from './store';
import { readAll } from './store';

/** 计算包含当前时间或接下来一次的 UTC 周期维护窗口。 / Calculate the current or next recurring UTC maintenance window. */
export function maintenanceOccurrence(win: MaintenanceWindow, at: Date): { start: number; end: number } {
  if (win.kind === 'once') return { start: Date.parse(win.startsAt), end: Date.parse(win.endsAt) };
  const [startHour, startMinute] = win.start.split(':').map(Number);
  const [endHour, endMinute] = win.end.split(':').map(Number);
  const daysSince = (at.getUTCDay() - win.day + 7) % 7;
  let start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - daysSince, startHour, startMinute);
  let end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - daysSince, endHour, endMinute);
  // 结束时间不晚于开始时间时，窗口跨越 UTC 午夜。
  // An end time no later than the start crosses UTC midnight.
  if (end <= start) end += 86_400_000;
  if (end <= at.getTime()) {
    start += 7 * 86_400_000;
    end += 7 * 86_400_000;
  }
  return { start, end };
}

export function windowContains(win: MaintenanceWindow, at: Date): boolean {
  const { start, end } = maintenanceOccurrence(win, at);
  return start <= at.getTime() && at.getTime() < end;
}

export function activeWindow(windows: MaintenanceWindow[], at: Date): MaintenanceWindow | null {
  return windows.find((win) => windowContains(win, at)) ?? null;
}

/** 根据站点配置判断指定时刻是否暂停告警。 / Determine whether site settings pause alerts at the given time. */
export async function alertsSuppressed(env: Env, at: Date): Promise<{ suppressed: boolean; note: string }> {
  const { values } = await readAll(env);
  const windows = values['alerts.maintenanceWindows'] as MaintenanceWindow[];
  return {
    suppressed: values['maintenance.enabled'] === true || values['maintenance.scheduleEnabled'] === true && activeWindow(windows, at) !== null,
    note: values['alerts.maintenanceNote'] as string,
  };
}
