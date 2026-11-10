import { DOWN, PENDING, UP, WARN, type DayStat, type LiveEntry, type LiveState, type RingHeartbeat } from '../../types';

const WINDOW_MINUTES = 1440;
const STATUS_CODE: Record<number, number> = { [DOWN]: 1, [UP]: 2, [WARN]: 3, [PENDING]: 4 };

/** Store 1440 three-bit slots as v1: plus base64 (723 characters); the 100-point heartbeat ring cannot represent a full day. / 将 1440 个三位槽编码为 v1: 加 base64（723 个字符）；100 点心跳环无法表示完整一天。 */
const PACKED_PREFIX = 'v1:';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Reverse of `BASE64`; -1 marks a character outside the alphabet. / `BASE64` 的反向映射；-1 表示字符不在字母表中。 */
const BASE64_INDEX = (() => {
  const index = new Int16Array(128).fill(-1);
  for (let value = 0; value < BASE64.length; value++) index[BASE64.charCodeAt(value)] = value;
  return index;
})();
/** 8 slots x 3 bits = 24 bits = exactly 4 base64 characters. / 8 个槽 x 3 位 = 24 位，正好对应 4 个 base64 字符。 */
const PACKED_GROUP = 8;
const PACKED_GROUPS = WINDOW_MINUTES / PACKED_GROUP;
const PACKED_LENGTH = PACKED_PREFIX.length + PACKED_GROUPS * 4;

/** Pack 1440 slots; missing slots are unobserved (0). / 打包 1440 个槽；缺失槽视为未观测（0）。 */
export function packMinutes(minutes: readonly number[]): string {
  let packed = PACKED_PREFIX;
  for (let group = 0; group < PACKED_GROUPS; group++) {
    const base = group * PACKED_GROUP;
    let bits = 0;
    for (let slot = 0; slot < PACKED_GROUP; slot++) bits = (bits << 3) | ((minutes[base + slot] ?? 0) & 7);
    packed += BASE64[(bits >>> 18) & 63] + BASE64[(bits >>> 12) & 63] + BASE64[(bits >>> 6) & 63] + BASE64[bits & 63];
  }
  return packed;
}

/** Invalid windows contain no observations. / 无效窗口不包含观测值。 */
export function unpackMinutes(minutes: string | undefined): number[] {
  if (typeof minutes !== 'string' || minutes.length !== PACKED_LENGTH || !minutes.startsWith(PACKED_PREFIX)) {
    return new Array<number>(WINDOW_MINUTES).fill(0);
  }
  const window = new Array<number>(WINDOW_MINUTES).fill(0);
  for (let group = 0; group < PACKED_GROUPS; group++) {
    const at = PACKED_PREFIX.length + group * 4;
    let bits = 0;
    for (let slot = 0; slot < 4; slot++) {
      const code = minutes.charCodeAt(at + slot);
      const value = code < 128 ? BASE64_INDEX[code]! : -1;
      if (value < 0) return new Array<number>(WINDOW_MINUTES).fill(0);
      bits = (bits << 6) | value;
    }
    for (let slot = 0; slot < PACKED_GROUP; slot++) {
      window[group * PACKED_GROUP + slot] = (bits >>> ((7 - slot) * 3)) & 7;
    }
  }
  return window;
}

export type CompletedAvailabilityDays = Map<string, DayStat>;

export function closeEndedAvailabilityDays(state: LiveState, today: string): CompletedAvailabilityDays {
  const completed = new Map<string, DayStat>();
  for (const [id, entry] of Object.entries(state)) {
    const daily = entry.availability?.daily;
    if (!daily || daily[0] >= today) continue;
    completed.set(id, { d: daily[0], t: daily[1], u: daily[2], w: daily[3], avg: null, exact: true });
    entry.availability!.daily = null;
  }
  return completed;
}

export function preserveAvailability<T extends LiveState[string]>(entry: T, previous?: LiveState[string]): T {
  const current = previous?.availability ?? entry.availability;
  return {
    ...entry,
    ...(current ? {
      availability: {
        endMinute: current.endMinute,
        minutes: current.minutes,
        daily: current.daily ? [...current.daily] as [string, number, number, number] : null,
      },
    } : {}),
  };
}

/** 写入分钟观测并返回跨 UTC 日界线后完成的日统计。 / Record a minute observation and return daily statistics completed across the UTC day boundary. */
export function recordAvailability(state: LiveState, observations: Map<string, RingHeartbeat>): CompletedAvailabilityDays {
  const completed = new Map<string, DayStat>();
  for (const [id, observation] of observations) {
    const mark = STATUS_CODE[observation.up];
    if (!mark) continue;
    const entry = state[id];
    if (!entry) continue;

    const minute = Math.floor(observation.t / 60);
    const dayNumber = Math.floor(observation.t / 86400);
    const day = new Date(dayNumber * 86400_000).toISOString().slice(0, 10);
    const availability: LiveEntry['availability'] = entry.availability ?? { endMinute: minute, minutes: packMinutes([]), daily: null };
    /** Decode once, apply the observation, then repack. / 解码一次，应用观测值后重新打包。 */
    const minutes = unpackMinutes(availability.minutes);
    const previousEnd = availability.endMinute;
    const index = ((minute % WINDOW_MINUTES) + WINDOW_MINUTES) % WINDOW_MINUTES;
    const previous = minute <= previousEnd && minute > previousEnd - WINDOW_MINUTES
      ? minutes[index]!
      : 0;
    if (minute > previousEnd) {
      // 清空跨过的环形槽位，避免旧一天的数据被误认为新观测。
      // Clear skipped ring slots so old-day data cannot be mistaken for new observations.
      const gap = minute - previousEnd;
      if (gap >= WINDOW_MINUTES) minutes.fill(0);
      else {
        for (let next = previousEnd + 1; next <= minute; next++) {
          const index = ((next % WINDOW_MINUTES) + WINDOW_MINUTES) % WINDOW_MINUTES;
          minutes[index] = 0;
        }
      }
      availability.endMinute = minute;
    }

    const oldest = availability.endMinute - WINDOW_MINUTES + 1;
    if (minute >= oldest && minute <= availability.endMinute) {
      minutes[index] = mark;
    }

    if (availability.daily && availability.daily[0] < day) {
      const [closedDay, total, up, warn] = availability.daily;
      completed.set(id, { d: closedDay, t: total, u: up, w: warn, avg: null, exact: true });
      availability.daily = null;
    }
    if (!availability.daily || availability.daily[0] < day) availability.daily = [day, 0, 0, 0];
    if (availability.daily[0] === day) {
      // 同一分钟可被覆盖：先扣除旧状态，再计入新状态。
      // A minute can be overwritten: subtract its old state before counting the new one.
      if (previous === 0) availability.daily[1] += 1;
      availability.daily[2] += Number(mark === 2 || mark === 4) - Number(previous === 2 || previous === 4);
      availability.daily[3] += Number(mark === 3) - Number(previous === 3);
    }
    entry.availability = { endMinute: availability.endMinute, minutes: packMinutes(minutes), daily: availability.daily };
  }
  return completed;
}

export function rollingAvailability(entry: LiveState[string] | undefined, now: number): { ratio: number | null; coverage: number } {
  const availability = entry?.availability;
  if (!availability) return { ratio: null, coverage: 0 };

  const minutes = unpackMinutes(availability.minutes);
  const end = Math.floor(now / 60);
  const start = Math.max(end - WINDOW_MINUTES + 1, availability.endMinute - WINDOW_MINUTES + 1);
  const stop = Math.min(end, availability.endMinute);
  let observed = 0;
  let available = 0;
  // 可用率只以已观测分钟为分母；覆盖率仍以完整一天为分母。
  // Availability uses observed minutes as its denominator; coverage uses the full day.
  for (let minute = start; minute <= stop; minute++) {
    const index = ((minute % WINDOW_MINUTES) + WINDOW_MINUTES) % WINDOW_MINUTES;
    const status = minutes[index];
    if (status === 0) continue;
    observed += 1;
    if (status === 2 || status === 3 || status === 4) available += 1;
  }
  return observed === 0
    ? { ratio: null, coverage: 0 }
    : { ratio: available / observed, coverage: observed / WINDOW_MINUTES };
}
