#!/usr/bin/env node
/* 使用 Node HTTP 静态服务提供可复用连接的主题资源夹具。
 * Serve theme fixtures through Node HTTP with reusable connections. */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 8899);
const root = resolve(process.argv[3] ?? join(process.cwd(), 'artifacts', 'tmp'));

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer((req, res) => {
  // Normalise and confine to the root: a fixture server is still a server.
  // 规范化路径并限制在根目录内；测试服务器同样需要路径边界。
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(
    /^([/\\])+/,
    '',
  );
  const path = join(root, rel);

  if (!path.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not a file');
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    // No caching, so a fixture rebuilt mid-run is served fresh.
    // 禁用缓存，确保运行中重新构建的测试文件立即生效。
    'cache-control': 'no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path).pipe(res);
});

// HTTP/1.1 with keep-alive, which is the whole point of this file.
// 使用带 keep-alive 的 HTTP/1.1，这是本服务器的目的。
server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture server on http://127.0.0.1:${port} serving ${root}`);
});
