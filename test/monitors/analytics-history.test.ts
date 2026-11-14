import assert from 'node:assert/strict';
import type { Env, Heartbeat, LiveState } from '../../backends/worker/src/types';
import { AE_POINT_LIMIT, queryAnalytics, queryDaily, queryMonitorHistory, writeHeartbeatBatch } from '../../backends/worker/src/lib/analytics-engine';
import { queryAgentDaily, queryAgentHistory, type AgentHistoryBucket } from '../../backends/worker/src/lib/agent/history';
import { aggregateAgentHistory } from '../../backends/worker/src/lib/agent/detail';
import { recordAvailability, rollingAvailability } from '../../backends/worker/src/lib/monitor/availability';
import { mergeDayObservation } from '../../backends/worker/src/lib/monitor/daily-stats';
import { expandHeartbeatHistory } from '../../backends/worker/src/lib/monitor/store';

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const originalError = console.error;
const warnings: string[] = [];
console.warn = value => warnings.push(String(value));
console.error = () => {};
const now = 1794614400;
const sent: Parameters<AnalyticsEngineDataset['writeDataPoint']>[0][] = [];
const env = { UPTIME: { writeDataPoint: point => sent.push(point) } } as unknown as Env;

try {
  const observations = Array.from({ length: 501 }, (_, index): Heartbeat => ({
    monitorId: String(index).padStart(4, '0'), ts: now, status: 1, latencyMs: index, statusCode: 200, message: '',
  }));
  writeHeartbeatBatch(env, observations, now);
  assert.equal(sent.length, AE_POINT_LIMIT);
  const first = new Set(sent.map(point => point.indexes![0]));
  sent.length = 0;
  writeHeartbeatBatch(env, observations, now + 60);
  writeHeartbeatBatch(env, observations, now + 120);
  assert.equal(sent.length, 2 * AE_POINT_LIMIT);
  assert.equal(new Set([...first, ...sent.map(point => point.indexes![0])]).size, 501);
  assert.ok(warnings.every(message => JSON.parse(message).event === 'history_write_partial'));

  const state = { monitor: { st: 1, ts: now, v: 5, code: 200, msg: '', fails: 0 } } as LiveState;
  recordAvailability(state, new Map([['monitor', { t: now, up: 1, ms: 5 }]]));
  recordAvailability(state, new Map([['monitor', { t: now + 60, up: 1, ms: 8 }]]));
  recordAvailability(state, new Map([['monitor', { t: now + 180, up: 0, ms: null }]]));
  state.monitor.st = 0;
  const history = expandHeartbeatHistory(state.monitor, [{ t: now, up: 1, ms: 5 }, { t: now + 180, up: 0, ms: null }]);
  assert.deepEqual(history, [{ t: now, up: 1, ms: 5 }, { t: now + 60, up: 1, ms: null }, { t: now + 180, up: 0, ms: null }]);
  assert.equal(rollingAvailability(state.monitor, now + 180).coverage, 3 / 1440);
  assert.ok(!history.some(point => point.t === now + 120));
  state.monitor.st = 1;
  state.monitor.ts = now + 240;
  assert.equal(expandHeartbeatHistory(state.monitor, [{ t: now, up: 1, ms: 5 }, { t: now + 180, up: 0, ms: null }]).at(-1)!.up, 0,
    'an uncompleted check cannot relabel the last real observation');
  assert.deepEqual(expandHeartbeatHistory(undefined, []), []);

  const exact = { d: '2026-11-13', t: 10, u: 8, w: 1, avg: null, exact: true };
  const aggregate = { d: exact.d, t: 300, u: 100, w: 0, avg: 12, avg_source: 'ae' as const };
  const merged = mergeDayObservation(exact, aggregate);
  assert.deepEqual(merged, { ...exact, avg: 12, avg_source: 'ae' });
  assert.equal(mergeDayObservation(merged, { ...aggregate, avg: 14 }).avg, 14, 'overlap refreshes the AE latency only');
  assert.equal(mergeDayObservation({ ...exact, avg: 9 }, aggregate).avg, 9, 'a measured local average remains authoritative');

  let requests = 0;
  let sql = '';
  let params: AnalyticsSQLQuery['params'];
  let result: unknown = { data: [] };
  let failure: Error | undefined;
  const queries: string[] = [];
  const query = async (request: AnalyticsSQLQuery) => {
    requests++;
    sql = request.query;
    params = request.params;
    queries.push(sql);
    if (failure) throw failure;
    return result;
  };
  const binding = { query } as unknown as AnalyticsSQLBinding;
  env.ANALYTICS_SQL = binding;
  globalThis.fetch = async () => { throw new Error('Analytics reads must use the binding'); };
  assert.equal((await queryMonitorHistory({ ...env, ANALYTICS_SQL: undefined }, 'missing', now - 60, now)).status, 'unconfigured');
  assert.equal(requests, 0);
  result = { data: [{ t: now, up: 1, ms: 7, sample_interval: 2 }] };
  const [a, b] = await Promise.all([queryMonitorHistory(env, 'same', now - 60, now), queryMonitorHistory(env, 'same', now - 60, now)]);
  assert.equal(requests, 1);
  assert.deepEqual(a, b);
  assert.equal(a.sampled, true);
  assert.deepEqual(a.points, [{ t: now, up: 1, ms: 7 }]);
  assert.match(sql, /blob3 NOT IN/);
  await queryMonitorHistory({ ...env, ANALYTICS_SQL: { query } as unknown as AnalyticsSQLBinding }, 'same', now - 60, now);
  assert.equal(requests, 2, 'query caches must not cross bindings');
  const hostileId = "a'\\b";
  await queryMonitorHistory(env, hostileId, now - 60, now);
  assert.equal(requests, 3, 'different parameters must not share cached rows');
  assert.equal((params as Record<string, unknown>).id, hostileId);
  assert.ok(!sql.includes(hostileId));
  failure = new Error('fixture failure');
  assert.equal((await queryMonitorHistory(env, 'failed', now - 60, now)).status, 'unavailable');
  failure = undefined;
  result = { unexpected: [] };
  await assert.rejects(queryAnalytics(env, 'invalid-response'), /invalid response/);
  result = { data: [null] };
  await assert.rejects(queryAnalytics(env, 'invalid-row'), /invalid response/);

  result = { data: [{ idx: 'monitor', total: 2, up: 0, warn: 0, avg: 0, latency_count: 0 }] };
  assert.equal((await queryDaily(env, '2026-11-13')).get('monitor')!.avg, null);
  assert.match(sql, /double4/);
  assert.match(sql, /COUNT\(\) AS total/);
  assert.match(sql, /avgIf\(double1, double2 IN \(1, 2\)\)/);
  assert.equal((params as Record<string, unknown>).start, Date.parse('2026-11-13T00:00:00Z') / 1000);
  await assert.rejects(queryDaily(env, '2026-02-31'), /Invalid day/);

  const summary = { bucket_ts: now, sample_count: 3, cpu_samples: 2, mem_samples: 3, cpu_avg: -1, cpu_max: -1,
    mem_pct_avg: 50, mem_pct_max: 60, load_1_avg: -1, load_5_avg: 0, duration_sec: 60,
    net_up_bytes: 120, net_down_bytes: 300, network_duration_sec: 60, sample_interval: 1 };
  result = { data: [summary] };
  const agent = await queryAgentHistory(env, 'agent', now - 60, now);
  assert.equal(agent.points[0].cpu_avg, null);
  assert.match(sql, /argMax\(double1, timestamp\)/);
  assert.match(sql, /GROUP BY double1/);
  assert.doesNotMatch(sql, /FROM\s*\(|nullif|IS NOT NULL/i);
  result = { data: [{ ...summary, bucket_ts: null }, { ...summary, duration_sec: null }] };
  assert.equal((await queryAgentHistory(env, 'invalid-agent', now - 60, now)).points.length, 0, 'missing required fields are not zero-valued samples');
  result = { data: [{ ...summary, network_duration_sec: 0, net_up_bytes: -1, net_down_bytes: -1 }] };
  const noNetwork = (await queryAgentDaily(env, '2026-11-13', ['no-network'])).get('no-network')!;
  assert.equal(noNetwork.net_up_bytes, null);
  assert.equal(noNetwork.network_duration_sec, 0);
  assert.equal(noNetwork.cpu_avg, null);
  const base = { ...agent.points[0], cpu_avg: 30, cpu_samples: 2 } as AgentHistoryBucket;
  const combined = aggregateAgentHistory([base, { ...base, bucket_ts: now + 60, cpu_avg: 60, cpu_samples: 4, net_up_bytes: 240, network_duration_sec: 120 }]);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].cpu, 50);
  assert.equal(combined[0].net_up, 2, 'byte deltas are divided by measured seconds');
  result = { data: [
    { ...summary, cpu_avg: 30, cpu_max: 45, load_1_avg: 1 },
    { ...summary, bucket_ts: now + 60, cpu_avg: 60, cpu_max: 70, cpu_samples: 4, sample_count: 6,
      mem_pct_avg: 80, mem_pct_max: 90, mem_samples: 6, duration_sec: 120, load_1_avg: 3,
      net_up_bytes: 480, net_down_bytes: 600, network_duration_sec: 120, sample_interval: 2 },
  ] };
  const before = requests;
  const daily = (await queryAgentDaily(env, '2026-11-13', ['agent', 'agent'])).get('agent')!;
  assert.equal(requests, before + 1, 'duplicate agent IDs do not repeat queries');
  assert.equal(daily.sampled, true);
  assert.equal(daily.cpu_avg, 54);
  assert.equal(daily.cpu_max, 70);
  assert.equal(daily.mem_pct_avg, 74);
  assert.equal(daily.load_1_avg, 2.6);
  assert.equal(daily.sample_count, 15);
  assert.equal(daily.duration_sec, 300);
  assert.equal(daily.net_up_bytes, 1080);
  assert.equal(daily.net_down_bytes, 1500);
  assert.equal(daily.network_duration_sec, 300);
  assert.match(sql, /GROUP BY double1/);
  assert.ok(queries.every(query => query.includes('FROM events.analyticsEngine."uptime_heartbeats"') || query.startsWith('invalid-')));
  assert.ok(queries.every(query => !/FORMAT|_sample_interval|accountTag|scope/i.test(query)));
  console.log('PASS AE budgets, rotation, query isolation, failure states, nullable metrics, exact availability and weighted resource history');
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.error = originalError;
}
