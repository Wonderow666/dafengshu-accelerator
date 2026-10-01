'use strict';

/**
 * 打包入口：自动带上国内可用的构件镜像，避免 electron / nsis 从 GitHub 下载失败。
 *
 *   node scripts/pack.js            生成 NSIS 安装包
 *   node scripts/pack.js --dir      只生成免安装目录
 *
 * 环境变量覆盖（CI 里用来避开中文路径）：
 *   DAFENGSHU_OUTPUT_DIR      输出目录，默认 dist
 *   DAFENGSHU_ARTIFACT_NAME   安装包文件名模板，默认沿用 package.json 的 nsis.artifactName
 *
 * 这样无论用 npm run pack 还是直接 node scripts/pack.js，行为一致且不需要
 * 用户自己去记 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = ['electron-builder', '--win', '--x64', ...process.argv.slice(2)];

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

console.log('[打包] 配置:');
console.log(`  输出目录 = ${outputDir || 'dist（package.json defaults）'}`);
console.log(`  安装包名 = ${artifactName || 'package.json build.nsis.artifactName'}`);
console.log(`  ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`);
console.log(`  ELECTRON_BUILDER_BINARIES_MIRROR=${env.ELECTRON_BUILDER_BINARIES_MIRROR}`);

const result = spawnSync('npx', args, {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status === null ? 1 : result.status);
