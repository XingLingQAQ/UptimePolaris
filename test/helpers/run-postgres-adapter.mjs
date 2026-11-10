/* 保留真实 PostgreSQL 驱动以验证适配器，单独替换 Worker socket 导入。
 * Keep the PostgreSQL driver for adapter checks and stub only the Worker socket import. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('artifacts/tmp', { recursive: true });
const OUT = 'artifacts/tmp/postgres-adapter.mjs';

await build({
  entryPoints: ['test/db/postgres-adapter.test.mjs'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'error',
  plugins: [
    {
      name: 'stub-cf-sockets',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
          path: 'cf-sockets-stub',
          namespace: 'stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export function connect() {
            throw new Error('cloudflare:sockets is not available outside Workers');
          }`,
          loader: 'js',
        }));
      },
    },
  ],
  // `postgres` stays bundled; we want the real driver.
  // 保留打包的 postgres，以使用真实驱动。
});

execFileSync(process.execPath, [OUT], { stdio: 'inherit' });
