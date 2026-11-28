import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { migrationPlan } from '../../scripts/db/build-schema-bootstrap.mjs';
import { workerBundlePlugins } from '../helpers/bundle-worker.mjs';

const bundle = await build({
  entryPoints: ['backends/worker/src/lib/db/bootstrap.ts'],
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: workerBundlePlugins(),
});
const { bootstrapSchema } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const plan = migrationPlan();
const ledgerDDL = 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
const mf = new Miniflare({
  modules: true, script: 'export default { fetch() { return new Response("fixture"); } };',
  compatibilityDate: '2025-01-01',
  d1Databases: Object.fromEntries(['EMPTY', 'UPGRADE', 'RACE', 'RETRY', 'UNTRACKED'].map(name => [name, name])),
});

function track(db, { afterRead, beforeBatch } = {}) {
  const calls = { reads: 0, writes: 0, batches: 0 };
  const originals = new WeakMap();
  function wrap(statement, sql) {
    const wrapped = {
      bind(...params) { return wrap(statement.bind(...params), sql); },
      async all() {
        calls.reads++;
        const result = await statement.all();
        await afterRead?.(sql);
        return result;
      },
      async run() { calls.writes++; return statement.run(); },
    };
    originals.set(wrapped, statement);
    return wrapped;
  }
  const binding = {
    prepare(sql) { return wrap(db.prepare(sql), sql); },
    async batch(statements) {
      calls.batches++;
      await beforeBatch?.();
      return db.batch(statements.map(statement => originals.get(statement)));
    },
  };
  return { env: { DB: binding }, calls };
}

async function seed(db, files) {
  await db.prepare(ledgerDDL).run();
  for (const file of files) {
    await db.batch([
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file.name),
      ...file.statements.map(sql => db.prepare(sql)),
    ]);
  }
}

async function names(db) {
  const result = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all();
  return result.results.map(row => row.name);
}

try {
  const empty = await mf.getD1Database('EMPTY');
  const first = track(empty);
  assert.deepEqual(await bootstrapSchema(first.env), { created: true, applied: plan.map(file => file.name) });
  assert.deepEqual(await names(empty), plan.map(file => file.name));
  const warmCalls = { ...first.calls };
  assert.deepEqual(await bootstrapSchema(first.env), { created: false, applied: [] });
  assert.deepEqual(first.calls, warmCalls, 'same binding should use the successful bootstrap cache');

  const cold = track(empty);
  assert.deepEqual(await bootstrapSchema(cold.env), { created: false, applied: [] });
  console.log(`CHECKPOINT migrated cold start: ${JSON.stringify(cold.calls)}, migrations=${plan.length}`);
  assert.equal(cold.calls.batches, 0, 'an existing database must not attempt completed migrations');
  assert.ok(cold.calls.reads <= 2, 'cold checks must not grow with migration count');

  const upgrade = await mf.getD1Database('UPGRADE');
  await seed(upgrade, plan.slice(0, -1));
  await upgrade.prepare('CREATE TABLE fixture_data (value TEXT)').run();
  await upgrade.prepare("INSERT INTO fixture_data VALUES ('preserved')").run();
  const upgrading = track(upgrade);
  assert.deepEqual(await bootstrapSchema(upgrading.env), { created: true, applied: [plan.at(-1).name] });
  assert.equal(upgrading.calls.batches, 1);
  assert.deepEqual(await names(upgrade), plan.map(file => file.name));
  assert.equal((await upgrade.prepare('SELECT value FROM fixture_data').first()).value, 'preserved');

  const race = await mf.getD1Database('RACE');
  await seed(race, plan.slice(0, -1));
  let arrivals = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { async afterRead(sql) {
    if (sql !== 'SELECT name FROM d1_migrations') return;
    if (++arrivals === 2) release();
    await gate;
  } };
  const contenders = [track(race, options), track(race, options)];
  const results = await Promise.all(contenders.map(item => bootstrapSchema(item.env)));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(results.flatMap(result => result.applied).length, 1);
  assert.deepEqual(await names(race), plan.map(file => file.name));

  const retry = await mf.getD1Database('RETRY');
  await seed(retry, plan.slice(0, -1));
  let fail = true;
  const retrying = track(retry, { beforeBatch() { if (fail) throw new Error('fixture database unavailable'); } });
  await assert.rejects(bootstrapSchema(retrying.env), /fixture database unavailable/);
  assert.deepEqual(await names(retry), plan.slice(0, -1).map(file => file.name));
  fail = false;
  assert.deepEqual(await bootstrapSchema(retrying.env), { created: true, applied: [plan.at(-1).name] });

  const untracked = await mf.getD1Database('UNTRACKED');
  await untracked.prepare('CREATE TABLE existing_data (value TEXT)').run();
  const unowned = track(untracked);
  await assert.rejects(bootstrapSchema(unowned.env), /without a migration ledger/);
  assert.equal(unowned.calls.batches, 0);
  assert.deepEqual(await names(untracked), []);
  assert.deepEqual(await bootstrapSchema({ DATABASE_TYPE: 'postgres' }), { created: false, applied: [] });
  console.log('PASS D1 bootstrap: empty, warm, cold, pending migration, concurrent claims, failure retry and untracked data');
} finally {
  await mf.dispose();
}
