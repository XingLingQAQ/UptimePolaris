import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const defaultConfig = resolve(import.meta.dirname, '../backends/worker/wrangler.toml');

function option(args, name, short) {
  let result = null;
  const selected = value => { result = { value, duplicate: Boolean(result) }; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === name || (short && arg === short)) selected(args[++i]);
    else if (arg.startsWith(`${name}=`)) selected(arg.slice(name.length + 1));
    else if (short && arg.startsWith(`${short}=`)) selected(arg.slice(short.length + 1));
    else if (short && arg.startsWith(short) && arg.length > short.length) selected(arg.slice(short.length));
  }
  return result;
}

export const configOption = args => option(args, '--config', '-c');
export const persistOption = args => option(args, '--persist-to');
export const envOption = args => option(args, '--env', '-e');

export function wrangler(args) {
  const manifestPath = require.resolve('wrangler/package.json');
  const manifest = require(manifestPath);
  const declared = manifest.bin?.wrangler;
  if (!declared) throw new Error('Installed wrangler package has no wrangler CLI entry; run npm ci.');
  const selectedArgs = [...args];
  const selectedConfig = configOption(args);
  const useDefault = !selectedConfig || resolve(selectedConfig.value ?? '') === defaultConfig;
  const insert = (...flags) => {
    const separator = selectedArgs.indexOf('--');
    selectedArgs.splice(separator < 0 ? selectedArgs.length : separator, 0, ...flags);
  };
  if (useDefault && args[0] === 'dev' && !args.some(arg => arg === '--env-file' || arg.startsWith('--env-file='))) {
    const localEnv = resolve(import.meta.dirname, '../.dev.vars');
    if (existsSync(localEnv)) insert('--env-file', localEnv);
  }
  if (useDefault && (args[0] === 'dev' || args.includes('--local')) && !persistOption(args)) {
    insert('--persist-to', resolve(import.meta.dirname, '../.wrangler/state'));
  }
  if (!selectedConfig) {
    insert('--config', defaultConfig);
  }
  return [process.execPath, [resolve(dirname(manifestPath), declared), ...selectedArgs]];
}
