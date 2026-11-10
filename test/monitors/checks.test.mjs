// 通过可控传输验证 TCP 和证书查询结果。
// Check TCP and certificate lookup results using controlled transports.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const harness = `
import { checkTcp } from './backends/worker/src/lib/check/tcp';
import { checkSsl } from './backends/worker/src/lib/check/ssl';
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  const host = url.hostname === 'api.ctlogs.dev' ? decodeURIComponent(url.pathname.split('/').at(-1))
    : url.hostname === 'ct.certkit.io' ? JSON.parse(init.body).domain
    : url.hostname === 'api.certspotter.com' ? url.searchParams.get('domain') : url.searchParams.get('q');
  if (host === 'unavailable.example') return new Response('private upstream details', { status: 503 });
  if (url.hostname === 'api.ctlogs.dev') return Response.json({ rows: host === 'record.example' ? [{
    id: '123', match: 'record.example', issuer: 'Fixture CA', not_before: new Date(Date.now() - 86400000).toISOString(),
    not_after: new Date(Date.now() + 30 * 86400000).toISOString(),
  }] : [], has_next: false, next_cursor: '' });
  if (url.hostname === 'ct.certkit.io') return Response.json({ results: [], totalCount: 0 });
  if (url.hostname === 'api.certspotter.com') return Response.json([]);
  return Response.json(host === 'record.example' ? [{
    id: 123, name_value: 'record.example', issuer_name: 'CN=Fixture CA',
    not_before: new Date(Date.now() - 86400000).toISOString(),
    not_after: new Date(Date.now() + 30 * 86400000).toISOString(),
  }] : []);
};
export default {
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith('/tcp/')) return Response.json(await checkTcp({
      type: 'tcp', target: pathname === '/tcp/open' ? 'fixture-open:22' : 'fixture-closed:22',
      options_json: JSON.stringify({ expect: 'SSH-2.0-fixture' }),
    }));
    const host = pathname === '/ssl/record' ? 'record.example' : pathname === '/ssl/empty' ? 'empty.example' : 'unavailable.example';
    return Response.json(await checkSsl({ host, timeoutMs: 1000, warnDays: 14 }));
  },
};
`;
const bundled = await build({
  stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent',
  plugins: [{ name: 'controlled-sockets', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export function connect({ hostname }) {
        if (hostname === 'fixture-closed') throw new Error('fixture connection refused');
        return {
          opened: Promise.resolve(),
          readable: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('SSH-2.0-fixture\\r\\n')); controller.close(); } }),
          writable: new WritableStream({ write() {} }), close: async () => {},
        };
      }
    `, loader: 'js' }));
  } }],
});
const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2025-01-01' });
try {
  const request = path => mf.dispatchFetch('http://fixture' + path).then(response => response.json());
  const open = await request('/tcp/open');
  assert.equal(open.status, 1);
  assert.equal(open.message, '');
  const closed = await request('/tcp/closed');
  assert.equal(closed.status, 0);
  assert.equal(closed.message, 'fixture connection refused');
  const available = await request('/ssl/record');
  assert.equal(available.status, 1);
  assert.ok(available.daysLeft > 29 && available.daysLeft <= 30);
  assert.match(available.message, /^SSL: /);
  assert.ok(available.observedAt > 0);
  const empty = await request('/ssl/empty');
  assert.equal(empty.status, 2);
  assert.equal(empty.daysLeft, undefined);
  assert.match(empty.message, /no matching started certificate/);
  const unavailable = await request('/ssl/unavailable');
  assert.equal(unavailable.status, 2);
  assert.equal(unavailable.daysLeft, undefined);
  assert.match(unavailable.message, /HTTP 503/);
  assert.doesNotMatch(unavailable.message, /private upstream/);
  console.log('PASS Workers TCP checks and HTTPS-only CT certificate lookup, unknown records and upstream failures');
} finally { await mf.dispose(); }
