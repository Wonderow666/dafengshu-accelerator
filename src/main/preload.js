'use strict';

/** 预加载脚本：只暴露白名单 API，渲染层拿不到 Node 能力 */

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('dfsj', {
  // 状态
  getState: () => invoke('state'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, data) => cb(data)),
  onLog: (cb) => ipcRenderer.on('log', (_e, data) => cb(data)),
  onDelay: (cb) => ipcRenderer.on('delay', (_e, data) => cb(data)),
  onDelays: (cb) => ipcRenderer.on('delays', (_e, data) => cb(data)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, data) => cb(data)),
  onNodes: (cb) => ipcRenderer.on('nodes', (_e, data) => cb(data)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, data) => cb(data)),

  // 加速开关
  start: () => invoke('start'),
  stop: () => invoke('stop'),
  toggle: (force) => invoke('toggle', force),

  // 节点
  importNodes: (text) => invoke('nodes:import', text),
  removeNode: (id) => invoke('nodes:remove', id),
  selectNode: (id) => invoke('nodes:select', id),
  testNode: (id) => invoke('nodes:test', id),
  testAllNodes: () => invoke('nodes:testAll'),

  // 订阅
  addSubscription: (url) => invoke('sub:add', url),
  refreshSubscriptions: () => invoke('sub:refresh'),
  removeSubscription: (url) => invoke('sub:remove', url),

  // 设置
  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),

  // 诊断
  getLogs: (lines) => invoke('logs:get', lines),
  clearLogs: () => invoke('logs:clear'),
  previewConfig: () => invoke('config:preview'),
  configPath: () => invoke('config:path'),
  checkTwitter: () => invoke('twitter:check'),
  systemProxyStatus: () => invoke('system:proxyStatus'),
  openPath: (target) => invoke('system:openPath', target),
  openExternal: (url) => invoke('system:openExternal', url),
  systemInfo: () => invoke('system:info'),
  addFirewallRule: () => invoke('system:addFirewallRule'),
  lanInfo: () => invoke('system:lanInfo'),
  installKernel: (options) => invoke('kernel:install', options),
  minimize: () => invoke('window:minimize'),
  closeWindow: () => invoke('window:close'),
});
