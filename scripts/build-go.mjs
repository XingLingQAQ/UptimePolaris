import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const tempParent = realpathSync(tmpdir());
const temp = mkdtempSync(join(tempParent, 'polaris-go-build-'));
const frontend = join(temp, 'frontend');
const webParent = join(root, 'backends/go/internal/polaris');
const web = join(webParent, 'web');
const tempIdentity = lstatSync(temp);
const npm = process.env.npm_execpath
  ? [process.execPath, [process.env.npm_execpath]]
  : [process.platform === 'win32' ? 'npm.cmd' : 'npm', []];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}
function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function assertDirectory(parent, target, expectedName) {
  if (basename(target) !== expectedName || !samePath(dirname(target), parent)) {
    throw new Error('Unexpected cleanup path');
  }
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory() || !samePath(realpathSync(target), target)) {
    throw new Error(`Unsafe cleanup directory: ${target}`);
  }
}
function removeTree(parent, target, expectedName, identity) {
  if (!samePath(realpathSync(parent), parent)) throw new Error(`Unsafe cleanup parent: ${parent}`);
  assertDirectory(parent, target, expectedName);
  if (identity) {
    const current = lstatSync(target);
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error(`Cleanup directory replaced: ${target}`);
  }
  function removeEntry(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      if (!identity || !samePath(path, join(frontend, 'node_modules'))) throw new Error(`Unexpected cleanup link: ${path}`);
      if (process.platform === 'win32') rmdirSync(path);
      else unlinkSync(path);
      return;
    }
    if (info.isDirectory()) {
      const actual = realpathSync(path);
      const rel = relative(target, actual);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !samePath(actual, path)) {
        throw new Error(`Unsafe cleanup entry: ${path}`);
      }
      for (const entry of readdirSync(path)) removeEntry(join(path, entry));
      rmdirSync(path);
      return;
    }
    rmSync(path);
  }
  removeEntry(target);
}
try {
  cpSync(join(root, 'frontend'), frontend, { recursive: true, filter: (source) => {
    const rel = source.slice(join(root, 'frontend').length).replaceAll('\\', '/');
    return !rel.startsWith('/node_modules') && !rel.startsWith('/.vite') && !rel.endsWith('.tsbuildinfo');
  } });
  cpSync(join(root, 'shared'), join(temp, 'shared'), { recursive: true });
  const dependencies = join(root, 'frontend/node_modules');
  if (!existsSync(dependencies)) throw new Error('Install frontend dependencies before building Go');
  // 临时构建复用依赖目录；清理时只移除链接，不能递归进入原依赖目录。
  // Reuse dependencies through a link; cleanup must remove the link without traversing the original directory.
  symlinkSync(dependencies, join(frontend, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  run(npm[0], [...npm[1], '--prefix', frontend, 'run', 'build'], { cwd: frontend, shell: process.platform === 'win32' && !process.env.npm_execpath });
  let webExists = true;
  try { lstatSync(web); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    webExists = false;
  }
  if (webExists) removeTree(webParent, web, 'web');
  else if (!samePath(realpathSync(webParent), webParent)) throw new Error(`Unsafe asset directory: ${webParent}`);
  const generatedPublic = join(temp, 'public');
  cpSync(generatedPublic, web, { recursive: true, filter: (source) => {
    const rel = relative(generatedPublic, source);
    return rel !== 'agent' && !rel.startsWith(`agent${sep}`);
  } });
  if (!process.argv.includes('--assets-only')) {
    mkdirSync(join(root, 'backends/go/dist'), { recursive: true });
    const targetOs = process.env.GOOS || (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : process.platform);
    const output = join(root, 'backends/go/dist', targetOs === 'windows' ? 'polaris.exe' : 'polaris');
    run('go', ['-C', 'backends/go', 'build', '-tags', 'release', '-trimpath', '-o', output, './cmd/polaris']);
    console.log(`Built ${output}`);
  }
} finally {
  removeTree(tempParent, temp, basename(temp), tempIdentity);
}
