'use strict';

/**
 * 打包入口。
 *
 * 做三件事，保证本地和 CI 行为一致：
 *  1. 直接调用 **本地安装** 的 electron-builder —— 用 npx 时会因为解析不到而临时
 *     安装最新版（26.x），导致行为漂移（26.x 在 CI 环境会自动尝试发布）。
 *  2. 默认带 `--publish never`，禁止 electron-builder 在 CI 里自动发布。
 *  3. 自动带上国内可用的构件镜像，避免 electron / nsis 从 GitHub 下载失败。
 *
 *   node scripts/pack.js            生成 NSIS 安装包
 *   node scripts/pack.js --dir      只生成免安装目录
 *
 * 环境变量覆盖（CI 里用来避开中文路径）：
 *   DAFENGSHU_OUTPUT_DIR      输出目录，默认 dist
 *   DAFENGSHU_ARTIFACT_NAME   安装包文件名模板，默认沿用 package.json 的 nsis.artifactName
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');

/** 优先使用本地安装的 electron-builder，避免 npx 临时装另一个版本 */
function resolveElectronBuilder() {
  const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (fs.existsSync(cli)) return { command: process.execPath, prefix: [cli] };
  // 没装就退回 npx（会临时下载，并给出提示）
  console.warn('[打包] 未找到本地 electron-builder，将使用 npx 临时安装（版本可能与本地不一致）');
  return { command: 'npx', prefix: ['electron-builder'] };
}

const passthrough = process.argv.slice(2);
const hasPublishFlag = passthrough.some((a) => a.startsWith('--publish'));
const args = ['--win', '--x64', ...passthrough];
// CI 里 electron-builder 会自动发布，这里显式关掉（发布由 workflow 的 gh release 负责）
if (!hasPublishFlag) args.push('--publish', 'never');

// CI 上把输出目录/文件名换成 ASCII，避免中文路径导致构建或上传失败
const outputDir = process.env.DAFENGSHU_OUTPUT_DIR;
const artifactName = process.env.DAFENGSHU_ARTIFACT_NAME;
if (outputDir) args.push(`--config.directories.output=${outputDir}`);
if (artifactName) args.push(`--config.nsis.artifactName=${artifactName}`);

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

const { command, prefix } = resolveElectronBuilder();
const fullArgs = [...prefix, ...args];

console.log('[打包] 配置:');
console.log(`  执行 = ${path.basename(command)} ${prefix.join(' ')}`);
console.log(`  参数 = ${args.join(' ')}`);
console.log(`  输出目录 = ${outputDir || 'dist（package.json defaults）'}`);
console.log(`  安装包名 = ${artifactName || 'package.json build.nsis.artifactName'}`);
console.log(`  ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`);
console.log(`  ELECTRON_BUILDER_BINARIES_MIRROR=${env.ELECTRON_BUILDER_BINARIES_MIRROR}`);

const result = spawnSync(command, fullArgs, {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32' && command === 'npx',
});

process.exit(result.status === null ? 1 : result.status);
