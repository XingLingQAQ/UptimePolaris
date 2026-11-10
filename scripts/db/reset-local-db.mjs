import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = resolve(root, '.wrangler', 'state', 'v3', 'd1');
const insideRoot = (path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

if (!insideRoot(state) || !insideRoot(resolve(state, '..', '..', '..'))) {
  throw new Error('Refusing to remove a path outside the workspace.');
}
if (realpathSync(root) !== root) throw new Error('Workspace path is not canonical; refusing cleanup.');

function workspaceProcesses() {
  if (process.platform === 'win32') {
    const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    const output = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    const parsed = JSON.parse(output || '[]');
    return (parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed])
      .map((p) => ({ pid: Number(p.ProcessId), command: String(p.CommandLine ?? '') }))
      .filter((p) => p.pid !== process.pid && p.command.toLowerCase().includes(root.toLowerCase()) && /workerd|wrangler.*\bdev\b/i.test(p.command));
  }
  const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[2];
    return pid !== process.pid && command.toLowerCase().includes(root.toLowerCase()) && /workerd|wrangler.*\bdev\b/i.test(command)
      ? [{ pid, command }]
      : [];
  });
}

for (const candidate of workspaceProcesses()) {
  const current = workspaceProcesses().find((p) => p.pid === candidate.pid);
  if (!current || current.command !== candidate.command) continue;
  if (process.platform === 'win32') {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${candidate.pid}'; if ($p -and $p.CommandLine -ceq ${quote(candidate.command)} -and $p.CommandLine.Contains(${quote(root)})) { Stop-Process -Id ${candidate.pid} -Force }`;
    execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
  } else {
    process.kill(candidate.pid, 'SIGTERM');
  }
}

if (existsSync(state)) {
  let current = root;
  for (const part of relative(root, state).split(sep)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing cleanup through symlink: ${current}`);
  }
  const checked = realpathSync(state);
  if (checked !== state || !insideRoot(checked)) throw new Error('Local D1 state path changed during validation.');
  rmSync(checked, { recursive: true, force: true });
  console.log('[reset] removed workspace local D1 state');
} else {
  console.log('[reset] no workspace local D1 state found');
}

const result = spawnSync(process.execPath, ['scripts/db/db-init.mjs', '--local'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
