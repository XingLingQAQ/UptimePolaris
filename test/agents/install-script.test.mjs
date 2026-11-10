// 验证引导脚本的引用、凭据恢复与失败处理。
// Check bootstrap script quoting, credential restoration, and failure handling.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bundled = await build({ stdin: { contents: "export {installSh,installPs1} from './backends/worker/src/lib/agent/install-script.ts'; export {serveAgentInstaller} from './backends/worker/src/lib/agent/download.ts'; export {buildInstallCommand,powershellInstallBootstrap,shellQuote,powershellQuote} from './shared/agent-install.ts';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { installSh, installPs1, serveAgentInstaller, buildInstallCommand, powershellInstallBootstrap, shellQuote, powershellQuote } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const sh = installSh({ base: 'https://host.test' });
const ps1 = installPs1({ base: 'https://host.test' });
const headers = new Headers();
const download = serveAgentInstaller({
  req: { url: 'https://host.test/api/public/agent/download/install.ps1' },
  header: (name, value) => headers.set(name, value),
  body: (body) => new Response(body, { headers }),
}, 'install.ps1');
const downloadedPs1 = Buffer.from(await download.arrayBuffer());
assert.match(headers.get('content-type'), /charset=utf-8/i);
assert.deepEqual([...downloadedPs1.subarray(0, 6)], [0xef, 0xbb, 0xbf, 0x23, 0x20, 0x55]);
assert.equal(downloadedPs1.toString('utf8'), ps1);
for (const source of [sh, ps1]) {
  assert.match(source, /polaris-agent/);
  assert.match(source, /record-installation/);
  assert.match(source, /command register/);
  assert.match(source, /command unregister/);
  assert.match(source, /POLARIS_AGENT_TOKEN/);
  assert.doesNotMatch(source, /uptime-probe|uptime-polaris-agent|UPTIME_AGENT|UPTIME_ENROLLMENT/);
  assert.match(source, /sha256 mismatch/);
  assert.match(source, /configuration contains unsupported fields/);
}
assert.match(sh, /--no-register-command/);
assert.match(ps1, /NoRegisterCommand/);
assert.ok(ps1.includes("[string]$Endpoint = 'https://host.test'"));
assert.doesNotMatch(ps1, /Read-Host "Endpoint/);
assert.ok(/nohup "\$DEST" run --config "\$CFG" >>"\$LOG_PATH"/.test(sh));
assert.match(sh, /command_args="run --config/);
assert.match(sh, /exec \$RUN --log-file/);
assert.match(sh, /ENTRYPOINT \[.*run/);
assert.ok(/die "[^"]*(?:manifest|required|verify)/.test(sh));
assert.ok(/Die "[^"]*(?:manifest|required|verify)/.test(ps1));
assert.match(ps1, /-Argument "run --config/);
assert.ok(sh.indexOf('sha256 mismatch') < sh.indexOf('mv -f "$BIN_NEW" "$DEST"'));
assert.ok(sh.indexOf('configuration contains unsupported fields') < sh.indexOf('mv -f "$BIN_NEW" "$DEST"'));

const temp = mkdtempSync(join(tmpdir(), 'polaris-installer-'));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, ...options });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result;
};
try {
  const shPath = join(temp, 'install.sh');
  const psPath = join(temp, 'install.ps1');
  writeFileSync(shPath, sh);
  writeFileSync(psPath, downloadedPs1);
  run('sh', ['-n', shPath]);
  const parser = join(temp, 'parse.ps1');
  writeFileSync(parser, '$t=$null; $e=$null; [System.Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$t,[ref]$e) > $null; if ($e.Count) { $e | Out-String | Write-Error; exit 1 }');
  run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', parser, psPath]);
  const commandPath = join(temp, 'copy-command.ps1');

  const token = "fixture'token;$(whoami)";
  const options = { detectPlatform: true, platformKey: 'linux-x86_64', endpoint: 'https://host.test', token, mode: 'user', sampleInterval: 10, reportInterval: 90, installDir: "/opt/O'Brien agent", registerCommand: false };
  const compactSh = buildInstallCommand(options, 'posix');
  const payload = 'printf "token:%s\\n" "$POLARIS_AGENT_TOKEN"\nprintf "arg:%s\\n" "$@"\n';
  const shellFixture = join(temp, 'compact-command.sh');
  writeFileSync(shellFixture, `curl() { printf '%s' ${shellQuote(payload)}; return 0; }\n${compactSh}\nprintf 'parent:%s\\n' "$POLARIS_AGENT_TOKEN"\n`);
  const compactShell = run('sh', [shellFixture], { env: { ...process.env, POLARIS_AGENT_TOKEN: 'before-install' } });
  assert.ok(compactShell.stdout.includes(`token:${token}\n`));
  assert.ok(compactShell.stdout.includes("arg:/opt/O'Brien agent\n"));
  assert.ok(compactShell.stdout.includes('arg:--no-register-command\n'));
  assert.ok(compactShell.stdout.includes('parent:before-install\n'));
  writeFileSync(shellFixture, `curl() { printf '%s' ${shellQuote(payload)}; return 22; }\n${compactSh}\n`);
  const interrupted = spawnSync('sh', [shellFixture], { encoding: 'utf8', windowsHide: true });
  assert.equal(interrupted.status, 22);
  assert.equal(interrupted.stdout, '', 'an interrupted download must not execute any part of the installer');

  const capturePath = join(temp, 'compact-result.json');
  const encode = source => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString('base64')}'))`;
  const fixturePs = `param($Mode,$SampleInterval,$ReportInterval,$InstallDir,[switch]$NoRegisterCommand)\n# \uFEFF\n$bytes=[IO.File]::ReadAllBytes($PSCommandPath)\n$contents=[IO.File]::ReadAllText($PSCommandPath,[Text.Encoding]::UTF8)\n@{token=$env:POLARIS_AGENT_TOKEN; mode=$Mode; sample=$SampleInterval; report=$ReportInterval; directory=$InstallDir; noCommand=[bool]$NoRegisterCommand; script=$PSCommandPath; prefix=@($bytes[0..5]); innerBom=($contents.IndexOf([char]0xFEFF) -ge 0)} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${powershellQuote(capturePath)} -Encoding UTF8\nexit 0`;
  const bootstrap = powershellInstallBootstrap('https://host.test');
  const shortHeaders = new Headers();
  const shortDownload = serveAgentInstaller({
    req: { url: 'https://host.test/install.ps1' },
    header: (name, value) => shortHeaders.set(name, value),
    body: (body) => new Response(body, { headers: shortHeaders }),
  }, 'install.ps1', true);
  const shortBody = Buffer.from(await shortDownload.arrayBuffer());
  assert.deepEqual([...shortBody.subarray(0, 6)], [0x70, 0x61, 0x72, 0x61, 0x6d, 0x28]);
  assert.equal(shortBody.toString('utf8'), bootstrap);
  const compactPs = buildInstallCommand({ ...options, platformKey: 'windows-x86_64' }, 'windows');
  for (const prefix of ['', '\uFEFF', '\uFEFF\uFEFF']) {
    writeFileSync(commandPath, `$bootstrap=${encode(bootstrap)}\n$fixture=${encode(prefix + fixturePs)}\nfunction Invoke-RestMethod { param($Uri) if ($Uri -eq 'https://host.test/install.ps1') { $bootstrap } else { $fixture } }\n$env:POLARIS_AGENT_TOKEN='before-install'\n${compactPs}\nif ($env:POLARIS_AGENT_TOKEN -ne 'before-install') { throw 'credential environment was not restored' }\nWrite-Output 'compact-returned'\n`);
    const compactPowerShell = run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', commandPath]);
    assert.match(compactPowerShell.stdout, /compact-returned/);
    const compactResult = JSON.parse(readFileSync(capturePath, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(compactResult.token, token);
    assert.equal(compactResult.mode, 'user');
    assert.equal(String(compactResult.sample), '10');
    assert.equal(String(compactResult.report), '90');
    assert.equal(compactResult.directory, options.installDir);
    assert.equal(compactResult.noCommand, true);
    assert.deepEqual(compactResult.prefix, [0xef, 0xbb, 0xbf, 0x70, 0x61, 0x72]);
    assert.equal(compactResult.innerBom, true);
    assert.equal(existsSync(compactResult.script), false);
  }
  writeFileSync(commandPath, `$bootstrap=${encode(bootstrap)}\nfunction Invoke-RestMethod { param($Uri) if ($Uri -eq 'https://host.test/install.ps1') { $bootstrap } else { throw 'fixture download failure' } }\n$env:POLARIS_AGENT_TOKEN='before-install'\ntry { ${compactPs}; throw 'installer should have failed' } catch { if ($_.Exception.Message -ne 'fixture download failure') { throw } }\nif ($env:POLARIS_AGENT_TOKEN -ne 'before-install') { throw 'credential environment was not restored after failure' }\nWrite-Output 'expected-download-failure'\n`);
  assert.match(run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', commandPath]).stdout, /expected-download-failure/);

  const merge = sh.match(/if ! EFFECTIVE_AUTO_UPDATE=\$\(python3 -[^]*?<<'PY'\n([^]*?)\nPY/)?.[1];
  assert.ok(merge);
  const mergePath = join(temp, 'merge.py');
  const saved = join(temp, 'saved.json');
  const update = join(temp, 'update.json');
  const merged = join(temp, 'merged.json');
  writeFileSync(mergePath, merge);
  const python = spawnSync('python3', ['--version'], { windowsHide: true }).status === 0 ? 'python3' : 'python';
  const args = [mergePath, saved, update, merged, '0', '0', '5', '60'];
  writeFileSync(saved, JSON.stringify({ endpoint: 'https://saved.test', token: 'saved-token', sample_interval: 10, report_interval: 90, include_nics: ['eth0'], insecure: true, auto_update: true }));
  writeFileSync(update, JSON.stringify({ endpoint: 'https://new.test', token: 'new-token' }));
  assert.equal(run(python, args).stdout.trim(), '1');
  const config = JSON.parse(readFileSync(merged, 'utf8'));
  assert.equal(config.endpoint, 'https://saved.test');
  assert.equal(config.token, 'saved-token');
  assert.deepEqual(config.include_nics, ['eth0']);
  assert.equal(config.insecure, true);
  writeFileSync(update, JSON.stringify({ endpoint: 'https://new.test', token: 'new-token', auto_update: false }));
  assert.equal(run(python, args).stdout.trim(), '0');
  for (const bad of [{ ...config, interval: 30 }, { ...config, custom: true }, { ...config, sample_interval: 181, report_interval: 180 }]) {
    writeFileSync(saved, JSON.stringify(bad));
    assert.notEqual(spawnSync(python, args, { windowsHide: true }).status, 0);
  }
  writeFileSync(saved, '{broken json');
  assert.notEqual(spawnSync(python, args, { windowsHide: true }).status, 0);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('PASS short installers: quoting, options, credential restoration, download failures, temporary files and strict config merge');
