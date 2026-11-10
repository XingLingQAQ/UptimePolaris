// 验证安装命令的地址、凭据、平台和参数引用。
// Check installation command origins, credentials, platforms, and argument quoting.

import assert from 'node:assert/strict';
import { agentBinaryUrl, agentInstallScriptUrl, buildInstallCommand, groupAgentBuilds, installModesForPlatform, safeInstallCommand } from '../../shared/agent-install';

const input = {
  platformKey: 'linux-x86_64', endpoint: 'https://host.test', token: "tok'en;$(whoami)",
  mode: 'user' as const, sampleInterval: 5, reportInterval: 60,
};
const posix = buildInstallCommand(input, 'posix');
assert.match(posix, /installer=\$\(curl -fsSL 'https:\/\/host.test\/install.sh'\) && POLARIS_AGENT_TOKEN='tok'\\''en;\$\(whoami\)'/);
assert.match(posix, /sh -c "\$installer" -- --platform 'linux-x86_64' --mode 'user'/);
assert.doesNotMatch(posix, /\|\s*sh|--token\b|--endpoint|--sample-interval|--report-interval|mktemp/);
const auto = buildInstallCommand({ ...input, detectPlatform: true, registerCommand: false }, 'posix');
assert.doesNotMatch(auto, /--platform/);
assert.match(auto, /--no-register-command/);
const reinstall = buildInstallCommand({ ...input, operation: 'reinstall', autoUpdate: false }, 'posix');
assert.match(reinstall, /--endpoint 'https:\/\/host.test'/);
assert.match(reinstall, /--sample-interval '5' --report-interval '60'/);
assert.match(reinstall, /--disable-auto-update/);
assert.match(buildInstallCommand({ ...input, autoUpdate: true }, 'posix'), /--auto-update/);
const custom = buildInstallCommand({ ...input, installDir: "/opt/O'Brien agent", serviceName: 'polaris.user' }, 'posix');
assert.match(custom, /'\/opt\/O'\\''Brien agent'/);
assert.match(custom, /--service-name 'polaris.user'/);
const windows = buildInstallCommand({ ...input, platformKey: 'windows-x86_64', registerCommand: false }, 'windows');
assert.match(windows, /scriptblock.*irm 'https:\/\/host.test\/install.ps1' -ErrorAction Stop/);
assert.match(windows, /'tok''en;\$\(whoami\)'/);
assert.match(windows, /-NoRegisterCommand/);
const windowsUpdate = safeInstallCommand({ ...input, platformKey: 'windows-x86_64', autoUpdate: true }, 'windows');
assert.equal(windowsUpdate.error, null);
assert.match(windowsUpdate.command!, /-AutoUpdate/);
assert.match(buildInstallCommand({ ...input, platformKey: 'windows-x86_64', operation: 'reinstall', autoUpdate: false }, 'windows'), /-DisableAutoUpdate/);
assert.doesNotMatch(windows, /-Token\s|\?token|Join-Path/);

for (const origin of ['https://status.customer.example', 'https://monitor.example:9443', 'http://127.0.0.1:3884']) {
  for (const platform of ['linux', 'darwin', 'windows'] as const) {
    const url = agentInstallScriptUrl(origin + '/admin/agents?view=all', platform);
    assert.equal(url, `${origin}/install.${platform === 'windows' ? 'ps1' : 'sh'}`);
    const command = buildInstallCommand({ ...input, endpoint: origin, platformKey: `${platform}-x86_64` }, platform === 'windows' ? 'windows' : 'posix');
    assert.ok(command.includes(url));
    assert.doesNotMatch(command, /workers\.dev|host\.test/);
    const retry = buildInstallCommand({ ...input, endpoint: origin, platformKey: `${platform}-x86_64`, operation: 'reinstall' }, platform === 'windows' ? 'windows' : 'posix');
    assert.ok(retry.includes(`'${origin}'`));
  }
}
assert.throws(() => agentInstallScriptUrl('ftp://host.test', 'linux'), /HTTP\(S\)/);
assert.throws(() => agentInstallScriptUrl('https://user:password@host.test', 'windows'), /without credentials/);
assert.throws(() => buildInstallCommand({ ...input, reportInterval: 4 }, 'posix'), /invalid sample\/report interval/);
assert.throws(() => buildInstallCommand({ ...input, serviceName: 'bad/name' }, 'posix'), /invalid service name/);
assert.deepEqual(installModesForPlatform('windows'), ['system', 'user', 'manual']);
assert.deepEqual(installModesForPlatform('linux'), ['system', 'user', 'manual', 'docker']);
for (const overrides of [{ installDir: '/opt/bad%path' }, { serviceName: 'bad/name' }, { mode: 'system' as const, installDir: '/home/agent' }]) {
  assert.equal(safeInstallCommand({ ...input, ...overrides }, 'linux').command, null);
}
assert.equal(safeInstallCommand({ ...input, platformKey: 'windows-x86_64', mode: 'docker' }, 'windows').command, null);
assert.equal(safeInstallCommand({ ...input, autoUpdate: true }, 'windows').command, null);
assert.equal(safeInstallCommand({ ...input, mode: 'docker', autoUpdate: true }, 'linux').command, null);
assert.equal(agentBinaryUrl('/download', 'windows-x86_64'), '/download/polaris-agent-windows-x86_64.exe');
assert.equal(agentBinaryUrl('/download', 'linux-aarch64'), '/download/polaris-agent-linux-aarch64');
const groups = groupAgentBuilds([{ key: 'linux-x86_64', version: '0.5.1' }, { key: 'linux-aarch64', version: '0.5.1' }, { key: 'windows-x86_64', version: '0.5.1' }]);
assert.deepEqual(groups.map(group => [group.os, group.builds.length]), [['linux', 2], ['windows', 1]]);
console.log('PASS short install commands: current domain/protocol/port, credentials, defaults, reinstall and platform groups');
