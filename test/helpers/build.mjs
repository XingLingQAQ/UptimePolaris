/**
 * Bundles a test file for Node, stubbing out Workers-only modules.
 *
 * `cloudflare:sockets` does not exist outside the Workers runtime, and Node's
 * ESM loader rejects the `cloudflare:` scheme outright, so it has to be
 * replaced rather than marked external.
 *
 * Usage: node test/helpers/build.mjs <entry> <outfile>
 *
 * 为 Node 打包测试，并替换仅在 Workers 中可用的模块。
 * Node 的 ESM 加载器不支持 cloudflare: 协议，因此必须替换 cloudflare:sockets。
 */
import { build } from 'esbuild';

const [, , entry, outfile] = process.argv;
if (!entry || !outfile) {
  console.error('usage: node test/helpers/build.mjs <entry> <outfile>');
  process.exit(1);
}

const stubWorkersModules = {
  name: 'stub-workers-modules',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
      path: 'cloudflare-sockets-stub',
      namespace: 'stub',
    }));
    /* D1 测试不构造 PostgreSQL 驱动；替身被调用时立即失败。
     * D1 tests do not construct the PostgreSQL driver; fail if the stub is called. */
    b.onResolve({ filter: /^postgres$/ }, () => ({
      path: 'postgres-stub',
      namespace: 'stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'postgres-stub'
        ? `export default function postgres() {
             throw new Error('postgres driver is stubbed in tests');
           }`
        : `export function connect() {
             throw new Error('cloudflare:sockets is not available outside Workers');
           }`,
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'error',
  plugins: [stubWorkersModules],
});
