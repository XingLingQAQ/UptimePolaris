import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configOption, envOption, persistOption, wrangler } from '../wrangler-cli.mjs';
import { startDevRuntime } from './dev-runtime.mjs';
import { demoSkipReason } from './live-demo-data.mjs';

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const remote = args.some(value => value === '--remote' || value.startsWith('--remote=') && value !== '--remote=false');
const option = (name, fallback) => {
  const inline = args.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

if (!remote) {
  const seedArgs = [join(here, 'seed-dev.mjs'), '--quiet'];
  const persist = persistOption(args);
  if (persist) {
    if (persist.duplicate || !persist.value || persist.value.startsWith('-')) throw new Error('Provide one path after --persist-to');
    seedArgs.push(`--persist-to=${persist.value}`);
  }
  const config = configOption(args);
  if (config) {
    if (config.duplicate || !config.value || config.value.startsWith('-')) throw new Error('Provide one path after --config / -c');
    seedArgs.push(`--config=${config.value}`);
  }
  const env = envOption(args);
  if (env) {
    if (env.duplicate || !env.value || env.value.startsWith('-')) throw new Error('Provide one name after --env / -e');
    seedArgs.push(`--env=${env.value}`);
  }
  const seed = spawn(process.execPath, seedArgs, { stdio: 'inherit', windowsHide: true });
  const code = await new Promise(resolve => { seed.once('error', () => resolve(1)); seed.once('close', code => resolve(code ?? 1)); });
  if (code !== 0) {
    console.error('[dev] Local database preparation failed; fix the error above before starting monitoring.');
    process.exit(code);
  }
}

const scheduled = !remote && !args.includes('--test-scheduled=false');
const serverArgs = ['dev', ...args];
if (scheduled && !args.some(value => value.startsWith('--test-scheduled'))) serverArgs.push('--test-scheduled');
if (!remote && process.env.UPTIME_DEV_NOTIFICATIONS === 'off') {
  serverArgs.push('--var', 'AUTOMATIC_NOTIFICATIONS_DISABLED:true');
  console.log('[dev] Automatic notifications are paused for this local session; monitoring and events remain enabled.');
}
const server = spawn(...wrangler(serverArgs), { stdio: 'inherit', windowsHide: true });
const serverClosed = new Promise(resolve => {
  server.once('error', error => { console.error(`[dev] Could not start Wrangler: ${error.message}`); resolve({ code: 1 }); });
  server.once('close', (code, signal) => resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 1) }));
});
const port = Number(option('--port', 8787));
let runtime;
let stopping = null;
let startupFailed = false;
const stop = signal => {
  if (stopping) return;
  stopping = signal;
  if (server.exitCode === null && (signal === 'SIGTERM' || !process.stdin.isTTY)) server.kill(signal);
  void runtime?.close();
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

if (!remote) {
  try { runtime = await startDevRuntime({ origin: process.env.UPTIME_DEV_WORKER_URL ?? `http://127.0.0.1:${port}`, demo: !demoSkipReason(), scheduled }); }
  catch (error) {
    console.error(`[dev] Local monitoring could not start: ${error.message}`);
    startupFailed = true;
    stop('SIGTERM');
  }
}
const outcome = await serverClosed;
await runtime?.close();
process.exitCode = startupFailed ? 1 : stopping === 'SIGINT' ? 130 : outcome.code;
