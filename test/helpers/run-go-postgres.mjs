// 启动独占 PostgreSQL 夹具验证 Go 迁移与初始化。
// Start an owned PostgreSQL fixture for Go migration and setup tests.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');
const root = mkdtempSync(join(tmpdir(), 'uptime-polaris-go-pg-'));
const data = join(root, 'data');
const marker = join(root, '.uptime-polaris-pg-owner');
const owner = randomUUID();
writeFileSync(marker, owner, { flag: 'wx' });
let startAttempted = false;
let pgCtl;
let port;
try {
  const listener = net.createServer();
  await new Promise((resolveListen, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  port = listener.address().port;
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
  const find = name => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? `${name}.exe` : name], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  const initdb = find('initdb');
  pgCtl = find('pg_ctl');
  execFileSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'inherit', windowsHide: true });
  startAttempted = true;
  execFileSync(pgCtl, ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'inherit', windowsHide: true, timeout: 20000 });
  execFileSync('go', ['-C', join(workspace, 'backends/go'), 'test', './internal/polaris', './cmd/polaris', '-run', '^Test(PostgresMigrationAndRuntime|OfflineMigration|OfflineMigrationCLI|SetupDatabasePostgres)$', '-count=1', '-v'], {
    cwd: workspace, stdio: 'inherit', windowsHide: true, timeout: 180000,
    env: { ...process.env, POLARIS_TEST_POSTGRES_URL: `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable` },
  });
} finally {
  const absoluteRoot = realpathSync(root);
  assert.ok(absoluteRoot.startsWith(realpathSync(tmpdir()) + sep), 'PostgreSQL fixture escaped temp directory');
  assert.equal(readFileSync(marker, 'utf8'), owner);
  if (startAttempted && pgCtl) {
    const status = spawnSync(pgCtl, ['-D', data, 'status'], { encoding: 'utf8', windowsHide: true });
    if (status.error) throw status.error;
    if (status.status === 0) {
      const pid = readFileSync(join(data, 'postmaster.pid'), 'utf8').split(/\r?\n/);
      assert.equal(resolve(pid[1]), resolve(data));
      assert.equal(Number(pid[3]), port);
      assert.equal(readFileSync(marker, 'utf8'), owner);
      execFileSync(pgCtl, ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit', windowsHide: true, timeout: 20000 });
    } else if (existsSync(join(data, 'postmaster.pid'))) {
      throw new Error('Unresolved owned PostgreSQL pid; leaving fixture for recovery');
    }
  }
  assert.equal(realpathSync(root), absoluteRoot);
  assert.equal(readFileSync(marker, 'utf8'), owner);
  rmSync(absoluteRoot, { recursive: true, force: true });
}
