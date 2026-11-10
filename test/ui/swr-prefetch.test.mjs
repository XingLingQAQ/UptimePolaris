// 验证预取去重与有效期内复用。
// Check prefetch deduplication and reuse within its lifetime.

import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { prefetchSWRKey } from '../../frontend/src/components/status-page/useStatusPageData';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
globalThis.window = { location: { search: '', origin: 'http://localhost' } };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test('prefetchSWRKey skips repeated requests within the ttl window', async () => {
  let calls = 0;
  const key = `/api/prefetch-test-${crypto.randomUUID()}`;

  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ success: true });
  };

  assert.equal(await prefetchSWRKey(key, { ttlMs: 30_000 }), true);
  assert.equal(await prefetchSWRKey(key, { ttlMs: 30_000 }), false);
  assert.equal(calls, 1);
});

test('prefetchSWRKey skips duplicate in-flight requests', async () => {
  let releaseFetch;
  const key = `/api/prefetch-slow-${crypto.randomUUID()}`;

  globalThis.fetch = async () => {
    await new Promise(resolve => {
      releaseFetch = resolve;
    });

    return Response.json({ success: true });
  };

  const firstPrefetch = prefetchSWRKey(key, { ttlMs: 30_000 });

  assert.equal(await prefetchSWRKey(key, { ttlMs: 30_000 }), false);

  releaseFetch?.();
  assert.equal(await firstPrefetch, true);
});
