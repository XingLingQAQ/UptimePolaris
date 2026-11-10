import { execFileSync } from 'node:child_process';
import { wrangler } from '../wrangler-cli.mjs';

const target = process.argv.includes('--remote') ? '--remote' : '--local';
try {
  execFileSync(...wrangler(['d1', 'migrations', 'apply', 'DB', target]), { stdio: 'inherit', windowsHide: true });
} catch (error) {
  console.error(`[db:init] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
