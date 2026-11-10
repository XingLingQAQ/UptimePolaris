import { defineConfig, type ProxyOptions } from 'vite';
import type { ClientRequest, IncomingMessage } from 'node:http';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { stagewise } from './dev/stagewise.mjs';
import { stagewiseToolbar } from './dev/stagewise-toolbar.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const devOrigin = process.env.POLARIS_DEV_ORIGIN ? new URL(process.env.POLARIS_DEV_ORIGIN) : undefined;
if (devOrigin && (devOrigin.protocol !== 'https:' || devOrigin.username || devOrigin.password ||
  devOrigin.pathname !== '/' || devOrigin.search || devOrigin.hash)) {
  throw new Error('POLARIS_DEV_ORIGIN must be an HTTPS origin without a path or credentials');
}
const backendProxy: ProxyOptions = {
  target: process.env.POLARIS_BACKEND_URL || 'http://127.0.0.1:8787',
  changeOrigin: false,
  configure(proxy) {
    const previewHost = (outgoing: ClientRequest, request: IncomingMessage) => {
      if (devOrigin && request.headers.host === devOrigin.host && /^\/api\/public(?:\/|\?|$)/.test(request.url ?? '')) {
        outgoing.setHeader('host', '127.0.0.1');
      }
    };
    proxy.on('proxyReq', previewHost);
    proxy.on('proxyReqWs', previewHost);
  },
};

export default defineConfig({
  // Served from the site root. A sub-path base would force the router, every
  // asset URL and every favicon reference to carry a prefix for no benefit -
  // the app owns the whole origin.
  // 应用占用整个域名，从根路径提供资源，避免路由、资源和图标额外添加前缀。
  base: '/',
  plugins: [react(), stagewise({ publicOrigin: devOrigin?.origin }), stagewiseToolbar(), {
    name: 'polaris-clean-generated-assets',
    apply: 'build',
    buildStart() {
      const directory = fileURLToPath(new URL('../public/assets', import.meta.url));
      if (!existsSync(directory)) return;
      const parent = realpathSync(fileURLToPath(new URL('../public', import.meta.url)));
      const target = realpathSync(directory);
      if (target !== resolvePath(parent, 'assets')) throw new Error('Generated asset directory resolves outside public/');
      rmSync(target, { recursive: true, force: true });
    },
  }],
  /** 预打包列出的运行时依赖，并统一其开发期模块解析。 / Prebundle the listed runtime dependencies with consistent development-time module resolution. */
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-router',
      'use-intl',
      'swr',
      'next-themes',
      'framer-motion',
      '@heroui/react',
      '@heroui/theme',
      'recharts',
      'sonner',
      'dayjs',
      'clsx',
      'tailwind-merge',
      'usehooks-ts',
      'lucide-react',
    ],
    esbuildOptions: {
      // These packages resolve through `exports` maps, so conditions matter
      // more than mainFields; 'browser' keeps the DOM build of react-dom.
      // 这些包通过 exports 解析，条件比 mainFields 更重要；browser 保留 react-dom 的 DOM 构建。
      conditions: ['browser', 'import', 'module', 'default'],
    },
  },
  define: {
    // Inlined at build time. Reading package.json from the client bundle would
    // ship the whole manifest just to show one string in the footer.
    // 构建时内联版本号，避免为了页脚文字将整个 package.json 打包到客户端。
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      // Keep the alias aligned with tsconfig. / 别名与 tsconfig 保持一致。
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // 与 Worker 的 ASSETS 目录保持一致。
    // Match the Worker's ASSETS directory.
    outDir: '../public',
    /** 只清理生成的 assets，保留 public 中的其他文件和本地 Agent 构建。 / Clean generated assets only, preserving other public files and local Agent builds. */
    emptyOutDir: false,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          /** 预加载辅助代码与通用依赖独立分包，避免被归入 UI 或图表包。 / Give preload helpers and shared dependencies their own chunks instead of assigning them to UI or chart chunks. */
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'preload';
          }
          if (
            id.includes('node_modules/clsx') ||
            id.includes('node_modules/tailwind-merge') ||
            id.includes('node_modules/dequal') ||
            id.includes('node_modules/cookie') ||
            id.includes('node_modules/set-cookie-parser') ||
            id.includes('node_modules/use-sync-external-store')
          ) {
            return 'shared';
          }
          // Recharts pulls in d3-* and is only needed on pages that draw a
          // chart, so it stays in its own chunk.
          // Recharts 依赖 d3，仅图表页面需要，因此单独分包。
          if (id.includes('recharts') || id.includes('d3-') || id.includes('victory')) {
            return 'charts';
          }
          // UI 与可访问性依赖归入同一个 heroui 包。
          // Group UI and accessibility dependencies in the same heroui chunk.
          if (id.includes('@heroui/') || id.includes('@react-aria/') || id.includes('@react-types/')) {
            return 'heroui';
          }
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react';
          }
          if (id.includes('node_modules/react-router')) {
            return 'router';
          }
          if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion')) {
            return 'motion';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 3882,
    allowedHosts: devOrigin ? [devOrigin.hostname] : [],
    proxy: {
      // In dev, hit the wrangler dev server for data. / 开发时通过 wrangler 开发服务器获取数据。
      '/api': {
        ...backendProxy,
        ws: true,
      },
      '/install.sh': { ...backendProxy },
      '/install.ps1': { ...backendProxy },
      '/polaris-maintenance.js': { ...backendProxy },
    },
  },
});
