// 启动独占 PostgreSQL 夹具，执行 Worker 选库测试。
// Start an owned PostgreSQL fixture for Worker database-selection tests.

import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import net from 'node:net';
import { build } from 'esbuild';

const output = resolve('artifacts/tmp/worker-postgres-setup');
mkdirSync(output, { recursive: true });
const base = realpathSync(output);
const root = mkdtempSync(join(base, 'postgres-setup-'));
const data = join(root, 'data');
const marker = join(root, 'owner');
const owner = randomUUID();
writeFileSync(marker, owner, { flag: 'wx' });
const find = name => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
const initdb = find('initdb');
const pgctl = find('pg_ctl');
const listener = net.createServer();
await new Promise((ok, fail) => listener.once('error', fail).listen(0, '127.0.0.1', ok));
const port = listener.address().port;
await new Promise((ok, fail) => listener.close(err => err ? fail(err) : ok()));
let attempted = false;
try {
  execFileSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'inherit', windowsHide: true });
  attempted = true;
  execFileSync(pgctl, ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1`, '-w', 'start'], { stdio: 'inherit', windowsHide: true });
  const outfile = join(root, 'worker-postgres-setup.mjs');
  await build({ entryPoints: ['test/auth/worker-postgres-setup.test.mjs'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'unused-socket', setup(b) {
      b.onResolve({ filter: /^postgres$/ }, args => args.namespace === 'fixture-pg' ? { path: 'postgres', external: true } : /backends[\\/]/.test(args.importer) ? { path: 'native-postgres', namespace: 'fixture-pg' } : undefined);
      b.onLoad({ filter: /.*/, namespace: 'fixture-pg' }, () => ({ contents: `import postgres from 'postgres';
        export default function(url, options) {
          const parsed = new URL(url);
          if (parsed.hostname !== 'db.fixture.test') return postgres(url, options);
          parsed.username = 'postgres'; parsed.hostname = '127.0.0.1'; parsed.port = process.env.UPTIME_FIXTURE_PORT;
          parsed.searchParams.set('sslmode', 'disable');
          return postgres(parsed.toString(), {...options, ssl: false});
        }` }));
      b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'socket', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function connect(){throw new Error("unexpected Worker socket")}' }));
    } }] });
  execFileSync(process.execPath, [outfile], { stdio: 'inherit', windowsHide: true, env: { ...process.env, UPTIME_FIXTURE_PORT: String(port) } });
} finally {
  if (!realpathSync(root).startsWith(base + sep) || readFileSync(marker, 'utf8') !== owner) throw new Error('fixture ownership check failed');
  if (attempted) {
    const status = spawnSync(pgctl, ['-D', data, 'status'], { encoding: 'utf8', windowsHide: true });
    if (status.status === 0) {
      const pid = readFileSync(join(data, 'postmaster.pid'), 'utf8').split(/\r?\n/);
      if (resolve(pid[1]) !== resolve(data) || Number(pid[3]) !== port) throw new Error('unexpected PostgreSQL owner');
      execFileSync(pgctl, ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit', windowsHide: true });
    } else if (existsSync(join(data, 'postmaster.pid'))) throw new Error('unresolved fixture server');
  }
  console.log(`Fixture retained: ${root}`);
}
