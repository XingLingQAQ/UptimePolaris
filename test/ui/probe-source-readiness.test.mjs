// 区分离线、未上报、禁用探测与缺少能力。
// Distinguish offline sources, missing reports, disabled probes, and missing capabilities.

import assert from 'node:assert/strict';
import { build } from 'esbuild';

const output = await build({ entryPoints: ['frontend/src/admin/monitors/presentation.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { probeSourceReadiness, canUseProbeType } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
const online = { active: true, probe_enabled: true, installed: true, online: true, capabilities: ['probe_http', 'probe_tcp'] };
assert.equal(probeSourceReadiness(online, ['probe_http']), 'ready');
assert.equal(probeSourceReadiness(online, ['probe_http', 'probe_ssl']), 'upgrade');
assert.equal(probeSourceReadiness({ ...online, capabilities: [...online.capabilities, 'probe_ssl'] }, ['probe_http', 'probe_ssl']), 'ready');
assert.equal(probeSourceReadiness({ ...online, online: false }, ['probe_http']), 'offline');
assert.equal(probeSourceReadiness({ ...online, installed: false, online: false }, ['probe_http']), 'waiting');
assert.equal(probeSourceReadiness({ ...online, probe_enabled: false }, ['probe_http']), 'disabled');
assert.equal(probeSourceReadiness({ ...online, active: false }, ['probe_http']), 'disabled');
assert.equal(canUseProbeType('udp', []), false);
assert.equal(canUseProbeType('icmp', [online]), false);
assert.equal(canUseProbeType('udp', [{...online,capabilities:[...online.capabilities,'probe_udp']}]), true);
assert.equal(canUseProbeType('udp', [{...online,online:false,capabilities:['probe_udp']}]), false);
assert.equal(canUseProbeType('icmp', [{...online,probe_enabled:false,capabilities:['probe_icmp']}]), false);
console.log('PASS probe readiness separates offline, first report, disabled probes and missing addon capabilities');
