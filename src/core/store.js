'use strict';

/**
 * 本地状态存储：settings.json（设置）与 nodes.json（节点列表）。
 * 写入使用「临时文件 + rename」，避免断电/崩溃把配置写坏。
 */

const fs = require('fs');
const path = require('path');
const { paths } = require('./paths');
const { DEFAULT_SETTINGS, withDefaults } = require('./config');
const { createLogger } = require('./util');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (error) {
    // 读坏了就备份一份原始文件，避免用户数据静默丢失
    try {
      const broken = `${file}.broken-${Date.now()}`;
      fs.copyFileSync(file, broken);
    } catch {
      /* 忽略 */
    }
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_STATE = {
  selectedNodeId: '',
  subscriptions: [],
  settings: DEFAULT_SETTINGS,
};

class Store {
  constructor(options = {}) {
    this.dir = options.dir || paths();
    this.settingsFile = options.settingsFile || this.dir.settingsFile;
    this.nodesFile = options.nodesFile || this.dir.nodesFile;
    this.log = options.log || createLogger(null);
    this.state = this.load();
  }

  load() {
    const settingsRaw = readJson(this.settingsFile, null);
    const nodesRaw = readJson(this.nodesFile, null);

    const settings = withDefaults(settingsRaw && settingsRaw.settings ? settingsRaw.settings : settingsRaw || {});
    const nodes = Array.isArray(nodesRaw) ? nodesRaw : [];
    const selectedNodeId =
      (settingsRaw && settingsRaw.selectedNodeId) ||
      (nodes.length ? nodes[0].id : '') ||
      DEFAULT_STATE.selectedNodeId;
    const subscriptions = (settingsRaw && settingsRaw.subscriptions) || [];

    return { settings, nodes, selectedNodeId, subscriptions };
  }

  reload() {
    this.state = this.load();
    return this.state;
  }

  persist() {
    const { settings, selectedNodeId, subscriptions } = this.state;
    writeJson(this.settingsFile, { version: 1, settings, selectedNodeId, subscriptions });
  }

  persistNodes() {
    writeJson(this.nodesFile, this.state.nodes);
  }

  /** 更新设置（深合并交给调用方处理，这里只做浅合并 + 落盘） */
  updateSettings(patch) {
    this.state.settings = withDefaults({ ...this.state.settings, ...patch });
    this.persist();
    return this.state.settings;
  }

  setNodes(nodes) {
    this.state.nodes = nodes;
    if (!nodes.some((n) => n.id === this.state.selectedNodeId)) {
      this.state.selectedNodeId = nodes.length ? nodes[0].id : '';
    }
    this.persistNodes();
    this.persist();
    return this.state.nodes;
  }

  addNodes(nodes) {
    const existingIds = new Set(this.state.nodes.map((n) => n.id));
    const fresh = nodes.filter((n) => !existingIds.has(n.id));
    return { nodes: this.setNodes(this.state.nodes.concat(fresh)), added: fresh.length };
  }

  removeNode(id) {
    return this.setNodes(this.state.nodes.filter((n) => n.id !== id));
  }

  selectNode(id) {
    if (this.state.nodes.some((n) => n.id === id)) {
      this.state.selectedNodeId = id;
      this.persist();
    }
    return this.state.selectedNodeId;
  }

  /** 保存订阅信息（含上次更新结果），订阅节点本身的合并由 store-merge 负责 */
  upsertSubscription(subscription) {
    const list = this.state.subscriptions.filter((s) => s.url !== subscription.url);
    list.push(subscription);
    this.state.subscriptions = list;
    this.persist();
    return list;
  }

  removeSubscription(url) {
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.url !== url);
    this.persist();
    return this.state.subscriptions;
  }

  snapshot() {
    return {
      settings: JSON.parse(JSON.stringify(this.state.settings)),
      nodes: JSON.parse(JSON.stringify(this.state.nodes)),
      selectedNodeId: this.state.selectedNodeId,
      subscriptions: JSON.parse(JSON.stringify(this.state.subscriptions)),
    };
  }
}

module.exports = { Store, readJson, writeJson, DEFAULT_STATE };
