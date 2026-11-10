// 验证命令租约、过期拒绝与原子完成。
// Check command leases, expiration rejection, and atomic completion.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), contents: `
    import { submitCommandResult } from './backends/worker/src/lib/agent/commands';
    import { commandsSQL } from './backends/worker/src/lib/db/sql/commands';
    import { getDB } from './backends/worker/src/lib/db/factory';
    export default { async fetch(request, env) {
      const input = await request.json();
      if (input.direct) return Response.json(await getDB(env).execute(commandsSQL.d1.complete, [1, 'late', input.now, input.id, input.lease_token, input.now]));
      return Response.json(await submitCommandResult(env, { id: 'agent' }, input, input.now));
    }};
  ` },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'error',
  plugins: [{ name: 'unused-postgres', setup(b) {
    b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default function(){throw Error("unexpected postgres")}' }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'command-lease' } });
try {
  const db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE agent_commands(id TEXT PRIMARY KEY,agent_id TEXT,state TEXT,lease_token TEXT,lease_until INTEGER,ok INTEGER,message TEXT,completed_at INTEGER);');
  const now = 1800000000;
  const submit = async input => {
    const response = await mf.dispatchFetch('http://localhost/result', { method: 'POST', body: JSON.stringify({ id: 'command', lease_token: 'lease', ok: true, message: 'done', now, ...input }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const seed = (state, until) => db.prepare('INSERT OR REPLACE INTO agent_commands VALUES(?,?,?,?,?,NULL,NULL,NULL)').bind('command', 'agent', state, 'lease', until).run();
  await seed('leased', now + 120);
  assert.equal(await submit({ lease_token: 'wrong' }), 'stale');
  assert.equal(await submit({}), 'recorded');
  assert.equal(await submit({}), 'duplicate');
  await seed('leased', now - 5);
  assert.equal(await submit({}), 'stale');
  assert.equal((await submit({ direct: true })).rowsAffected, 0, 'atomic update rejects an expired lease');
  assert.equal((await db.prepare('SELECT state FROM agent_commands').first()).state, 'leased');
  await seed('expired', now + 120);
  assert.equal((await submit({ direct: true })).rowsAffected, 0, 'atomic update rechecks terminal state');
  await seed('leased', now + 120);
  assert.equal((await submit({ direct: true, lease_token: 'previous' })).rowsAffected, 0, 'atomic update rechecks replacement token');
  assert.equal(await submit({}), 'recorded');
  console.log('PASS Worker command lease: normal/retry, wrong/expired token and atomic completion guards');
} finally {
  await mf.dispose();
}
