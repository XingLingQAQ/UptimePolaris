// 验证不安全迁移入口拒绝执行且不泄露凭据。
// Check that the unsafe migration entry rejects execution without exposing credentials.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const args of [[], ['--d1-local'], ['--d1-remote']]) {
  const password = 'do-not-log-password';
  const result = spawnSync(process.execPath, ['scripts/db/db-migrate-data.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: `postgresql://user:${password}@localhost/example` },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Command unavailable/);
  assert.match(result.stderr, /No databases were changed/);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(password));
}
console.log('PASS unsafe CLI migration refuses to run without exposing credentials');
