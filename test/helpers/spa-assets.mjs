// 为 Worker 测试提供构建后的 SPA 资源。
// Serve built SPA assets to Worker tests.

import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function spaAssetService(publicDir) {
  return async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://assets.local').pathname);
    let file = resolve(publicDir, `.${path}`);
    if (file !== publicDir && !file.startsWith(publicDir + sep)) {
      response.writeHead(400).end('bad path');
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    } catch {
      file = resolve(publicDir, 'index.html');
    }
    try {
      response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    } catch {
      response.writeHead(404).end('not found');
    }
  };
}
