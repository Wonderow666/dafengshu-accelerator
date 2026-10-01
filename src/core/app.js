'use strict';

/**
 * 应用门面：把「配置生成 / 内核进程 / 系统代理 / 订阅 / 测速」编排成一个对象。
 * Electron 主进程和命令行都只依赖这一层，保证两条入口行为一致。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { paths } = require('./paths');
const { Store } = require('./store');
const { buildConfig } = require('./config');
const { CoreProcess, isAdmin } = require('./process');
const { SystemProxyManager, getSystemProxy, getLanAddresses, addFirewallRule } = require('./system-proxy');
const { parseSubscriptionContent, parseSubscriptionHeaders, mergeNodes, SUBSCRIPTION_UA } = require('./subscription');
const { parseUri } = require('./nodes');
const { delayViaClash, getSelectedTag, selectTag, testTwitterReachability } = require('./speedtest');
const kernel = require('./kernel');
const geo = require('./geo');
const { createLogger, shortId } = require('./util');

class App extends EventEmitter {
  constructor(options = {}) {
    super();
    this.p = paths();
    this.log = options.log || createLogger(this.p.appLogFile);
    this.store = options.store || new Store({ log: this.log });
    this.proxy = new SystemProxyManager(this.log);
    this.core = null;
    this.status = { running: false, starting: false, startedAt: 0, error: '', meta: null, systemProxy: false };
    this.nodeDelays = new Map();
    this._stopping = false;
  }

  // ── 查询 ────────────────────────────────────────────────────────────────
  snapshot() {
    const state = this.store.snapshot();
    return {
      ...state,
      runtime: { ...this.status },
      // 注意：这里只能是纯数据 —— 把方法塞进快照会导致 IPC 结构化克隆失败
      kernel: {
        installed: Boolean(kernel.installed()),
        path: kernel.binaryPath(),
        version: this.kernelVersionCache || null,
      },
      platform: {
        isWindows: process.platform === 'win32',
        isAdmin: isAdmin(),
      },
      delays: Object.fromEntries(this.nodeDelays),
      network: { lanAddresses: getLanAddresses() },
      dataDir: this.p.home,
    };
  }

  /** 读取内核版本号并缓存（供快照使用） */
  async loadKernelVersion() {
    this.kernelVersionCache = await kernel.getVersion();
    return this.kernelVersionCache;
  }

  async ensureKernel(options = {}) {
    const existing = kernel.installed();
    if (existing) return { ok: true, path: existing, version: await kernel.getVersion(), alreadyInstalled: true };
    this.emit('log', '未发现 sing-box 内核，开始自动下载…');
    let lastEmit = 0;
    const result = await kernel.install({
      ...options,
      log: this.log,
      onProgress: ({ received, total }) => {
        const now = Date.now();
        if (now - lastEmit < 400 && received !== total) return;
        lastEmit = now;
        this.emit('progress', {
          phase: 'kernel-download',
          received,
          total,
          percent: total ? Math.round((received / total) * 100) : null,
        });
      },
    });
    this.emit('log', result.ok ? `内核就绪: ${result.version}` : `内核安装失败: ${result.error}`);
    return result;
  }

  // ── 节点与订阅 ──────────────────────────────────────────────────────────
  /** 从文本导入节点（支持多行分享链接） */
  importFromText(text) {
    const { nodes, errors } = parseSubscriptionContent(text);
    if (!nodes.length) {
      throw new Error(errors[0] || '没有解析出任何节点');
    }
    const result = this.store.addNodes(nodes);
    this.emit('nodes', this.store.snapshot().nodes);
    return { added: result.added, total: result.nodes.length, errors, parsed: nodes.length };
  }

  importFromUri(uri) {
    const node = parseUri(uri);
    const result = this.store.addNodes([node]);
    this.emit('nodes', this.store.snapshot().nodes);
    return { added: result.added, node, total: result.nodes.length };
  }

  removeNode(id) {
    const nodes = this.store.removeNode(id);
    this.emit('nodes', nodes);
    return nodes;
  }

  async selectNode(id) {
    const previous = this.store.state.selectedNodeId;
    this.store.selectNode(id);
    const nodes = this.store.state.nodes;
    const node = nodes.find((n) => n.id === id);
    this.emit('selected', id);

    // 正在运行时热切换：通过 Clash API 切 selector，不重启内核、不断已有连接
    if (this.status.running && this.core && node) {
      const index = nodes.findIndex((n) => n.id === id);
      const tag = `node-${index}`;
      const result = await selectTag(this.core.clashApiPort, 'proxy', tag);
      if (!result.ok) {
        this.log.warn(`热切换失败，将在下次启动生效: ${result.error || ''}`);
      }
      // 兜底：如果配置里的节点集合变了（新增/删除过），必须重建配置
      const indexChanged = this.status.meta && this.status.meta.nodeTags && !this.status.meta.nodeTags.includes(tag);
      if (indexChanged) await this.restart();
    }
    return { selectedNodeId: this.store.state.selectedNodeId, previous };
  }

  /** 拉取并合并订阅 */
  async refreshSubscription(url, options = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');
    this.emit('log', `正在更新订阅: ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 30000);
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': SUBSCRIPTION_UA, Accept: '*/*' },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const message = error.name === 'AbortError' ? '订阅请求超时' : `订阅请求失败: ${error.message}`;
      this.store.upsertSubscription({ url, lastError: message, lastUpdate: Date.now(), nodeCount: 0 });
      throw new Error(message);
    }
    clearTimeout(timer);

    if (!response.ok) {
      const message = `订阅返回 HTTP ${response.status}`;
      this.store.upsertSubscription({ url, lastError: message, lastUpdate: Date.now(), nodeCount: 0 });
      throw new Error(message);
    }

    const body = await response.text();
    const info = parseSubscriptionHeaders(response.headers);
    const parsed = parseSubscriptionContent(body);
    if (!parsed.nodes.length) {
      const message = parsed.errors[0] || '订阅里没有可用节点';
      this.store.upsertSubscription({ url, lastError: message, lastUpdate: Date.now(), nodeCount: 0 });
      throw new Error(message);
    }

    const merged = mergeNodes(this.store.state.nodes, parsed.nodes, { source: `sub:${shortId(url)}` });
    this.store.setNodes(merged.nodes);
    const subscription = {
      url,
      title: info.title || new URL(url).hostname,
      lastUpdate: Date.now(),
      lastError: '',
      nodeCount: parsed.nodes.length,
      format: parsed.format,
      traffic: { upload: info.upload, download: info.download, total: info.total, expire: info.expire },
    };
    this.store.upsertSubscription(subscription);
    this.emit('nodes', this.store.state.nodes);
    this.emit('log', `订阅更新完成：新增 ${merged.added} 个，更新 ${merged.updated} 个节点`);
    return { ...subscription, added: merged.added, updated: merged.updated, errors: parsed.errors };
  }

  async refreshAllSubscriptions() {
    const results = [];
    for (const sub of this.store.state.subscriptions) {
      try {
        results.push({ url: sub.url, ok: true, ...(await this.refreshSubscription(sub.url)) });
      } catch (error) {
        results.push({ url: sub.url, ok: false, error: error.message });
      }
    }
    return results;
  }

  removeSubscription(url) {
    return this.store.removeSubscription(url);
  }

  // ── 启动 / 停止 ─────────────────────────────────────────────────────────
  /** 探测内核配置语法（legacy=1.11 及更早，modern=1.12+），结果缓存复用 */
  async detectSchema(force = false) {
    if (this.schema && !force) return this.schema;
    const binary = kernel.installed();
    if (!binary) {
      this.schema = 'legacy'; // 没内核时先按最保守的语法生成，装好后会重新探测
      return this.schema;
    }
    const core = new CoreProcess({
      binary,
      configFile: this.p.configFile,
      clashApiPort: this.store.state.settings.clashApiPort,
      log: this.log,
    });
    this.schema = await core.detectSchema(force);
    return this.schema;
  }

  /** 生成配置但不启动（用于预览/排查） */
  async buildConfigOnly(options = {}) {
    const snapshot = this.store.snapshot();
    const forced = options.schema || snapshot.settings.compatibility.schema;
    const schema = forced === 'modern' || forced === 'legacy' ? forced : await this.detectSchema();
    const geo = await this.resolveGeo(snapshot.settings);

    return buildConfig(
      { settings: snapshot.settings, nodes: snapshot.nodes, selectedNodeId: snapshot.selectedNodeId },
      {
        schema,
        geoFiles: geo.files,
        allowLegacyGeo: geo.allowLegacy,
        preferRuleSets: geo.preferRuleSets,
        logFile: this.p.logFile,
        cacheFile: path.join(this.p.cache, 'cache.db'),
        log: this.log,
      }
    );
  }

  /**
   * 决定国内域名/IP 用哪套数据源：
   *   auto    → 有本地规则集就用（离线、1.12 也不会失效），否则回退内置 geo 库（带环境变量放行）
   *   ruleset → 只用规则集（下载失败就退化成内置域名后缀表）
   *   legacy  → 强制用内置 geo 库
   *   suffix  → 只用软件内置的域名后缀表（完全不依赖内核 geo）
   */
  async resolveGeo(settings) {
    const mode = (settings.route && settings.route.geoSource) || 'auto';
    if (mode === 'suffix') return { files: {}, allowLegacy: false, preferRuleSets: false };
    if (mode === 'legacy') return { files: {}, allowLegacy: true, preferRuleSets: false };

    let files = geo.availableRuleSets();
    const complete = Boolean(files.geositeCn && files.geoipCn);

    // 只在缓存不完整且本次会话还没试过时下载（国内直连源通常不通，快速失败不阻塞启动）
    if (!complete && this.geoDownloadTried !== true) {
      this.geoDownloadTried = true;
      const result = await geo.ensureRuleSets({ log: this.log, timeout: 8000 });
      files = result.files;
    }

    if (files.geositeCn && files.geoipCn) {
      return { files, allowLegacy: false, preferRuleSets: true };
    }
    if (mode === 'ruleset') {
      // 用户明确要求只用规则集：退化成内置后缀表，保证能启动
      return { files: {}, allowLegacy: false, preferRuleSets: false };
    }
    return { files: {}, allowLegacy: true, preferRuleSets: false };
  }

  async start(options = {}) {
    if (this.status.running) return { ok: true, alreadyRunning: true };
    if (this.status.starting) throw new Error('正在启动中，请稍候');
    this.status.starting = true;
    this.status.error = '';
    this.emit('status', { ...this.status });

    try {
      const kernelInfo = await this.ensureKernel();
      if (!kernelInfo.ok) throw new Error(kernelInfo.error);

      // 内核可能刚刚安装/更新，重新探测一次配置语法
      await this.detectSchema(true);
      const { config, meta, warnings } = await this.buildConfigOnly();
      for (const warning of warnings) this.log.warn(warning);

      // 回退到内置 geo 库时，必须给内核放行环境变量，否则会 FATAL 退出
      const legacyGeo = meta.routing.geo === 'legacy';

      this.core = new CoreProcess({
        binary: kernelInfo.path || kernel.binaryPath(),
        configFile: this.p.configFile,
        logFile: this.p.logFile,
        clashApiPort: meta.clashApiPort,
        env: legacyGeo ? geo.LEGACY_GEO_ENV : null,
        log: this.log,
      });

      const started = await this.core.start(config, {
        onExit: (info) => {
          // 非用户主动停止的意外退出：更新状态并通知界面
          if (!this._stopping && this.status.running) {
            this.status = { ...this.status, running: false, error: `内核意外退出（code=${info.code}）` };
            this.emit('status', { ...this.status });
            this.emit('log', this.status.error);
          }
        },
      });

      this.status = {
        running: true,
        starting: false,
        startedAt: Date.now(),
        error: '',
        meta,
        startupMs: started.startupMs,
        systemProxy: false,
      };

      // 系统代理：TUN 模式下不需要，用户要求时才设置
      const wantSystemProxy = this.store.state.settings.systemProxy.enabled && !meta.tunEnabled;
      if (wantSystemProxy) {
        try {
          await this.proxy.enable('127.0.0.1', meta.inboundPort, {
            bypass: this.store.state.settings.systemProxy.bypass,
          });
          this.status.systemProxy = true;
        } catch (error) {
          this.log.warn(`设置系统代理失败: ${error.message}`);
          this.status.error = `系统代理设置失败：${error.message}`;
        }
      }

      this.emit('status', { ...this.status });
      this.log.info(`加速已启动，节点：${meta.selectedNode.name}`);
      this.emit('log', `加速已启动 · 节点 ${meta.selectedNode.name} · 加速域名 ${meta.routing.accelerationSuffixes} 个`);
      return { ok: true, meta, warnings };
    } catch (error) {
      this.status = { ...this.status, running: false, starting: false, error: error.message };
      this.emit('status', { ...this.status });
      this.log.error(`启动失败: ${error.message}`);
      // 启动失败时把系统代理还原，避免用户上不了网
      await this.proxy.restore().catch(() => {});
      throw error;
    } finally {
      if (this.status.starting) this.status.starting = false;
    }
  }

  async stop() {
    this._stopping = true;
    try {
      if (this.core) {
        await this.core.stop();
        this.core = null;
      }
      await this.proxy.restore().catch((error) => this.log.warn(`还原系统代理失败: ${error.message}`));
      const wasRunning = this.status.running;
      this.status = { running: false, starting: false, startedAt: 0, error: '', meta: null, systemProxy: false };
      this.emit('status', { ...this.status });
      if (wasRunning) {
        this.log.info('加速已停止');
        this.emit('log', '加速已停止，系统代理已还原');
      }
      return { ok: true };
    } finally {
      this._stopping = false;
    }
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  async toggle(force) {
    const shouldRun = typeof force === 'boolean' ? force : !this.status.running;
    return shouldRun ? this.start() : this.stop();
  }

  // ── 测速 ────────────────────────────────────────────────────────────────
  /**
   * 给所有节点测延迟。内核未运行时返回提示，因为真实链路测速必须依赖内核。
   */
  async testAllNodes(options = {}) {
    if (!this.status.running || !this.core) {
      throw new Error('请先启动加速，再测速（测速需要内核实时发起连接）');
    }
    const nodes = this.store.state.nodes;
    const results = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const tag = `node-${index}`;
      const result = await delayViaClash(this.core.clashApiPort, tag, options);
      const entry = { id: node.id, name: node.name, tag, ...result, at: Date.now() };
      if (result.ok) this.nodeDelays.set(node.id, result.delay);
      results.push(entry);
      this.emit('delay', entry);
    }
    this.emit('delays', results);
    return results;
  }

  async testNode(id, options = {}) {
    if (!this.status.running || !this.core) throw new Error('请先启动加速，再测速');
    const index = this.store.state.nodes.findIndex((n) => n.id === id);
    if (index < 0) throw new Error('节点不存在');
    const result = await delayViaClash(this.core.clashApiPort, `node-${index}`, options);
    if (result.ok) this.nodeDelays.set(id, result.delay);
    this.emit('delay', { id, tag: `node-${index}`, ...result });
    return result;
  }

  /** 「Twitter 到底通不通」的直接检测 */
  async checkTwitter(options = {}) {
    if (!this.status.running || !this.core) throw new Error('请先启动加速，再检测');
    const tag = (await getSelectedTag(this.core.clashApiPort, 'proxy')) || 'proxy';
    return testTwitterReachability(this.core.clashApiPort, tag, options);
  }

  // ── 设置与日志 ──────────────────────────────────────────────────────────
  async updateSettings(patch) {
    const merged = require('./config').withDefaults(deepMergePlain(this.store.state.settings, patch));
    this.store.state.settings = merged;
    this.store.persist();
    this.emit('settings', merged);

    // 影响内核的设置在运行时需要重启才能生效
    if (this.status.running && patchRequiresRestart(patch)) {
      this.emit('log', '设置已变更，正在重启内核使其生效…');
      await this.restart();
    }
    return merged;
  }

  getLogs(lines = 300) {
    const kernelLogs = this.core ? this.core.tailLog(0) : [];
    const fileLogs = readTail(this.p.logFile, lines);
    return {
      kernel: fileLogs,
      app: this.log.tail(lines),
      files: { kernel: this.p.logFile, app: this.p.appLogFile, config: this.p.configFile },
    };
  }

  clearLogs() {
    try {
      fs.writeFileSync(this.p.logFile, '', 'utf8');
    } catch {
      /* 忽略 */
    }
    if (this.core) this.core.clearLog();
    return { ok: true };
  }

  async systemProxyStatus() {
    return getSystemProxy();
  }

  /** 为局域网共享放行 Windows 防火墙（需要管理员权限，失败不致命） */
  async addFirewallRule() {
    return addFirewallRule(this.store.state.settings.inboundPort);
  }

  /** 手机等设备该填的连接信息 */
  lanInfo() {
    const addresses = getLanAddresses();
    return {
      enabled: Boolean(this.store.state.settings.allowLan),
      host: addresses.length ? addresses[0].address : null,
      addresses,
      port: this.store.state.settings.inboundPort,
    };
  }

  async dispose() {
    await this.stop();
    this.log.close();
  }
}

/** 只做浅层合并的辅助（设置结构不深，避免把数组意外合并） */
function deepMergePlain(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMergePlain(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function patchRequiresRestart(patch) {
  const keys = ['inboundPort', 'clashApiPort', 'tun', 'dns', 'route', 'acceleration', 'compatibility', 'log'];
  return Object.keys(patch || {}).some((key) => keys.includes(key));
}

function readTail(file, lines) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

module.exports = { App, deepMergePlain };
