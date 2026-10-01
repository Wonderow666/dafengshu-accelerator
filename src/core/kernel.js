'use strict';

/**
 * sing-box 内核的下载与版本管理。
 * 内置多个下载源（含国内可直连的镜像），第一个失败自动换下一个。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { binDir, ensureDir, paths } = require('./paths');

const REPO = 'SagerNet/sing-box';

/** 下载源：按顺序尝试（国内直连镜像优先放在官方源之后） */
const MIRRORS = [
  (tag, file) => `https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://ghproxy.net/https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://gh-proxy.com/https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://ghfast.top/https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://ghproxy.cc/https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://gh.llkk.cc/https://github.com/${REPO}/releases/download/${tag}/${file}`,
  (tag, file) => `https://github.moeyy.xyz/https://github.com/${REPO}/releases/download/${tag}/${file}`,
];

function assetName(version) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  // 注意：release 标签是 v1.11.15，但压缩包名里没有 v
  const clean = String(version).replace(/^v/i, '');
  return `sing-box-${clean}-windows-${arch}.zip`;
}

function binaryPath() {
  return path.join(binDir(), 'sing-box.exe');
}

function installed() {
  const file = binaryPath();
  return fs.existsSync(file) ? file : null;
}

async function getVersion(binary = installed()) {
  if (!binary) return null;
  return new Promise((resolve) => {
    execFile(binary, ['version'], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const match = String(stdout).match(/version\s+([0-9][^\s]*)/i);
      resolve(match ? match[1] : String(stdout).trim().split('\n')[0]);
    });
  });
}

async function fetchLatestTag() {
  // 先用 releases/latest 的 302 跳转拿 tag（不消耗 API 配额，也不会被限流）
  try {
    const response = await fetch(`https://github.com/${REPO}/releases/latest`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'dafengshu-accelerator' },
    });
    const location = response.headers.get('location') || '';
    const tag = location.split('/tag/')[1];
    if (tag) return decodeURIComponent(tag);
  } catch {
    /* 继续尝试 API */
  }
  // 再试 GitHub API（可能被限流）
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'dafengshu-accelerator' },
    });
    if (response.ok) {
      const json = await response.json();
      if (json.tag_name) return json.tag_name;
    }
  } catch {
    /* 交给调用方回退到已知版本 */
  }
  return null;
}

/**
 * 候选版本列表：查不到「最新版本」时按顺序尝试。
 * 这些是 sing-box 1.x 的稳定标签，只要其中一个能下下来即可用。
 */
const FALLBACK_VERSIONS = ['v1.11.15', 'v1.11.14', 'v1.11.13', 'v1.10.7'];

async function downloadTo(url, target, onProgress) {
  const response = await fetch(url, { headers: { 'User-Agent': 'dafengshu-accelerator' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (onProgress) onProgress({ received, total });
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 1024 * 512) throw new Error('下载内容异常（文件过小，可能是镜像返回了错误页）');
  fs.writeFileSync(target, buffer);
  return buffer.length;
}

/** 用 PowerShell 解压（Windows 自带 Expand-Archive，避免引入解压依赖） */
function unzip(zipFile, destDir) {
  return new Promise((resolve, reject) => {
    const script = `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`解压失败: ${stderr || error.message}`));
        else resolve(String(stdout || ''));
      }
    );
  });
}

/**
 * 安装/更新内核
 * @param {{version?: string, force?: boolean, onProgress?: Function, log?: object}} options
 */
async function install(options = {}) {
  const log = options.log || { info() {}, warn() {} };
  const dir = ensureDir(binDir());
  const target = binaryPath();

  if (installed() && !options.force) {
    const version = await getVersion(target);
    return { ok: true, alreadyInstalled: true, path: target, version };
  }

  const latest = options.version || (await fetchLatestTag());
  const candidates = Array.from(new Set([options.version, latest, ...FALLBACK_VERSIONS].filter(Boolean)));

  const tempDir = ensureDir(path.join(paths().cache, 'kernel-download'));
  const errors = [];

  for (const version of candidates) {
    const file = assetName(version);
    const zipFile = path.join(tempDir, file);
    for (const build of MIRRORS) {
      const url = build(version, file);
      try {
        log.info(`正在下载内核 ${version}: ${new URL(url).host}`);
        const size = await downloadTo(url, zipFile, options.onProgress);
        log.info(`下载完成 ${(size / 1024 / 1024).toFixed(1)} MB`);
        await unzip(zipFile, tempDir);
        // 压缩包里通常是 sing-box-<version>-windows-amd64/sing-box.exe
        const inner = fs
          .readdirSync(tempDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('sing-box-'))
          .map((entry) => path.join(tempDir, entry.name, 'sing-box.exe'))
          .find((candidate) => fs.existsSync(candidate));

        if (!inner) throw new Error('压缩包里没找到 sing-box.exe');
        fs.copyFileSync(inner, target);
        try {
          fs.rmSync(zipFile, { force: true });
          fs.rmSync(path.dirname(inner), { recursive: true, force: true });
        } catch {
          /* 清理失败无所谓 */
        }
        const verified = await getVersion(target);
        if (!verified) throw new Error('内核文件无法执行，可能被杀毒软件拦截');
        log.info(`内核安装完成: ${verified} → ${target}`);
        return { ok: true, path: target, version: verified, source: url };
      } catch (error) {
        const message = `[${version}] ${new URL(url).host}: ${error.message}`;
        errors.push(message);
        log.warn(`下载失败 ${message}`);
      }
    }
  }

  return {
    ok: false,
    error:
      `所有下载源都失败了（共尝试 ${errors.length} 次）。最后一个错误：${errors[errors.length - 1] || '未知'}\n` +
      `可手动下载 sing-box 的 windows-amd64 版本，解压后把 sing-box.exe 放到：${dir}`,
    targetDir: dir,
    attempts: errors,
  };
}

module.exports = {
  MIRRORS,
  FALLBACK_VERSIONS,
  binaryPath,
  installed,
  getVersion,
  fetchLatestTag,
  install,
  assetName,
};
