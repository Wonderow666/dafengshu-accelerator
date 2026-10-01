'use strict';

/**
 * 离线/兜底下载脚本：用系统自带的 curl.exe 拉取 sing-box 内核。
 *
 * 为什么不用 Node 的 fetch：部分网络环境下 Node fetch 走 GitHub 的 302
 * 跳转到 release-assets.githubusercontent.com 会失败，而 curl 正常。
 * 所以 App 内部用 fetch（多数环境可用），这个脚本作为兜底手段。
 *
 *   npm run fetch:core            自动选一个可用版本
 *   node scripts/fetch-singbox.js v1.11.15
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { binDir, ensureDir, paths } = require('../src/core/paths');
const { FALLBACK_VERSIONS, assetName, binaryPath, getVersion } = require('../src/core/kernel');

const REPO = 'SagerNet/sing-box';
const MIRRORS = [
  (tag, file) => `https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://ghproxy.net/https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://gh-proxy.com/https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://ghfast.top/https://github.com/${REPO}/releases/download/${tag}/${file}`,
];

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout || 600000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(file)} 失败: ${stderr || error.message}`));
      else resolve(String(stdout || ''));
    });
  });
}

async function downloadWithCurl(url, target) {
  await run('curl.exe', ['-sL', '--fail', '--retry', '2', '--connect-timeout', '20', '-o', target, url]);
  const size = fs.statSync(target).size;
  if (size < 1024 * 512) throw new Error(`下载文件过小（${size} 字节），可能是错误页面`);
  return size;
}

async function unzip(zipFile, destDir) {
  const script = `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: 180000,
  });
}

async function main() {
  const requested = process.argv[2];
  const candidates = requested ? [requested] : FALLBACK_VERSIONS;
  const target = binaryPath();
  ensureDir(binDir());
  const tempDir = ensureDir(path.join(paths().cache, 'kernel-download'));

  console.log(`目标: ${target}`);

  const errors = [];
  for (const version of candidates) {
    const file = assetName(version);
    const zipFile = path.join(tempDir, file);
    for (const build of MIRRORS) {
      const url = build(version, file);
      try {
        console.log(`→ 尝试 ${version} @ ${new URL(url).host}`);
        const size = await downloadWithCurl(url, zipFile);
        console.log(`  下载完成 ${(size / 1024 / 1024).toFixed(1)} MB，正在解压…`);
        await unzip(zipFile, tempDir);

        const inner = fs
          .readdirSync(tempDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('sing-box-'))
          .map((entry) => path.join(tempDir, entry.name, 'sing-box.exe'))
          .find((candidate) => fs.existsSync(candidate));
        if (!inner) throw new Error('压缩包里没有 sing-box.exe');

        fs.copyFileSync(inner, target);
        fs.rmSync(zipFile, { force: true });
        fs.rmSync(path.dirname(inner), { recursive: true, force: true });

        const verified = await getVersion(target);
        if (!verified) throw new Error('内核无法执行（可能被杀毒软件拦截）');
        console.log(`\n✅ 内核就绪: ${verified}\n   ${target}`);
        return;
      } catch (error) {
        const message = `[${version}] ${new URL(url).host}: ${error.message}`;
        errors.push(message);
        console.log(`  ✗ ${message}`);
      }
    }
  }

  console.error(`\n❌ 全部失败（${errors.length} 次尝试）`);
  console.error('请手动下载 sing-box 的 windows-amd64 压缩包，解压后把 sing-box.exe 放到：');
  console.error(`  ${binDir()}`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { downloadWithCurl };
