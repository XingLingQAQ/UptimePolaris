// 验证证书记录查询与到期读数。
// Check certificate-record queries and expiry readings.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: "export * from './backends/worker/src/lib/check/ssl'; export { ExternalBudgetExceeded } from './backends/worker/src/lib/http/request-budget';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`;
let moduleId = 0;
const fresh = async () => (await import(moduleUrl + '#' + ++moduleId)).checkSsl;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = Date.parse('2026-11-03T12:00:00Z');
Date.now = () => now;
const day = 86_400_000;
const options = { host: 'www.example.com', timeoutMs: 1000, warnDays: 14 };
const record = (changes = {}) => ({ id: 1, issuer_name: 'CN=Fixture CA', name_value: options.host,
  not_before: new Date(now - day).toISOString(), not_after: new Date(now + 30 * day).toISOString(), ...changes });
let calls;
function respond(body, status = 200) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(new Headers(init.headers).has('cookie'), false);
    const identity = url.hostname === 'api.ctlogs.dev' ? decodeURIComponent(url.pathname.split('/').at(-1))
      : url.hostname === 'ct.certkit.io' ? JSON.parse(init.body).domain
      : url.hostname === 'api.certspotter.com' ? url.searchParams.get('domain') : url.searchParams.get('q');
    calls.push(identity);
    const data = typeof body === 'function' ? body(identity) : body;
    if (status !== 200 || !Array.isArray(data)) return Response.json(data, { status });
    if (url.hostname === 'api.ctlogs.dev') return Response.json({ rows: data.flatMap(row => String(row.name_value ?? '').split('\n').map(match => ({
      id: String(row.id), match, issuer: row.issuer_name, not_before: row.not_before, not_after: row.not_after,
    }))), has_next: false, next_cursor: '' });
    if (url.hostname === 'ct.certkit.io') {
      assert.equal(JSON.parse(init.body).sort, 'NotBeforeDesc');
      return Response.json({ results: data.map(row => ({ serialNumber: String(row.id), dnsNames: String(row.name_value ?? '').split('\n'),
        issuerOrganization: row.issuer_name, notBefore: row.not_before, notAfter: row.not_after })), totalCount: data.length });
    }
    if (url.hostname === 'api.certspotter.com') return Response.json(url.searchParams.has('after') ? [] : data.map(row => ({
      id: String(row.id), dns_names: String(row.name_value ?? '').split('\n'), issuer: { name: row.issuer_name }, not_before: row.not_before, not_after: row.not_after,
    })));
    assert.equal(url.origin, 'https://crt.sh');
    assert.equal(url.searchParams.get('output'), 'json');
    assert.equal(url.searchParams.get('sort'), '2');
    assert.equal(url.searchParams.get('dir'), '^');
    assert.equal(init.body, undefined);
    return Response.json(data);
  };
}

try {
  let checkSsl = await fresh();
  respond([record()]);
  let reserved = 0;
  const budget = { reserve() { reserved++; } };
  const first = await checkSsl({ ...options, host: 'WWW.EXAMPLE.COM.', budget });
  assert.equal(first.status, 1);
  assert.equal(first.daysLeft, 30);
  assert.deepEqual(calls.sort(), ['*.example.com', 'www.example.com']);
  assert.equal(reserved, 2);
  assert.match(first.message, /^SSL: www\.example\.com · expires /);
  assert.equal(first.observedAt, Math.floor(now / 1000));
  now += day / 1440;
  const cached = await checkSsl({ ...options, warnDays: 40, budget });
  assert.equal(cached.status, 2, 'cache hits apply the current warning threshold');
  assert.equal(cached.observedAt, first.observedAt, 'cache hits do not pretend to be new observations');
  assert.ok(cached.daysLeft < first.daysLeft);
  assert.equal(reserved, 2);
  assert.equal(calls.length, 2);
  now += 10 * 60 * 1000;
  const refreshed = await checkSsl({ ...options, budget });
  assert.ok(refreshed.observedAt > first.observedAt);
  assert.equal(reserved, 4);

  checkSsl = await fresh();
  respond([
    record({ id: 2, not_before: new Date(now - 20 * day).toISOString(), not_after: new Date(now + 800 * day).toISOString() }),
    record({ id: 3, not_after: new Date(now + 8 * day).toISOString() }),
    record({ id: 4, not_before: new Date(now + day).toISOString(), not_after: new Date(now + 90 * day).toISOString() }),
    record({ id: 5, name_value: 'other.example.com', common_name: options.host }),
    record({ id: 6, not_before: '2026-02-30T12:00:00Z' }),
    record({ id: 7, not_before: '2026-11-01T24:00:00Z' }),
  ]);
  const latest = await checkSsl(options);
  assert.equal(latest.status, 2);
  assert.equal(latest.daysLeft, 8, 'latest start wins over an older long-lived certificate');

  checkSsl = await fresh();
  respond([record({ id: 8, name_value: 'other.example.com\n*.example.com', not_before: '2026-11-01T00:00:00' })]);
  assert.equal((await checkSsl(options)).status, 1);
  assert.equal((await checkSsl({ ...options, host: 'example.com' })).daysLeft, undefined, 'wildcards do not cover the apex');
  assert.equal((await checkSsl({ ...options, host: 'a.b.example.com' })).daysLeft, undefined, 'wildcards cover only one label');

  checkSsl = await fresh();
  respond([record({ name_value: 'münich.example.com' })]);
  assert.equal((await checkSsl({ ...options, host: 'münich.example.com' })).status, 1);
  assert.ok(calls.includes('xn--mnich-kva.example.com'));

  checkSsl = await fresh();
  respond([record({ not_before: new Date(now - 60 * day).toISOString(), not_after: new Date(now - day).toISOString() })]);
  const expired = await checkSsl(options);
  assert.equal(expired.status, 2);
  assert.equal(expired.daysLeft, -1);

  for (const records of [[], [record({ name_value: 'unrelated.example.com' })], [record({ not_before: new Date(now + day).toISOString() })], [record({ not_after: 'invalid' })]]) {
    checkSsl = await fresh();
    respond(records);
    const unknown = await checkSsl(options);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.daysLeft, undefined);
    assert.match(unknown.message, /no matching started certificate/);
  }

  for (const status of [429, 502, 503]) {
    checkSsl = await fresh();
    respond({ error: 'private upstream response' }, status);
    const result = await checkSsl(options);
    assert.equal(result.status, 2);
    assert.equal(result.daysLeft, undefined);
    assert.match(result.message, new RegExp('HTTP ' + status));
    assert.doesNotMatch(result.message, /private upstream/);
  }
  checkSsl = await fresh();
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname !== 'api.ctlogs.dev' || decodeURIComponent(url.pathname).includes('*')) return new Response('private', { status: 503 });
    const row = record();
    return Response.json({ rows: [{ id: '1', match: row.name_value, issuer: row.issuer_name, not_before: row.not_before, not_after: row.not_after }], has_next: false, next_cursor: '' });
  };
  assert.equal((await checkSsl(options)).daysLeft, undefined, 'an incomplete lookup is not reported as healthy');

  for (const body of ['<html>private</html>', '{}', JSON.stringify(Array(10001).fill(null)), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    checkSsl = await fresh();
    globalThis.fetch = async () => new Response(body);
    const result = await checkSsl(options);
    assert.equal(result.status, 2);
    assert.equal(result.daysLeft, undefined);
    assert.match(result.message, /unreadable or oversized|invalid response|incomplete response/);
    assert.doesNotMatch(result.message, /<html>|private/);
  }

  checkSsl = await fresh();
  respond([]);
  for (const host of ['localhost', 'a.localhost', 'db.internal', 'host.local', '127.0.0.1', '1.1.1.1', '::1', '[::1]', 'example.com:443', 'example.com/path', 'https://example.com', 'a.example.com@evil.com']) {
    const result = await checkSsl({ ...options, host });
    assert.equal(result.daysLeft, undefined);
    assert.equal(result.status, 2);
  }
  assert.equal(calls.length, 0, 'private or malformed targets are not sent to the public index');
  await checkSsl({ ...options, budget: { reserve() { throw new Error('budget exhausted'); } } });
  assert.equal(calls.length, 0, 'request budget is reserved before contacting the index');
  const budgetModule = await import(moduleUrl + '#actual-budget');
  const deferred = await budgetModule.checkSsl({ ...options, budget: { reserve() { throw new budgetModule.ExternalBudgetExceeded(); } } });
  assert.equal(deferred.observedAt, 0, 'an unstarted lookup does not get a fresh observation timestamp');
  assert.equal(deferred.daysLeft, undefined);
  assert.equal(calls.length, 0);

  for (const duringBody of [false, true]) {
    checkSsl = await fresh();
    globalThis.fetch = async (_url, init) => {
      if (!duringBody) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('['));
        init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }));
    };
    const timedOut = await checkSsl({ ...options, timeoutMs: 20 });
    assert.equal(timedOut.status, 2);
    assert.equal(timedOut.daysLeft, undefined);
    assert.match(timedOut.message, /timed out/);
  }
  console.log('PASS CT lookup: exact/one-label wildcard/IDN identities, latest started record, expiry/unknown states, bounded responses, request budget, cache observation times and header/body timeouts');
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}
