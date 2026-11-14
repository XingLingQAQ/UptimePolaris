// 验证历史保留与汇总写入约束。
// Check history retention and aggregation write constraints.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import { upsertDay, prepareAvailabilityDayWrites } from './backends/worker/src/lib/monitor/store';
    import { resetSettingsCache } from './backends/worker/src/lib/settings/store';
    import { getDB } from './backends/worker/src/lib/db/factory';
    export default { async fetch(request, env) {
      const { id, day, batch } = await request.json();
      resetSettingsCache();
      if (batch) await getDB(env).commit(await prepareAvailabilityDayWrites(env, new Map([[id, day]]), day.ts));
      else await upsertDay(env, id, day);
      return Response.json({ ok: true });
    }};
  ` },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'error',
  plugins: [{ name: 'unused-postgres', setup(b) {
    b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function(){throw Error("unexpected postgres")}' }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'retention-writes' }, kvNamespaces: { CONFIG: 'retention-writes-config' } });
try {
  const db = await mf.getD1Database('DB');
  const kv = await mf.getKVNamespace('CONFIG');
  await db.exec('CREATE TABLE monitor_uptime(monitor_id TEXT PRIMARY KEY,days_json TEXT,updated_at INTEGER);');
  const today = Math.floor(Date.now() / 86400000) * 86400;
  const day = offset => ({ d: new Date((today + offset * 86400) * 1000).toISOString().slice(0, 10), t: 1, u: 1, w: 0, avg: null, exact: true });
  const history = Array.from({ length: 500 }, (_, index) => day(index - 500));
  for (const batch of [false, true]) {
    const id = batch ? 'batch' : 'single';
    for (const [limit, expected] of [[3650, 501], [450, 450], [7, 7]]) {
      await kv.put('settings', JSON.stringify({ 'retention.availabilityDays': limit }));
      await db.prepare('INSERT OR REPLACE INTO monitor_uptime VALUES(?,?,0)').bind(id, JSON.stringify(history)).run();
      const response = await mf.dispatchFetch('http://localhost/write', { method: 'POST', body: JSON.stringify({ id, day: { ...day(0), ts: today }, batch }) });
      assert.equal(response.status, 200, await response.text());
      const row = await db.prepare('SELECT days_json FROM monitor_uptime WHERE monitor_id=?').bind(id).first();
      const result = JSON.parse(row.days_json);
      assert.equal(result.length, expected, `${id}: configured ${limit} days`);
      assert.equal(result.at(-1).d, day(0).d);
    }
  }
  console.log('PASS both Worker daily writers use configured retention above and below 400 days');
} finally {
  await mf.dispose();
}
