// 启动独占 PostgreSQL 夹具并执行实际数据库测试。
// Start an owned PostgreSQL fixture and run database tests.

import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = mkdtempSync(join(tmpdir(), 'uptime-polaris-pg-real-'));
const dataDir = join(root, 'data');
const owner = randomUUID();
const marker = join(root, '.uptime-polaris-pg-owner');
const output = resolve('artifacts/tmp/postgres-real.mjs');
let startAttempted = false;
let port;
let pgCtl;

try {
  writeFileSync(marker, owner, { flag: 'wx' });
  const listener = net.createServer();
  await new Promise((resolveListen, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  port = listener.address().port;
  await new Promise((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));

  const executable = (name) => process.platform === 'win32' ? `${name}.exe` : name;
  const find = (name) => {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(command, [executable(name)], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  };
  const initdb = find('initdb');
  pgCtl = find('pg_ctl');
  execFileSync(initdb, ['-D', dataDir, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'inherit' });
  startAttempted = true;
  execFileSync(pgCtl, [
    '-D', dataDir, '-l', join(root, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start',
  ], { stdio: 'inherit', windowsHide: true });
  await build({
    entryPoints: ['test/db/postgres-real.test.mjs'],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'error',
    plugins: [{ name: 'unused-worker-sockets', setup(builder) {
      builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function connect(){throw new Error("Unexpected Worker socket in Node fixture")}' }));
    } }],
  });
  execFileSync(process.execPath, [output], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TEST_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/postgres`,
      UPTIME_PG_OWNER: owner,
      UPTIME_PG_ROOT: root,
      UPTIME_PG_DATA: dataDir,
      UPTIME_PG_PORT: String(port),
    },
  });
} finally {
  const resolvedRoot = realpathSync(root);
  const tempRoot = realpathSync(tmpdir());
  if (!resolvedRoot.startsWith(tempRoot + (process.platform === 'win32' ? '\\' : '/'))) {
    throw new Error('Postgres fixture escaped the OS temp directory');
  }
  if (readFileSync(marker, 'utf8') !== owner) throw new Error('Postgres fixture ownership marker changed');
  if (startAttempted && pgCtl) {
    const status = spawnSync(pgCtl, ['-D', dataDir, 'status'], { encoding: 'utf8', windowsHide: true });
    if (status.error) throw status.error;
    if (status.status === 0) {
      const pidFile = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split(/\r?\n/);
      if (resolve(pidFile[1]) !== resolve(dataDir) || Number(pidFile[3]) !== port) {
        throw new Error('Postgres process did not match the owned data directory and port');
      }
      if (readFileSync(marker, 'utf8') !== owner) throw new Error('Postgres ownership marker changed before stop');
      execFileSync(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit', windowsHide: true });
    } else if (existsSync(join(dataDir, 'postmaster.pid'))) {
      throw new Error('Postgres fixture has an unresolved postmaster.pid; leaving its data directory intact');
    }
  }
  if (realpathSync(root) !== resolvedRoot || readFileSync(marker, 'utf8') !== owner) {
    throw new Error('Postgres fixture changed before cleanup');
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}
