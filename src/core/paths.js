'use strict';

/**
 * 统一的路径解析。核心库在 Electron 之外也能独立运行（CLI / 测试），
 * 所以这里不硬依赖 electron：只有确实运行在 Electron 里时才用 app 的路径。
 *
 * 打包后的布局：
 *   <安装目录>/大枫树加速.exe
 *   <安装目录>/resources/app.asar        ← 本文件在这里面
 *   <安装目录>/resources/bin/sing-box.exe   ← extraResources 放进来
 *   <安装目录>/resources/ruleset/*.srs      ← 随包内置的国内分流规则集
 * 用户数据（设置/节点/日志）则放到 %APPDATA%/大枫树加速。
 */

const path = require('path');
const fs = require('fs');

/** 开发时的仓库根目录；打包后这个路径不存在或指向 asar 内部，仅作兜底 */
const ROOT = path.resolve(__dirname, '..', '..');

/** 是否运行在打包后的 Electron 里 */
function isPackaged() {
  try {
    const { app } = require('electron');
    return Boolean(app && app.isPackaged);
  } catch {
    return false;
  }
}

/** 开发时的仓库根；打包后为 null */
function devRoot() {
  return isPackaged() ? null : ROOT;
}

function homeDir() {
  if (process.env.DAFENGSHU_HOME) return path.resolve(process.env.DAFENGSHU_HOME);
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return app.getPath('userData');
  } catch {
    /* 非 Electron 环境 */
  }
  return path.join(ROOT, 'data');
}

function resourcesDir() {
  if (process.env.DAFENGSHU_RESOURCES) return path.resolve(process.env.DAFENGSHU_RESOURCES);
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return process.resourcesPath;
  } catch {
    /* 非 Electron 环境 */
  }
  return path.join(ROOT, 'resources');
}

/** sing-box 内核目录（开发：仓库 resources/bin；打包：resources/bin） */
function binDir() {
  return path.join(resourcesDir(), 'bin');
}

/** 随包/随仓库内置的国内分流规则集目录（只读，不写入） */
function builtinRuleSetsDir() {
  return path.join(resourcesDir(), 'ruleset');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function paths() {
  const home = ensureDir(homeDir());
  const run = ensureDir(path.join(home, 'run'));
  const logs = ensureDir(path.join(home, 'logs'));
  const cache = ensureDir(path.join(home, 'cache'));
  return {
    root: devRoot() || home,
    home,
    run,
    logs,
    cache,
    configFile: path.join(run, 'sing-box.json'),
    logFile: path.join(logs, 'sing-box.log'),
    appLogFile: path.join(logs, 'app.log'),
    settingsFile: path.join(home, 'settings.json'),
    nodesFile: path.join(home, 'nodes.json'),
    backupDir: ensureDir(path.join(home, 'backup')),
  };
}

module.exports = { ROOT, isPackaged, homeDir, resourcesDir, binDir, builtinRuleSetsDir, ensureDir, paths };
