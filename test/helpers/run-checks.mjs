// 启动选定探测套件并透传退出状态。
// Run the selected probe suite and propagate its exit status.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.env.UPTIME_CHECKS_TARGET ?? join(dirname(fileURLToPath(import.meta.url)), '../monitors/checks.test.mjs');
const child = spawn(process.execPath, [target], { stdio: 'inherit' });
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal }));
});

if (result.signal) {
  console.error(`checks.test.mjs terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.code ?? 1);
