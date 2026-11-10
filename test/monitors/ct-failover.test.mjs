// 验证证书查询提供商的失败切换。
// Check certificate lookup provider failover.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: { contents: "export * from './backends/worker/src/lib/check/ssl'; export { ExternalRequestBudget } from './backends/worker/src/lib/http/request-budget';", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'error',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`;
let sequence = 0;
// Re-import per scenario to isolate certificate caches and request serialization state.
// 每个场景重新实例化模块，隔离证书缓存和串行请求状态。
const fresh = () => import(moduleUrl + '#' + ++sequence);
const previousFetch = globalThis.fetch;
const previousNow = Date.now;
const now = Date.parse('2026-11-03T12:00:00Z');
Date.now = () => now;
const options = { host: 'www.example.com', timeoutMs: 1000, warnDays: 14 };
const day = 86400000;
const origins = ['api.ctlogs.dev', 'ct.certkit.io', 'api.certspotter.com', 'crt.sh'];
const labels = ['ctlogs.dev', 'CertKit', 'CertSpotter', 'crt.sh'];
const baseRecord = (changes = {}) => ({ id: '1', name: options.host, notBefore: now - day, notAfter: now + 30 * day, revoked: false, ...changes });
let calls;

// Render the same certificate fixture in each provider's response format.
// 将同一证书夹具映射成四家提供商各自的响应格式。
function responseFor(url, init, records = [baseRecord()]) {
  const source = origins.indexOf(url.hostname);
  assert.ok(source >= 0, 'unexpected CT origin');
  if (source === 0) return Response.json({ rows: records.map(record => ({ id: record.id, match: record.name, issuer: 'Fixture CA',
    not_before: new Date(record.notBefore).toISOString(), not_after: new Date(record.notAfter).toISOString() })), has_next: false, next_cursor: '' });
  if (source === 1) {
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { domain: JSON.parse(init.body).domain, limit: 100, sort: 'NotBeforeDesc' });
    return Response.json({ results: records.map(record => ({ serialNumber: record.id, dnsNames: [record.name], issuerOrganization: 'Fixture CA',
      notBefore: new Date(record.notBefore).toISOString(), notAfter: new Date(record.notAfter).toISOString() })), totalCount: records.length });
  }
  if (source === 2) {
    assert.equal(url.pathname, '/v1/issuances');
    assert.equal(url.searchParams.get('include_subdomains'), 'false');
    assert.equal(url.searchParams.get('match_wildcards'), 'true');
    assert.deepEqual(url.searchParams.getAll('expand'), ['dns_names', 'issuer']);
    return Response.json(url.searchParams.has('after') ? [] : records.map(record => ({ id: record.id, dns_names: [record.name], issuer: { name: 'Fixture CA' },
      not_before: new Date(record.notBefore).toISOString(), not_after: new Date(record.notAfter).toISOString(), revoked: record.revoked })));
  }
  assert.equal(url.searchParams.get('sort'), '2');
  assert.equal(url.searchParams.get('dir'), '^');
  return Response.json(records.map(record => ({ id: Number(record.id), name_value: record.name, issuer_name: 'Fixture CA',
    not_before: new Date(record.notBefore).toISOString(), not_after: new Date(record.notAfter).toISOString() })));
}

// Deliver the body later and update the active counter before closing the stream.
// 响应体稍后到达；完成回调在流关闭前释放测试中的活动计数。
function streamAfterDelay(body, complete) {
  return new Response(new ReadableStream({ start(controller) {
    setTimeout(() => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      complete();
      controller.close();
    }, 5);
  } }));
}

// 拦截并记录 fetch，由场景处理器注入失败；非预期来源直接报错。
// Intercept and record fetch calls, inject failures per scenario, and reject unexpected origins.
function mock(handler) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    assert.ok(origins.includes(url.hostname));
    assert.equal(url.protocol, 'https:');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(url.searchParams.has('key'), false);
    calls.push({ url, init });
    return handler(url, init);
  };
}

try {
  for (let selected = 0; selected < origins.length; selected++) {
    const module = await fresh();
    mock((url, init) => url.hostname === origins[selected] ? responseFor(url, init) : new Response('private error content', { status: 503 }));
    const result = await module.checkSsl(options);
    assert.equal(result.status, 1);
    assert.equal(result.daysLeft, 30);
    assert.ok(result.message.startsWith('SSL: '));
    assert.deepEqual([...new Set(calls.map(call => call.url.hostname))], origins.slice(0, selected + 1));
    const count = calls.length;
    const cached = await module.checkSsl({ ...options, warnDays: 40 });
    assert.equal(cached.status, 2);
    assert.equal(cached.observedAt, result.observedAt);
    assert.equal(calls.length, count, 'the selected source reading is cached with its original observation time');
  }

  for (const failure of ['empty', 'invalid', 'limited', 'partial', 'redirect']) {
    const module = await fresh();
    mock((url, init) => {
      if (url.hostname === origins[0]) {
        if (failure === 'empty') return responseFor(url, init, []);
        if (failure === 'invalid') return new Response('<html>private response</html>');
        if (failure === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/ct' } });
        if (failure === 'limited' || decodeURIComponent(url.pathname).includes('*')) return new Response('limited', { status: 429 });
        return responseFor(url, init);
      }
      return responseFor(url, init);
    });
    const result = await module.checkSsl(options);
    assert.equal(result.status, 1);
    assert.ok(calls.some(call => call.url.hostname === origins[1]), 'an incomplete primary lookup must switch sources');
    assert.doesNotMatch(result.message, /private response/);
  }

  // Exercise timeouts before a response and during body streaming; both must abort the source and allow failover.
  // 分别模拟响应前超时和响应体停滞，两者都须取消慢来源并继续切换。
  for (const bodyTimeout of [false, true]) {
    const module = await fresh();
    let timedOut;
    mock((url, init) => {
      if (url.hostname !== origins[0]) return responseFor(url, init);
      timedOut = init.signal;
      if (!bodyTimeout) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      } }));
    });
    const result = await module.checkSsl({ ...options, timeoutMs: 160 });
    assert.equal(result.status, 1);
    assert.ok(calls.some(call => call.url.hostname === origins[1]));
    assert.equal(timedOut.aborted, true, 'a slow source leaves time for later sources and closes its request');
  }

  {
    const module = await fresh();
    mock((url, init) => responseFor(url, init, [baseRecord({ notBefore: now - 45 * day, notAfter: now - day })]));
    const result = await module.checkSsl(options);
    assert.equal(result.status, 2);
    assert.equal(result.daysLeft, -1);
    assert.ok(calls.every(call => call.url.hostname === origins[0]), 'an expired record is not an excuse to find a healthier-looking source');
  }

  {
    const module = await fresh();
    mock((url, init) => url.hostname === origins[2] ? responseFor(url, init, [baseRecord({ revoked: true })]) : new Response('unavailable', { status: 503 }));
    const result = await module.checkSsl(options);
    assert.equal(result.status, 2);
    assert.equal(result.revoked, true);
    assert.match(result.message, /certificate revoked/);
    assert.equal((await module.checkSsl({ ...options, warnDays: 1 })).status, 2);
  }

  {
    const module = await fresh();
    mock((url, init) => {
      if (url.hostname !== origins[0]) return responseFor(url, init);
      if (decodeURIComponent(url.pathname).includes('*')) return responseFor(url, init, []);
      const newer = url.searchParams.get('after') === 'page2';
      const row = baseRecord(newer ? { id: 'new', notAfter: now + 8 * day } : { id: 'old', notBefore: now - 20 * day, notAfter: now + 800 * day });
      return Response.json({ rows: [{ id: row.id, match: row.name, issuer: 'Fixture CA', not_before: new Date(row.notBefore).toISOString(), not_after: new Date(row.notAfter).toISOString() }],
        has_next: !newer, next_cursor: newer ? '' : 'page2', history_truncated: true });
    });
    const result = await module.checkSsl(options);
    assert.equal(result.status, 2);
    assert.equal(result.daysLeft, 8);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.url.hostname === origins[0]));
  }

  {
    const module = await fresh();
    mock((url, init) => {
      if (url.hostname !== origins[2]) return new Response('unavailable', { status: 503 });
      const after = url.searchParams.get('after');
      if (after === '2') return Response.json([]);
      const row = baseRecord(after ? { id: '2', notAfter: now + 8 * day } : { id: '1', notBefore: now - 20 * day, notAfter: now + 800 * day });
      return Response.json([{ id: row.id, dns_names: [row.name], issuer: { name: 'Fixture CA' }, not_before: new Date(row.notBefore).toISOString(), not_after: new Date(row.notAfter).toISOString() }],
        { headers: { link: '<https://untrusted.invalid/cursor>; rel="next"' } });
    });
    const result = await module.checkSsl(options);
    assert.equal(result.daysLeft, 8);
    assert.ok(calls.some(call => call.url.hostname === origins[2]));
    assert.equal(calls.filter(call => call.url.hostname === origins[2]).length, 3);
  }

  {
    const module = await fresh();
    // Delay body completion to check that serialization lasts through body consumption.
    // 延迟响应体结束，检查串行锁覆盖整个读取过程。
    let active = 0, maximum = 0;
    mock((url, init) => {
      assert.equal(url.hostname, origins[0]);
      active++;
      maximum = Math.max(maximum, active);
      const identity = decodeURIComponent(url.pathname.split('/').at(-1));
      return streamAfterDelay({ rows: [{ id: '1', match: identity, issuer: 'Fixture CA',
        not_before: new Date(now - day).toISOString(), not_after: new Date(now + 30 * day).toISOString() }], has_next: false, next_cursor: '' }, () => { active--; });
    });
    const results = await Promise.all(['a.example.com', 'b.example.com'].map(host => module.checkSsl({ ...options, host })));
    assert.ok(results.every(result => result.status === 1));
    assert.equal(maximum, 1, 'anonymous ctlogs.dev requests are serialized through body consumption');
  }

  {
    const module = await fresh();
    mock(() => new Response('private credential-shaped diagnostics', { status: 503 }));
    const result = await module.checkSsl(options);
    assert.equal(result.status, 2);
    assert.equal(result.daysLeft, undefined);
    for (const label of labels) assert.ok(result.message.includes(label));
    assert.doesNotMatch(result.message, /private credential/);
    const budget = new module.ExternalRequestBudget();
    for (let index = 0; index < 49; index++) budget.reserve();
    calls = [];
    const deferred = await module.checkSsl({ ...options, budget });
    assert.equal(deferred.observedAt, 0);
    assert.equal(calls.length, 1, 'budget exhaustion during failover stops additional requests');
  }
  console.log('PASS anonymous CT failover: all four sources, timeout/body timeout/429/empty/invalid responses, pagination, revoked/expired records, serial access and total request budget');
} finally { Date.now = previousNow; globalThis.fetch = previousFetch; }
