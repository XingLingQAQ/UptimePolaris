import assert from 'node:assert/strict';
import type { Env, Heartbeat, LiveState } from '../../backends/worker/src/types';
import { AE_POINT_LIMIT, aeLiteral, queryAnalytics, queryDaily, queryMonitorHistory, writeHeartbeatBatch } from '../../backends/worker/src/lib/analytics-engine';
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
const env = { UPTIME: { writeDataPoint: point => sent.push(point) }, CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-token' } as unknown as Env;

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
  let result: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    requests++; sql = String(init?.body);
    return Response.json({ data: result });
  };
  assert.equal(aeLiteral("a'\\b"), "'a\\'\\\\b'");
  assert.equal((await queryMonitorHistory({ ...env, CF_API_TOKEN: '' }, 'missing', now - 60, now)).status, 'unconfigured');
  assert.equal(requests, 0);
  result = [{ t: now, up: 1, ms: 7, sample_interval: 2 }];
  const [a, b] = await Promise.all([queryMonitorHistory(env, 'same', now - 60, now), queryMonitorHistory(env, 'same', now - 60, now)]);
  assert.equal(requests, 1);
  assert.deepEqual(a, b);
  assert.equal(a.sampled, true);
  assert.deepEqual(a.points, [{ t: now, up: 1, ms: 7 }]);
  assert.match(sql, /blob3 NOT IN/);
  await queryMonitorHistory({ ...env, CF_API_TOKEN: 'other-token' }, 'same', now - 60, now);
  assert.equal(requests, 2, 'query caches must not cross credentials');
  globalThis.fetch = async () => new Response('failed', { status: 503 });
  assert.equal((await queryMonitorHistory(env, 'failed', now - 60, now)).status, 'unavailable');
  globalThis.fetch = async () => Response.json({ unexpected: [] });
  await assert.rejects(queryAnalytics(env, 'invalid-response'), /invalid response/);

  globalThis.fetch = async (_url, init) => { sql = String(init?.body); return Response.json({ data: result }); };
  result = [{ idx: 'monitor', total: 2, up: 0, warn: 0, avg: 0, latency_count: 0 }];
  assert.equal((await queryDaily(env, '2026-11-13')).get('monitor')!.avg, null);
  assert.match(sql, /double4/);
  await assert.rejects(queryDaily(env, '2026-02-31'), /Invalid day/);

  result = [{ bucket_ts: now, sample_count: 3, cpu_samples: 2, mem_samples: 3, cpu_avg: -1, cpu_max: -1,
    mem_pct_avg: 50, mem_pct_max: 60, load_1_avg: -1, load_5_avg: 0, duration_sec: 60,
    net_up_bytes: 120, net_down_bytes: 300, network_duration_sec: 60, sample_interval: 1 }];
  const agent = await queryAgentHistory(env, 'agent', now - 60, now);
  assert.equal(agent.points[0].cpu_avg, null);
  assert.match(sql, /argMax\(double1, timestamp\)/);
  assert.match(sql, /GROUP BY double1/);
  assert.doesNotMatch(sql, /nullif|IS NOT NULL/i);
  result = [{ ...result[0], bucket_ts: null }, { ...result[0], duration_sec: null }];
  assert.equal((await queryAgentHistory(env, 'invalid-agent', now - 60, now)).points.length, 0, 'missing required fields are not zero-valued samples');
  result = [{ ...agent.points[0], network_duration_sec: 0, net_up_bytes: -1, net_down_bytes: -1, idx: 'no-network' }];
  const noNetwork = (await queryAgentDaily(env, '2026-11-12')).get('no-network')!;
  assert.equal(noNetwork.net_up_bytes, null);
  assert.equal(noNetwork.network_duration_sec, 0);
  const base = { ...agent.points[0], cpu_avg: 30, cpu_samples: 2 } as AgentHistoryBucket;
  const combined = aggregateAgentHistory([base, { ...base, bucket_ts: now + 60, cpu_avg: 60, cpu_samples: 4, net_up_bytes: 240, network_duration_sec: 120 }]);
  assert.equal(combined.length, 1);
  assert.equal(combined[0].cpu, 50);
  assert.equal(combined[0].net_up, 2, 'byte deltas are divided by measured seconds');
  result = [{ ...result[0], idx: 'agent', sample_interval: 2 }];
  assert.equal((await queryAgentDaily(env, '2026-11-13')).get('agent')!.sampled, true);
  assert.match(sql, /GROUP BY index1, double1/);
  assert.doesNotMatch(sql, /nullif|IS NOT NULL/i);
  console.log('PASS AE budgets, rotation, query isolation, failure states, nullable metrics, exact availability and weighted resource history');
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  console.error = originalError;
}
