// 在 Worker 夹具中验证证书查询请求。
// Check certificate lookup requests in a Worker fixture.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundle = await build({
  stdin: { contents: `
    import { checkSsl } from './backends/worker/src/lib/check/ssl';
    let outbound;
    const ioErrors = [];
    globalThis.fetch = async (url, init) => {
      try { return await outbound.fetch(new Request(url, init)); }
      catch (error) { ioErrors.push(String(error)); throw error; }
    };
    export default { async fetch(request, env) {
      outbound ??= env.OUTBOUND;
      const host = new URL(request.url).searchParams.get('host');
      return Response.json({ ...await checkSsl({ host, timeoutMs: 2000, warnDays: 14 }), ioErrors });
    } };
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'error',
});
let active = 0;
let peak = 0;
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01',
  serviceBindings: { OUTBOUND: async request => {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'api.ctlogs.dev');
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.has('cookie'), false);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    const data = { rows: [{ id: 'worker-fixture', match: decodeURIComponent(url.pathname.split('/').at(-1)), issuer: 'Fixture CA',
      not_before: new Date(Date.now() - 86400000).toISOString(), not_after: new Date(Date.now() + 30 * 86400000).toISOString() }],
      has_next: false, next_cursor: '' };
    active--;
    return Response.json(data);
  } },
});
try {
  const results = await Promise.all(['one.example.com', 'two.example.com', 'three.example.com'].map(async host => {
    const response = await mf.dispatchFetch('http://localhost/?host=' + host);
    assert.equal(response.status, 200);
    return response.json();
  }));
  const healthy = results.every(result => {
    return result.status === 1 && result.daysLeft > 29 && result.message.startsWith('SSL: ');
  });
  assert.ok(healthy, JSON.stringify(results));
  assert.ok(results.every(result => result.ioErrors.length === 0));
  assert.equal(peak, 1);
  console.log('PASS Workers CT client: concurrent request contexts, serial anonymous source access and plain certificate cache values');
} finally { await mf.dispose(); }
