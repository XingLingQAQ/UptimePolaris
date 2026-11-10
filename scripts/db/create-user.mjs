/**
 * Create or update an account from the CLI.
 *
 * Accounts are CLI-only: an open signup on a public URL is a liability. The
 * PBKDF2 iteration count is read from the Worker's config, not chosen here:
 * a strong local cost like 600,000 would need ~760 ms to verify under the
 * Worker's 10 ms CPU budget, so every login would fail with a confusing error.
 * 哈希成本必须与 Worker 一致；本地用高成本会让登录全部超 CPU。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrangler } from '../wrangler-cli.mjs';

// WebCrypto is available in Node 18+ as globalThis.crypto.
// Node 18 起可通过 globalThis.crypto 使用 WebCrypto。
const { subtle } = globalThis.crypto;

/** Cost precedence: env override, Worker config, free-plan default. / 成本优先级：环境覆盖、Worker 配置、免费套餐默认。 */
function resolveIterations() {
  if (process.env.PBKDF2_ITERATIONS) return Number(process.env.PBKDF2_ITERATIONS);

  try {
    const toml = readFileSync('backends/worker/wrangler.toml', 'utf8');
    const m = toml.match(/^\s*PBKDF2_ITERATIONS\s*=\s*"(\d+)"/m);
    if (m) return Number(m[1]);
  } catch {
    // Falls through to the default; the file is expected but not required.
    // 文件不是必需项，读取失败时回退到默认值。
  }

  return 3000;
}

const ITERATIONS = resolveIterations();

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const remote = flag('remote');
const list = flag('list');
const username = value('username');
const password = value('password');

const target = remote ? '--remote' : '--local';

function run(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'uptime-polaris-user-'));
  const file = join(dir, 'user.sql');
  writeFileSync(file, sql, 'utf8');
  execFileSync(
    ...wrangler(['d1', 'execute', 'DB', target, `--file=${file}`, '--yes']),
    { stdio: 'inherit' },
  );
}

/** The same encoded format backends/worker/src/lib/auth/service.ts verifies: pbkdf2$iters$salt$hash. / 使用 backends/worker/src/lib/auth/service.ts 校验的相同编码格式。 */
async function hashPassword(password, iterations) {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = new Uint8Array(
    await subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256),
  );
  const b64 = (b) => Buffer.from(b).toString('base64');
  return `pbkdf2$${iterations}$${b64(salt)}$${b64(bits)}`;
}

// ---------------------------------------------------------------- list
// 列出账号 / List accounts

if (list) {
  run('SELECT id, username, created_at, failed_count, locked_until FROM users ORDER BY created_at;');
  process.exit(0);
}

// ---------------------------------------------------------------- create
// 创建账号 / Create account

if (!username) {
  console.error('usage: npm run user:create -- --username <name> [--password <pw>] [--remote]');
  console.error('       npm run user:list [--remote]');
  process.exit(1);
}

if (!password) {
  console.error('a password is required: pass --password <pw>');
  console.error('(a prompt is deliberately not implemented so the password never lands in a shell history-adjacent buffer)');
  process.exit(1);
}

if (password.length < 8) {
  console.error('password must be at least 8 characters');
  process.exit(1);
}

const normalized = username.trim().toLowerCase();
// The same rule as USERNAME_RE in backends/worker/src/lib/auth/service.ts, which the console form also
// uses. Kept as a literal here rather than imported because this script must run
// in plain Node before the Worker is ever built.
// 与 Worker 和控制台的用户名规则一致；此脚本需在构建前由纯 Node 运行，故保留字面量。
if (!/^[a-z0-9._-]{2,32}$/.test(normalized)) {
  console.error('username must be 2-32 characters of a-z, 0-9, dot, underscore or hyphen');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const hash = await hashPassword(password, ITERATIONS);
const id = globalThis.crypto.randomUUID();


const sql = `
INSERT INTO users (id, username, password_hash, created_at, updated_at, failed_count, locked_until )
VALUES ('${id}', '${normalized}', '${hash}', ${now}, ${now}, 0, 0)
ON CONFLICT(username) DO UPDATE SET
  password_hash        = excluded.password_hash,
  updated_at           = excluded.updated_at,
  failed_count         = 0,
  locked_until         = 0;
`;

console.log(`[user] ${remote ? 'remote' : 'local'}: setting password for "${normalized}"`);
console.log(`[user] PBKDF2 ${ITERATIONS.toLocaleString()} iterations (from backends/worker/wrangler.toml)`);
run(sql);

console.log(`\n[user] done. Sign in at /login as "${normalized}".`);
if (ITERATIONS > 20_000) {
  console.log(
    `[user] warning: ${ITERATIONS.toLocaleString()} iterations needs roughly ` +
      `${((ITERATIONS / 1000) * 1.3).toFixed(0)} ms to verify, which exceeds a\n` +
      `[user] free-plan Worker's 10 ms CPU budget. Logins will fail with a CPU error.\n` +
      `[user] Lower PBKDF2_ITERATIONS in backends/worker/wrangler.toml unless this Worker is on a paid plan.`,
  );
}
