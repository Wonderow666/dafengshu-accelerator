'use strict';

/**
 * 打包入口：自动带上国内可用的构件镜像，避免 electron / nsis 从 GitHub 下载失败。
 *
 *   node scripts/pack.js            生成 NSIS 安装包
 *   node scripts/pack.js --dir      只生成免安装目录
 *
 * 这样无论用 npm run pack 还是直接 node scripts/pack.js，行为一致且不需要
 * 用户自己去记 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = ['electron-builder', '--win', '--x64', ...process.argv.slice(2)];

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

console.log('[打包] 使用构件镜像:');
console.log(`  ELECTRON_MIRROR=${env.ELECTRON_MIRROR}`);
console.log(`  ELECTRON_BUILDER_BINARIES_MIRROR=${env.ELECTRON_BUILDER_BINARIES_MIRROR}`);

const result = spawnSync('npx', args, {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status === null ? 1 : result.status);
