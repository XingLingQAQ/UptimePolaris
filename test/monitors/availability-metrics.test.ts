import assert from 'node:assert/strict';
import { DOWN, PENDING, UP, WARN, type LiveState } from '../../backends/worker/src/types';
import {
  closeEndedAvailabilityDays,
  packMinutes,
  preserveAvailability,
  recordAvailability,
  rollingAvailability,
  unpackMinutes,
} from '../../backends/worker/src/lib/monitor/availability';
import { calculateLatencyMetrics, calculateLatencyStats } from '../../frontend/src/components/charts/metrics';
import type { Heartbeat } from '../../frontend/src/types/monitor';

const makeState = (): LiveState => ({ monitor: { st: UP, ts: 0, v: 1, code: 0, msg: '', fails: 0 } });
const point = (t: number, up: number, ms: number | null = 10) => ({ t, up, ms });

const empty = rollingAvailability(undefined, 1_800_000);
assert.deepEqual(empty, { ratio: null, coverage: 0 });

const state = makeState();
const dayOneEnd = Date.UTC(2026, 0, 1, 23, 59) / 1000;
const firstDayClose = recordAvailability(state, new Map([
  ['monitor', point(dayOneEnd, UP)],
  ['pending', point(dayOneEnd, PENDING)],
]));
recordAvailability(state, new Map([['monitor', point(dayOneEnd, DOWN)]]));
assert.deepEqual(rollingAvailability(state.monitor, dayOneEnd), { ratio: 0, coverage: 1 / 1440 });
assert.deepEqual(state.monitor.availability?.daily, ['2026-01-01', 1, 0, 0]);
assert.equal(firstDayClose.size, 0);

const acrossUtcMidnight = dayOneEnd + 60;
const completed = recordAvailability(state, new Map([
  ['monitor', point(acrossUtcMidnight, WARN)],
  ['monitor2', point(acrossUtcMidnight, UP)],
]));
assert.deepEqual(completed.get('monitor'), { d: '2026-01-01', t: 1, u: 0, w: 0, avg: null, exact: true });
assert.deepEqual(state.monitor.availability?.daily, ['2026-01-02', 1, 0, 1]);
assert.equal(rollingAvailability(state.monitor, acrossUtcMidnight).ratio, 0.5);
assert.equal(rollingAvailability(state.monitor, acrossUtcMidnight).coverage, 2 / 1440);

const currentMinute = Math.floor(acrossUtcMidnight / 60);
const endMinute = state.monitor.availability!.endMinute;
assert.equal(rollingAvailability(state.monitor, acrossUtcMidnight).coverage, 2 / 1440);

const lateMinute = acrossUtcMidnight - 120;
recordAvailability(state, new Map([['monitor', point(lateMinute, UP)]]));
assert.equal(state.monitor.availability!.endMinute, endMinute);
assert.equal(rollingAvailability(state.monitor, acrossUtcMidnight).coverage, 3 / 1440);
assert.equal(rollingAvailability(state.monitor, acrossUtcMidnight).ratio, 2 / 3);
recordAvailability(state, new Map([['monitor', point(acrossUtcMidnight + 60, PENDING)]]));
assert.equal(rollingAvailability(state.monitor, acrossUtcMidnight + 60).ratio, 0.75);
const pendingState = makeState();
recordAvailability(pendingState, new Map([['monitor', point(acrossUtcMidnight, PENDING)]]));
assert.equal(rollingAvailability(pendingState.monitor, acrossUtcMidnight).ratio, 1);

const endedState = makeState();
endedState.monitor.availability = { endMinute: 1, minutes: [2], daily: ['2026-01-01', 1, 1, 0] };
const ended = closeEndedAvailabilityDays(endedState, '2026-01-02').get('monitor');
assert.deepEqual(ended, { d: '2026-01-01', t: 1, u: 1, w: 0, avg: null, exact: true });
assert.equal(endedState.monitor.availability?.daily, null);

const heartbeats: Heartbeat[] = [
  { status: 1, time: '2026-01-01T00:00:00.000Z', msg: '', ping: 0 },
  { status: 2, time: '2026-01-01T00:01:00.000Z', msg: '', ping: 20 },
  { status: 0, time: '2026-01-01T00:02:00.000Z', msg: '', ping: null },
];
assert.deepEqual(calculateLatencyMetrics(heartbeats), { latestPing: null, avgPing: 10, trimmedAvgPing: 10 });
assert.deepEqual(calculateLatencyStats(heartbeats), { min: 0, p25: 0, p50: 20, p75: 20, max: 20 });
assert.deepEqual(calculateLatencyMetrics([
  { ...heartbeats[0]!, status: 0, ping: null },
]), null);

{
  const allValues = Array.from({ length: 1440 }, (_, i) => i % 5);
  assert.deepEqual(unpackMinutes(packMinutes(allValues)), allValues, 'every status round-trips');
  assert.equal(packMinutes(allValues).slice(0, 3), 'v1:');
  // 1440 slots / 8 per group * 4 base64 chars, plus the prefix.
  // 1440 个槽位，每组 8 个对应 4 个 Base64 字符，另加前缀。
  assert.equal(packMinutes(allValues).length, 3 + (1440 / 8) * 4);
  assert.deepEqual(unpackMinutes(packMinutes(new Array(1440).fill(0))), new Array(1440).fill(0));

  // Damage reads as an empty window rather than throwing inside a tick.
  // 损坏数据读取为空窗口，而非在 tick 中抛错。
  const emptyWindow = new Array(1440).fill(0);
  assert.deepEqual(unpackMinutes(undefined), emptyWindow);
  assert.deepEqual(unpackMinutes('nonsense'), emptyWindow);
  assert.deepEqual(unpackMinutes('v2:' + packMinutes(allValues).slice(3)), emptyWindow);
  assert.deepEqual(unpackMinutes(packMinutes(allValues).slice(0, 40)), emptyWindow);
  assert.deepEqual(unpackMinutes(`${packMinutes(allValues).slice(0, 10)}${'\u00e9'}${packMinutes(allValues).slice(11)}`), emptyWindow);

  /*
    End to end through `recordAvailability`: after a write the entry holds the
    packed form, and the reader returns exactly what the array form returned.
    经 recordAvailability 端到端验证：写入后条目保存打包格式，读取结果与数组格式完全一致。
  */
  const packedState = makeState();
  recordAvailability(packedState, new Map([['monitor', point(dayOneEnd, UP)]]));
  recordAvailability(packedState, new Map([['monitor', point(dayOneEnd + 60, DOWN)]]));
  assert.equal(typeof packedState.monitor.availability?.minutes, 'string');
  assert.deepEqual(rollingAvailability(packedState.monitor, dayOneEnd + 60), {
    ratio: 0.5,
    coverage: 2 / 1440,
  });

  const packedPrevious = { st: UP, ts: 0, v: 1, code: 0, msg: '', fails: 0, availability: { endMinute: 5, minutes: packMinutes(allValues), daily: ['2026-01-01', 1, 1, 0] as [string, number, number, number] } };
  const packedCarried = preserveAvailability({ st: UP, ts: 1, v: 1, code: 0, msg: '', fails: 0 }, packedPrevious);
  assert.equal(packedCarried.availability?.minutes, packedPrevious.availability.minutes, 'packed string is immutable and shared');
}

console.log('PASS rolling availability windows, coverage, UTC days, duplicate and late samples, packed encoding round-trip, and nullable ping metrics');
