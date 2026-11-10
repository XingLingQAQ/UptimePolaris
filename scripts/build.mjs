import { spawnSync } from 'node:child_process';

const npm = process.env.npm_execpath
  ? [process.execPath, [process.env.npm_execpath]]
  : [process.platform === 'win32' ? 'npm.cmd' : 'npm', []];
const commands = [
  ...(process.env.WORKERS_CI === '1' ? [['--prefix', 'frontend', 'ci']] : []),
  ['run', 'schema:build'],
  ['run', 'frontend:build', ...process.argv.slice(2)],
];

for (const args of commands) {
  let env = process.env;
  if (args[0] === '--prefix' && args[1] === 'frontend' && args[2] === 'ci') {
    env = { ...env };
    // npm 12 会将用户配置转成环境变量，嵌套安装会拒绝该变量。
    // npm 12 forwards user config as an environment variable, which nested installs reject.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  }
  const result = spawnSync(npm[0], [...npm[1], ...args], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    env,
    windowsHide: true,
    shell: process.platform === 'win32' && !process.env.npm_execpath,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
