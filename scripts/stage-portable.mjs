#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/**
 * 把一个版本的可便携包放到 C:\Library\tempTools，并把上一个版本的 data 复制进去。
 *
 * 用户要求：每个新版本都有一份独立、带真实数据的便携目录，方便直接双击测试。
 *
 *   npm run stage:portable -- --version 2.2.2
 *   npm run stage:portable -- --version 2.2.2 --from "C:\path\to\data"
 *
 * - 只新建版本目录，默认拒绝覆盖已存在的目录（避免覆盖正在运行的实例）
 * - data 默认取 tempTools 下最近修改的上一个版本的 data
 * - 不启动应用：同 identifier 单实例会抢焦点，先退出旧版本再启动新目录
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = path.resolve(option('root', 'C:\\Library\\tempTools'));
const force = args.includes('--force');
const version = option('version', JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
const fromArg = option('from', null);
const zip = path.resolve('desktop', 'target', 'portable', `cline-pass-plus-${version}-portable.zip`);
const dest = path.join(root, `cline-pass-plus-${version}-portable`);

const fail = (message) => {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
};

if (!fs.existsSync(zip)) {
  fail(`找不到构建产物：${zip}\n  先运行 npm run desktop:build`);
}
if (fs.existsSync(dest) && !force) {
  fail(`目录已存在：${dest}\n  如果它没有在运行，加 --force 覆盖；正在运行的目录不要覆盖。`);
}
if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true, force: true });
}
fs.mkdirSync(root, { recursive: true });

// Windows 自带 PowerShell 解压；脚本的默认 root 也是 Windows 路径
const extract = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${dest.replaceAll("'", "''")}' -Force`,
  ],
  { stdio: 'inherit' },
);
if (extract.status !== 0) {
  fail('解压失败');
}

/** 从 --from 或 tempTools 下最近的版本目录找 data。 */
function resolveData() {
  if (fromArg) {
    const candidate = path.resolve(fromArg);
    if (path.basename(candidate) === 'data') return candidate;
    const nested = path.join(candidate, 'data');
    return fs.existsSync(nested) ? nested : candidate;
  }
  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^cline-pass-plus-.*-portable$/.test(entry.name))
    .map((entry) => path.join(root, entry.name, 'data'))
    .filter((dir) => dir !== path.join(dest, 'data') && fs.existsSync(dir))
    .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.dir ?? null;
}

const dataSource = resolveData();
if (dataSource && fs.existsSync(dataSource)) {
  const target = path.join(dest, 'data');
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(dataSource, target, { recursive: true });
  console.log(`✓ data 已复制：${dataSource}`);
} else {
  console.log('! 没有找到可复制的 data，保持空的数据目录');
}

// 只提示，不动正在运行的实例
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cline-pass-plus.exe'], { encoding: 'utf8' });
if ((running.stdout ?? '').includes('cline-pass-plus.exe')) {
  console.log('! 检测到 cline-pass-plus 正在运行；同 identifier 单实例会抢焦点，请先退出旧版本再启动新目录。');
}

console.log(`\n✓ 已就绪：${dest}`);
console.log('  双击其中的 cline-pass-plus.exe 即可测试。\n');
