/* 为 D1 测试替换 socket 和 PostgreSQL 导入；替身不模拟网络或数据库成功。
 * Stub socket and PostgreSQL imports for D1 fixtures; neither stub simulates successful I/O. */
export function workerBundlePlugins() {
  return [
    {
      name: 'stub-workers-modules',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
          path: 'sockets',
          namespace: 'stub',
        }));
        b.onResolve({ filter: /^postgres$/ }, () => ({
          path: 'postgres',
          namespace: 'stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
          if (args.path === 'sockets') {
            return {
              contents:
                'export const connect = () => { throw new Error("cloudflare:sockets is not available outside Workers"); };',
            };
          }
          return {
            contents: `
              export default function postgres() {
                throw new Error('postgres adapter is stubbed in this test bundle - use a real DATABASE_URL');
              }
            `,
          };
        });
      },
    },
  ];
}
