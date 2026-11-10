// 验证草稿保留原版本并检测远程修改。
// Check that drafts retain their revision and detect remote changes.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['frontend/src/admin/agents/config-edit.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { syncConfigEdit, configEditConflicts } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const config = (interval) => ({ sample_interval_secs: interval, report_interval_secs: 60, include_nics: [], exclude_nics: [], include_mounts: [], exclude_mounts: [], auto_update: false });
const remote = (revision, interval) => ({ desired_revision: revision, desired: config(interval), current: null });
const first = syncConfigEdit(null, remote('one', 5));
const clean = syncConfigEdit(first, remote('two', 10));
assert.equal(clean.revision, 'two');
assert.equal(clean.draft.sample_interval_secs, 10);
const dirty = { ...first, draft: config(15) };
const refreshed = syncConfigEdit(dirty, remote('two', 10));
assert.equal(refreshed, dirty);
assert.equal(refreshed.revision, 'one');
assert.equal(refreshed.draft.sample_interval_secs, 15);
assert.equal(configEditConflicts(refreshed, remote('two', 10)), true);
assert.equal(configEditConflicts(refreshed, remote('one', 5)), false);
assert.equal(configEditConflicts(syncConfigEdit(null, remote('two', 10)), remote('two', 10)), false);
const invalid = { ...first, draft: { ...config(5), sample_interval_secs: 0 } };
assert.equal(syncConfigEdit(invalid, remote('two', 10)), invalid);
assert.equal(configEditConflicts(invalid, remote('two', 10)), true);
console.log('PASS agent configuration drafts retain their revision and detect remote changes');
