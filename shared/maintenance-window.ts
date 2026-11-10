export type MaintenanceWindow =
  | { kind: 'weekly'; day: number; start: string; end: string }
  | { kind: 'once'; startsAt: string; endsAt: string };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 单次窗口须为 UTC 的 Z 时间；周窗口仅在此校验星期与时刻格式。 / One-off windows require UTC Z timestamps; weekly windows are checked here for day and time format only. */
export function parseWindow(value: unknown): MaintenanceWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.kind === 'once') {
    if (
      Object.keys(row).some(
        (key) => !['kind', 'startsAt', 'endsAt'].includes(key),
      )
    )
      return null;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
    if (
      typeof row.startsAt !== 'string' ||
      typeof row.endsAt !== 'string' ||
      !iso.test(row.startsAt) ||
      !iso.test(row.endsAt)
    )
      return null;
    const start = Date.parse(row.startsAt),
      end = Date.parse(row.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return null;
    if (
      new Date(start).toISOString().replace('.000Z', 'Z') !==
        row.startsAt.replace('.000Z', 'Z') ||
      new Date(end).toISOString().replace('.000Z', 'Z') !==
        row.endsAt.replace('.000Z', 'Z')
    )
      return null;
    return {
      kind: 'once',
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
    };
  }
  if (
    row.kind !== 'weekly' ||
    Object.keys(row).some(
      (key) => !['kind', 'day', 'start', 'end'].includes(key),
    )
  )
    return null;
  const { day, start, end } = row;
  if (
    typeof day !== 'number' ||
    !Number.isInteger(day) ||
    day < 0 ||
    day > 6 ||
    typeof start !== 'string' ||
    !HHMM.test(start) ||
    typeof end !== 'string' ||
    !HHMM.test(end) ||
    start === end
  )
    return null;
  return { kind: 'weekly', day, start, end };
}
