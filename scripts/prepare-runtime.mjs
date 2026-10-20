/**
 * 准备桌面壳要打包的服务端运行时：
 *   desktop/runtime/
 *     package.json          { type: "module" }（ESM 判定）
 *     node_modules/         仅 pino + zod 及其传递依赖（--omit=dev）
 *     server/dist/          编译产物
 *     server/package.json   { type: "module" }
 *
 * Node 的模块解析会从 server/dist/index.js 逐级向上找 node_modules，
 * 因此 runtime/node_modules 必须位于 runtime 根（与 resources 打包层级一致）。
 *
 * Linux / Windows 安装包额外内置 Node 运行时（`--with-node`）：
 * Ubuntu 22.04 / 24.04 仓库的 Node 分别是 12 / 18，Windows 机器则未必装了 Node；
 * 与其要求用户自己解决，不如把官方二进制随包带上（压缩后约 30 MB）。
 */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(root, 'desktop', 'runtime');
const serverPkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(path.join(runtimeDir, 'server'), { recursive: true });

// 1) 编译产物（服务端 + 前端：服务端静态托管 WEB_DIST = runtime/web/dist，缺了就是
//    「front-end assets not found」白屏 JSON——桌面壳首发的真实缺陷）
fs.cpSync(path.join(root, 'server/dist'), path.join(runtimeDir, 'server/dist'), { recursive: true });
fs.cpSync(path.join(root, 'web/dist'), path.join(runtimeDir, 'web/dist'), { recursive: true });

// 2) 模块类型标记 + 版本号（服务端 PACKAGE_VERSION 读 REPO_ROOT/package.json，
//    运行时布局下即 runtime/package.json——这里必须带上 version，否则 /healthz 显示 0.0.0）
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(runtimeDir, 'package.json'),
  JSON.stringify({ name: 'cline-pass-runtime', private: true, type: 'module', version: rootPkg.version }, null, 2),
);
fs.writeFileSync(
  path.join(runtimeDir, 'server/package.json'),
  JSON.stringify({ name: 'cline-pass-server-runtime', private: true, type: 'module' }, null, 2),
);

// 3) 干净的生产依赖（只装 server 的 dependencies，杜绝把仓库根的开发依赖打进安装包）
fs.writeFileSync(
  path.join(runtimeDir, 'server/package.json'),
  JSON.stringify(
    { name: 'cline-pass-server-runtime', private: true, type: 'module', dependencies: serverPkg.dependencies },
    null,
    2,
  ),
);
execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
  cwd: path.join(runtimeDir, 'server'),
  stdio: 'inherit',
});
// 依赖装在 runtime/server/node_modules，同样满足向上解析；保持现状即可

// ---------- 可选的平台内置 Node ----------

/** 与 Dockerfile 的 node:22 对齐；升级时同步 Dockerfile、CI 与安装包。 */
const NODE_VERSION = process.env.CPS_NODE_VERSION || '22.23.3';
const WITH_NODE = process.argv.includes('--with-node');
/** 与 desktop/src/platform/mod.rs 的 bundled_node_path 保持一致。 */
const NODE_BIN_NAME = process.platform === 'win32' ? 'node.exe' : 'node';

async function fetchBuffer(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 ${label} 失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function expectedSha(sums, file) {
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`));
  const hash = line?.trim().split(/\s+/)[0];
  if (!hash) throw new Error(`SHASUMS256.txt 中找不到 ${file}`);
  return hash;
}

function verifySha(buf, expected, file) {
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) throw new Error(`${file} 校验失败：期望 ${expected}，实际 ${actual}`);
}

function copyNodeBinary(from) {
  const dest = path.join(runtimeDir, NODE_BIN_NAME);
  fs.copyFileSync(from, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

/**
 * Windows：官方在 dist 下提供独立的 `win-<arch>/node.exe`（与 zip 内文件相同），
 * SHASUMS256.txt 逐文件列出它，直接下载可省去解压步骤。
 */
async function prepareWindowsNode(base, arch) {
  const rel = `win-${arch}/node.exe`;
  const sums = (await fetchBuffer(`${base}/SHASUMS256.txt`, 'SHASUMS256.txt')).toString('utf8');
  const expected = expectedSha(sums, rel);

  console.log(`[runtime] 下载 ${base}/${rel}（约 83 MB）`);
  const buf = await fetchBuffer(`${base}/${rel}`, rel);
  verifySha(buf, expected, rel);
  fs.writeFileSync(path.join(runtimeDir, NODE_BIN_NAME), buf);

  // 独立 node.exe 不带 LICENSE：从对应 tag 的源码树取同一份许可文本。
  const license = await fetchBuffer(
    `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`,
    'Node LICENSE',
  );
  fs.writeFileSync(path.join(runtimeDir, 'LICENSE.node'), license);
}

async function prepareLinuxNode(base, arch) {
  const name = `node-v${NODE_VERSION}-linux-${arch}`;
  const archive = `${name}.tar.xz`;
  const sums = (await fetchBuffer(`${base}/SHASUMS256.txt`, 'SHASUMS256.txt')).toString('utf8');
  const expected = expectedSha(sums, archive);

  console.log(`[runtime] 下载 ${base}/${archive}`);
  const buf = await fetchBuffer(`${base}/${archive}`, archive);
  verifySha(buf, expected, archive);

  // tar -xJ 依赖系统 xz（Ubuntu runner 自带；CI 显式安装 xz-utils）。
  const tmp = path.join(runtimeDir, '.node-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, archive), buf);
  execFileSync('tar', ['-xJf', path.join(tmp, archive), '-C', tmp, '--strip-components=1'], {
    stdio: 'inherit',
  });
  copyNodeBinary(path.join(tmp, 'bin/node'));
  const license = path.join(tmp, 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(runtimeDir, 'LICENSE.node'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function prepareBundledNode() {
  if (!WITH_NODE) return;
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    console.log('[runtime] --with-node 目前支持 Linux 与 Windows；当前平台跳过（继续使用系统 Node）');
    return;
  }
  if (process.env.CPS_NODE_BIN) {
    const from = process.env.CPS_NODE_BIN;
    if (!fs.existsSync(from)) throw new Error(`CPS_NODE_BIN 不存在：${from}`);
    console.log(`[runtime] 使用 CPS_NODE_BIN：${from}`);
    copyNodeBinary(from);
  } else {
    const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
    if (!arch) throw new Error(`不支持的内置 Node 架构：${process.arch}`);
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    if (process.platform === 'win32') await prepareWindowsNode(base, arch);
    else await prepareLinuxNode(base, arch);
  }

  const dest = path.join(runtimeDir, NODE_BIN_NAME);
  const version = execFileSync(dest, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`[runtime] 已内置 ${version}（${dest}）`);
}

await prepareBundledNode();

const size = (dir) => {
  let total = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (f.isFile()) total += fs.statSync(path.join(f.parentPath ?? dir, f.name)).size;
  }
  return total;
};
console.log(`运行时准备完成：${runtimeDir}（约 ${Math.round(size(runtimeDir) / 1024 / 1024)} MB）`);
