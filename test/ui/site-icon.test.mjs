import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';
/* 通过实际 API 验证图标上传、公开读取、替换、删除与格式拒绝。
 * Use the API to check icon upload, public reads, replacement, deletion, and format rejection. */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const ADMIN_TOKEN = 'site-icon-token';

const watchdog = setTimeout(() => {
  console.error('FAIL site-icon fixture timed out before completion');
  process.exit(2);
}, 90_000);

const HARNESS = `
import { api } from './backends/worker/src/api';
import { readSiteIcon } from './backends/worker/src/lib/settings/site-icon';
import { Buffer } from 'node:buffer';
export default {
  async fetch(req, env, ctx) {
    if (new URL(req.url).pathname === '/fixture/blob') {
      const shapes = [new Uint8Array([1, 2, 255]), new Uint8Array([1, 2, 255]).buffer,
        [1, 2, 255], Buffer.from([1, 2, 255]), 'AQL/', [1, -1], [1, 256], [1, 2.5], ['1'], '???', null];
      const results = [];
      for (const bytes of shapes) {
        const statement = { bind() { return this; }, all: async () => ({ results: [{ bytes, content_type: 'image/png' }], meta: {} }) };
        const icon = await readSiteIcon({ DB: { prepare: () => statement } });
        results.push(icon ? [...icon.bytes] : null);
      }
      return Response.json(results);
    }
    return api.fetch(req, env, ctx);
  },
};
`;

const built = await build({
  stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  write: false,
  target: 'es2022',
  external: ['node:buffer'],
  logLevel: 'error',
  plugins: [
    {
      name: 'site-icon-stubs',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'sockets', namespace: 'stub' }));
        b.onResolve({ filter: /^postgres$/ }, () => ({ path: 'postgres-stub', namespace: 'pgstub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const connect = () => { throw new Error("no sockets in this test"); };',
        }));
        b.onLoad({ filter: /.*/, namespace: 'pgstub' }, () => ({
          contents: `export default function postgres() { throw new Error('postgres is stubbed in this test bundle'); }`,
        }));
      },
    },
  ],
});

const mf = new Miniflare({
  modules: true,
  script: built.outputFiles[0].text,
  compatibilityDate: '2025-01-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings: { ADMIN_TOKEN, PBKDF2_ITERATIONS: '3000' },
  d1Databases: { DB: 'site-icon-test' },
});

const origin = 'http://localhost';
const db = await mf.getD1Database('DB');
await applyD1Migrations(db);

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}
function eq(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  check(label, same, same ? undefined : { got, want });
}

const authed = { authorization: `Bearer ${ADMIN_TOKEN}` };

// 注入驱动返回值，只验证读取边界；实际上传与数据库往返由后续用例验证。
// Inject driver return values for the read boundary; later cases exercise upload and database round trips.
assert.deepEqual(await (await mf.dispatchFetch(`${origin}/fixture/blob`)).json(), [
  ...Array.from({ length: 5 }, () => [1, 2, 255]), ...Array(6).fill(null),
]);

async function upload(bytes, headers = {}) {
  const res = await mf.dispatchFetch(`${origin}/api/admin/site-icon`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'image/png', ...headers },
    body: bytes,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function readAdmin() {
  const res = await mf.dispatchFetch(`${origin}/api/admin/site-icon`, { headers: authed });
  return JSON.parse(await res.text());
}

async function readPublic() {
  return mf.dispatchFetch(`${origin}/api/public/icon`);
}

/** A real 2x2 PNG, so the sniffing path sees actual bytes. / 使用真实 2x2 PNG，让内容嗅探路径读取实际字节。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nGNgYGD4z8Dw' +
  'n4GBAQAAAAD//wMAAP8A//8AAoAAAf+amj8cAAAAAElFTkSuQmCC',
  'base64',
);

try {
  // ---------------------------------------------------------- nothing stored
  // 尚未存储 / Nothing stored

  console.log('\nno upload yet\n');
  {
    const admin = await readAdmin();
    eq('the admin read reports no upload', admin.uploaded, false);

    const pub = await readPublic();
    const body = Buffer.from(await pub.arrayBuffer());
    // The generated mark is the fallback, so "no upload" must still render.
    // 生成标志是回退内容，因此未上传时仍应显示图标。
    check('the public route serves the generated SVG', pub.headers.get('content-type')?.startsWith('image/svg+xml'), pub.headers.get('content-type'));
    check('the generated mark is not empty', body.length > 0, body.length);
  }

  // ------------------------------------------------------------------ upload
  // 上传 / Upload

  console.log('\nPOST /api/admin/site-icon\n');
  {
    const r = await upload(PNG, { 'x-icon-filename': 'logo.png' });
    eq('an accepted upload answers 200', r.status, 200);
    eq('the type comes from the bytes, not the header', r.body.contentType, 'image/png');
    eq('the byte count is the body length', r.body.byteSize, PNG.length);
    eq('the filename is kept for display', r.body.filename, 'logo.png');

    /*
     * The regression. Before the fix this returned `uploaded:false` even though
     * the row was present and correct, because Miniflare hands a BLOB back as a
     * byte array and `toBytes` did not accept that shape.
     * 回归测试：修复前虽然行存在且正确，此处仍返回 uploaded:false，因为 Miniflare 将 BLOB
     * 返回为字节数组，而 toBytes 不接受这种形式。
     */
    const admin = await readAdmin();
    eq('the admin read sees the upload', admin.uploaded, true);
    eq('the admin read reports the stored type', admin.contentType, 'image/png');
    eq('the admin read reports the stored size', admin.byteSize, PNG.length);
    check('the preview is a data URL of the stored bytes', typeof admin.dataUrl === 'string' && admin.dataUrl.startsWith('data:image/png;base64,'), admin.dataUrl?.slice(0, 40));

    const pub = await readPublic();
    const served = Buffer.from(await pub.arrayBuffer());
    eq('the public route switches to the upload', pub.headers.get('content-type'), 'image/png');
    eq('the public route serves the stored bytes', served.equals(PNG), true);
    check('the served response carries an ETag', Boolean(pub.headers.get('etag')), pub.headers.get('etag'));
    check('the served response is sniff-proof', pub.headers.get('x-content-type-options') === 'nosniff');
    /*
     * The upload is operator content on the app's own origin. The CSP is what
     * keeps it inert, so its absence is a security regression rather than a
     * cosmetic one.
     * 上传内容在应用自身源上提供；CSP 使其保持惰性，因此缺少 CSP 是安全回归而非外观问题。
     */
    check('the served response denies active capabilities', (pub.headers.get('content-security-policy') ?? '').includes("default-src 'none'"), pub.headers.get('content-security-policy'));
  }

  // ------------------------------------------------ replacement, not history
  // 替换而非保留历史 / Replacement, not history

  console.log('\nreplacing the icon\n');
  {
    const second = Buffer.concat([PNG, Buffer.from([0])]);
    const r = await upload(second, { 'x-icon-filename': 'second.png' });
    eq('a second upload is accepted', r.status, 200);

    const rows = await db.prepare('SELECT COUNT(*) AS n FROM site_icon').first();
    eq('there is still exactly one row', rows.n, 1);

    const pub = await readPublic();
    const served = Buffer.from(await pub.arrayBuffer());
    eq('the public route serves the replacement', served.equals(second), true);
  }

  // -------------------------------------------------- public read is by path
  // 公开读取按路径进行 / Public read is by path

  console.log('\nthe write route is gated\n');
  {
    const res = await mf.dispatchFetch(`${origin}/api/admin/site-icon`, { method: 'POST', body: PNG });
    check('an unauthenticated upload is refused', res.status === 401 || res.status === 403, res.status);
    const del = await mf.dispatchFetch(`${origin}/api/admin/site-icon`, { method: 'DELETE' });
    check('an unauthenticated delete is refused', del.status === 401 || del.status === 403, del.status);
  }

  // ------------------------------------------------------------- rejections
  // 拒绝情况 / Rejections

  console.log('\nrejected uploads\n');
  {
    const empty = await upload(Buffer.alloc(0));
    eq('an empty body is refused', empty.body.error, 'empty');

    /*
     * SVG is refused because it can carry script and this route serves to
     * anonymous visitors on every page. A test that only checked the size cap
     * would miss the one rejection that is a security boundary.
     * 拒绝 SVG，因为它可包含脚本，而此接口在每个页面向匿名访客提供内容。
     * 仅检查大小限制的测试会遗漏这一安全边界。
     */
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const asSvg = await upload(svg, { 'content-type': 'image/svg+xml' });
    eq('an SVG is refused even when the header claims otherwise', asSvg.body.error, 'unsupported_type');

    const junk = await upload(Buffer.from('not an image at all'));
    eq('unrecognised bytes are refused', junk.body.error, 'unsupported_type');

    const tooBig = await upload(Buffer.concat([PNG, Buffer.alloc(256 * 1024)]));
    eq('a body past the cap is refused', tooBig.body.error, 'too_large');
    eq('the refusal states the cap', tooBig.body.maxBytes, 256 * 1024);

    // The stored icon is untouched by every rejection above.
    // 以上所有拒绝都不得修改已存图标。
    const pub = await readPublic();
    eq('the previous icon survives rejected uploads', pub.headers.get('content-type'), 'image/png');
  }

  // ------------------------------------------------------------- the bytes
  // 字节内容 / The bytes

  console.log('\nthe reader accepts every driver shape\n');
  {
    /* 此处验证 Miniflare 返回的字节数组；其他驱动形态在独立用例中注入。
     * Check Miniflare's byte array here; inject other driver shapes in separate cases. */
    const raw = await db.prepare('SELECT bytes FROM site_icon WHERE singleton = 1').first();
    eq('Miniflare hands a BLOB back as a byte array', Array.isArray(raw.bytes), true);
    check('the array holds byte values', raw.bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255), raw.bytes.slice(0, 8));

    /*
     * And the reader turned that same shape into the exact bytes on the wire.
     * Re-uploaded first so this compares against a known body rather than
     * whichever replacement the earlier block left behind.
     * 读取器必须将相同形态转换为传输中的精确字节。先重新上传，使比较对象是已知内容，
     * 而非先前替换测试留下的内容。
     */
    eq('re-uploading the base image succeeds', (await upload(PNG)).status, 200);
    const pub = await readPublic();
    const served = Buffer.from(await pub.arrayBuffer());
    eq('the bytes survive the round trip unchanged', served.equals(PNG), true);
  }

  // ----------------------------------------------------------------- remove
  // 删除 / Remove

  console.log('\nDELETE /api/admin/site-icon\n');
  {
    const res = await mf.dispatchFetch(`${origin}/api/admin/site-icon`, { method: 'DELETE', headers: authed });
    eq('removing answers 200', res.status, 200);

    const admin = await readAdmin();
    eq('the admin read reports no upload again', admin.uploaded, false);

    const rows = await db.prepare('SELECT COUNT(*) AS n FROM site_icon').first();
    eq('the row is gone', rows.n, 0);

    const pub = await readPublic();
    check('the generated mark comes back', pub.headers.get('content-type')?.startsWith('image/svg+xml'), pub.headers.get('content-type'));
  }

  // -------------------------------------------- the setting routes to it too
  // 设置也指向该接口 / The setting routes to it too

  console.log('\nsite.icon points at the route that serves the upload\n');
  {
    const res = await mf.dispatchFetch(`${origin}/api/admin/settings`, { headers: authed });
    const body = JSON.parse(await res.text());
    /*
     * The upload is only useful if pages ask for it, so the default has to name
     * the route that prefers the stored bytes over the generated mark.
     * 只有页面请求上传图标时它才有用，因此默认设置必须指向优先提供存储字节、
     * 然后才使用生成标志的接口。
     */
    eq('the default site.icon is the public icon route', body.values['site.icon'], '/api/public/icon');
  }
} finally {
  await mf.dispose();
  clearTimeout(watchdog);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
assert.ok(fail === 0, `${fail} assertion(s) failed`);
process.exit(0);
