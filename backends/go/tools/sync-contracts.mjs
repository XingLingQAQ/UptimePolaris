import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const target = path.join(root, 'backends/go/internal/polaris');
const languages = ['en-US', 'zh-CN', 'zh-TW', 'zh-HK', 'ja-JP', 'ko-KR', 'fr-FR', 'pt-BR', 'ru-RU'];
const check = process.argv.includes('--check');
let stale = false;
async function output(name, contents) {
  const destination = path.join(target, name);
  if (!check) return fs.writeFile(destination, contents);
  const current = await fs.readFile(destination, 'utf8').catch(() => null);
  // Git 的 Windows 换行转换不改变生成契约的内容。
  // Git's Windows line-ending conversion does not change the generated contract.
  if (current?.replaceAll('\r\n', '\n') !== contents.replaceAll('\r\n', '\n')) {
    console.error(`stale generated contract: ${name}`);
    stale = true;
  }
}
await output('agent-release-repository.json', await fs.readFile(path.join(root, 'shared/agent-release-repository.json'), 'utf8'));
const sourceLanguages = (await fs.readdir(path.join(root, 'frontend/src/locales/admin')))
  .filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort();
if (JSON.stringify(sourceLanguages) !== JSON.stringify([...languages].sort())) {
  throw new Error('notification language list differs from frontend sources');
}
const copy = {};
for (const language of languages) {
  const source = JSON.parse(await fs.readFile(path.join(root, `frontend/src/locales/admin/${language}.json`), 'utf8'));
  copy[language] = source.notify.message;
}
await output('notification-copy.json', JSON.stringify(copy, null, 2) + '\n');

async function compile(source) {
  const built = await transform(source, { loader: 'ts', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(built.code).toString('base64'));
}
const brand = await compile(await fs.readFile(path.join(root, 'shared/brand-mark.ts'), 'utf8'));
await output('brand-mark.json', JSON.stringify({ blue: brand.BRAND_BLUE, path: brand.BRAND_RING_PATH, ring: brand.RING, tightViewBox: brand.TIGHT_VIEWBOX }, null, 2) + '\n');

let installer = await fs.readFile(path.join(root, 'backends/worker/src/lib/agent/install-script.ts'), 'utf8');
installer = installer.replace(/^import .*;\r?\n/gm, '');
installer = `const AGENT_SHORT_COMMAND = 'pa'; const powershellQuote = value => "'" + value.replaceAll("'", "''") + "'";\n` + installer;
const scripts = await compile(installer);
await output('installers/install.sh', scripts.installSh({ base: 'POLARIS_ORIGIN_PLACEHOLDER' }));
await output('installers/install.ps1', scripts.installPs1({ base: 'POLARIS_ORIGIN_PLACEHOLDER' }));

const maintenanceBuild = await build({ entryPoints: [path.join(root, 'backends/worker/src/lib/public/maintenance-page.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral' });
const maintenance = await import('data:text/javascript;base64,' + Buffer.from(maintenanceBuild.outputFiles[0].text).toString('base64'));
await output('maintenance-page.html', maintenance.maintenancePage({ title: 'POLARIS_MAINTENANCE_TITLE', description: 'POLARIS_MAINTENANCE_DESCRIPTION', endsAt: 'POLARIS_MAINTENANCE_END' }, 'auto'));
await output('maintenance.js', maintenance.maintenanceScript);

if (stale) process.exitCode = 1;
