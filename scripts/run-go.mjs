import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = spawn(process.execPath, [join(root, 'scripts/build-go.mjs')], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
const built = await new Promise((resolve, reject) => {
  build.once('error', reject);
  build.once('exit', code => resolve(code));
});
if (built !== 0) process.exit(built ?? 1);

const program = join(root, 'backends/go/dist', process.platform === 'win32' ? 'polaris.exe' : 'polaris');
const server = spawn(program, process.argv.slice(2), {
  cwd: join(root, 'backends/go'), stdio: 'inherit', windowsHide: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.kill(signal));
server.once('error', error => { console.error(error.message); process.exitCode = 1; });
server.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
