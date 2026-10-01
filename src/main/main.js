'use strict';

/**
 * Electron 主进程：窗口 + 托盘 + IPC。
 * 所有业务逻辑都在 src/core/App 里，这里只做界面与系统集成。
 */

const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const { App } = require('../core/app');
const { isAdmin } = require('../core/process');
const { resourcesDir } = require('../core/paths');

const ROOT = path.resolve(__dirname, '..', '..');
const isDev = !app.isPackaged;

let mainWindow = null;
let tray = null;
let core = null;
let quitting = false;

/**
 * 界面资源随 asar 打包（用 ROOT 定位），
 * 图标与内核走 extraResources（用 resourcesDir() 定位，打包后是 resources/）。
 */
function iconPath(size = 32) {
  return path.join(resourcesDir(), 'icons', `icon-${size}.png`);
}

function loadIcon(size) {
  try {
    const image = nativeImage.createFromPath(iconPath(size));
    if (!image.isEmpty()) return image;
    console.warn(`[大枫树加速] 图标加载失败: ${iconPath(size)}`);
    return undefined;
  } catch (error) {
    console.warn(`[大枫树加速] 图标加载异常: ${error.message}`);
    return undefined;
  }
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#12161c',
    title: '大枫树加速',
    icon: loadIcon(256),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  // 界面加载失败要能看见（否则只是白屏，没有任何线索）
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[大枫树加速] 界面已加载');
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[大枫树加速] 界面加载失败 ${code} ${description}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[大枫树加速] 渲染进程异常:', details);
  });

  // 关闭窗口 = 收进托盘（加速仍在运行）
  mainWindow.on('close', (event) => {
    if (!quitting && core && core.status.running) {
      event.preventDefault();
      mainWindow.hide();
      notify('大枫树加速仍在后台运行', '加速未停止，可从托盘图标重新打开窗口。');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (isDev && process.env.DAFENGSHU_DEVTOOLS) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function notify(title, body) {
  try {
    if (tray) tray.displayBalloon({ title, content: body, iconType: 'info' });
  } catch {
    /* 托盘气泡在部分系统上不可用，忽略 */
  }
}

function trayTooltip() {
  if (!core) return '大枫树加速';
  const status = core.status;
  if (status.starting) return '大枫树加速 · 正在启动…';
  if (!status.running) return '大枫树加速 · 已停止';
  const name = status.meta ? status.meta.selectedNode.name : '';
  return `大枫树加速 · 已连接\n节点: ${name}`;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const running = Boolean(core && core.status.running);
  const nodes = core ? core.store.state.nodes.slice(0, 12) : [];
  const selectedId = core ? core.store.state.selectedNodeId : '';

  const template = [
    {
      label: running ? '● 正在加速（点击停止）' : '○ 未加速（点击启动）',
      click: async () => {
        try {
          await core.toggle();
        } catch (error) {
          dialog.showErrorBox('操作失败', error.message);
        }
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '选择节点',
      enabled: nodes.length > 0,
      submenu: nodes.map((node) => ({
        label: `${node.id === selectedId ? '✓ ' : '   '}${node.name}`,
        type: 'radio',
        checked: node.id === selectedId,
        click: async () => {
          await core.selectNode(node.id);
          rebuildTrayMenu();
          broadcast('state', core.snapshot());
        },
      })),
    },
    {
      label: '打开主界面',
      click: () => {
        if (!mainWindow) createWindow();
        else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: async () => {
        quitting = true;
        await shutdown();
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(trayTooltip());
}

function createTray() {
  const image = loadIcon(32) || loadIcon(16);
  tray = new Tray(image || nativeImage.createEmpty());
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    } else {
      createWindow();
    }
  });
  rebuildTrayMenu();
}

async function shutdown() {
  try {
    if (core) await core.dispose();
  } catch (error) {
    console.error('停止加速失败:', error);
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────
function registerIpc() {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    });
  };

  handle('state', () => core.snapshot());
  handle('start', async () => {
    const result = await core.start();
    rebuildTrayMenu();
    return result;
  });
  handle('stop', async () => {
    const result = await core.stop();
    rebuildTrayMenu();
    return result;
  });
  handle('toggle', async (force) => {
    const result = await core.toggle(force);
    rebuildTrayMenu();
    return result;
  });

  handle('nodes:import', (text) => {
    const result = core.importFromText(text);
    rebuildTrayMenu();
    return result;
  });
  handle('nodes:remove', (id) => {
    const nodes = core.removeNode(id);
    rebuildTrayMenu();
    return nodes;
  });
  handle('nodes:select', async (id) => {
    const result = await core.selectNode(id);
    rebuildTrayMenu();
    return result;
  });
  handle('nodes:test', (id) => core.testNode(id));
  handle('nodes:testAll', () => core.testAllNodes());

  handle('sub:add', (url) => core.refreshSubscription(url));
  handle('sub:refresh', () => core.refreshAllSubscriptions());
  handle('sub:remove', (url) => core.removeSubscription(url));

  handle('settings:get', () => core.store.state.settings);
  handle('settings:update', async (patch) => {
    const settings = await core.updateSettings(patch);
    rebuildTrayMenu();
    return settings;
  });

  handle('logs:get', (lines) => core.getLogs(lines));
  handle('logs:clear', () => core.clearLogs());
  handle('config:preview', async () => {
    const { config, meta } = await core.buildConfigOnly();
    return { config, meta };
  });
  handle('config:path', () => core.p.configFile);
  handle('twitter:check', () => core.checkTwitter());
  handle('system:proxyStatus', () => core.systemProxyStatus());
  handle('system:addFirewallRule', () => core.addFirewallRule());
  handle('system:lanInfo', () => core.lanInfo());
  handle('system:openPath', (target) => shell.openPath(target));
  handle('system:openExternal', (url) => shell.openExternal(url));
  handle('system:info', () => ({ isAdmin: isAdmin(), version: app.getVersion(), dataDir: core.p.home }));
  handle('kernel:install', (options) => core.ensureKernel({ ...options, force: true }));
  handle('window:minimize', () => mainWindow && mainWindow.minimize());
  handle('window:close', () => mainWindow && mainWindow.close());
}

// ── 生命周期 ──────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    core = new App();

    core.on('status', (status) => {
      broadcast('status', status);
      rebuildTrayMenu();
    });
    core.on('log', (line) => broadcast('log', line));
    core.on('delay', (entry) => broadcast('delay', entry));
    core.on('delays', (list) => broadcast('delays', list));
    core.on('progress', (progress) => broadcast('progress', progress));
    core.on('nodes', (nodes) => {
      broadcast('nodes', nodes);
      rebuildTrayMenu();
    });
    core.on('settings', (settings) => broadcast('settings', settings));

    createWindow();
    createTray();
    registerIpc();

    // 启动后异步读取内核版本，让界面与托盘都能显示
    core
      .loadKernelVersion()
      .then(() => broadcast('status', core.status))
      .catch(() => {});

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', async (event) => {
    if (core && core.status.running && !quitting) {
      event.preventDefault();
      quitting = true;
      const choice = dialog.showMessageBoxSync({
        type: 'question',
        buttons: ['停止加速并退出', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: '退出大枫树加速',
        message: '加速正在运行，退出会断开代理并还原系统设置。',
      });
      if (choice === 0) {
        await shutdown();
        app.quit();
      } else {
        quitting = false;
      }
    }
  });

  app.on('will-quit', () => {
    if (core) core.proxy.restore().catch(() => {});
  });

  app.on('window-all-closed', () => {
    // 保持托盘常驻，不随窗口关闭退出
  });
}
