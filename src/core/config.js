'use strict';

/**
 * sing-box 配置生成器（按内核版本自适应语法）。
 *
 * 为什么需要两套语法：sing-box 1.12 起把 DNS server 从
 *   { tag, address: 'https://1.1.1.1/dns-query' }
 * 改成了
 *   { type: 'https', tag, server: '1.1.1.1' }
 * 并且新增了 route.default_domain_resolver、DNS 的 predefined 动作。
 * 字段放错位置内核会直接 FATAL 退出，所以这里按探测到的版本分别生成。
 *
 * 两套语法共用的分流逻辑：
 *   1. 广告域名 → 拦截（DNS + 路由双保险）
 *   2. 预设加速域名（Twitter/X 等）→ 强制走代理，DNS 走加密 DoH 防污染
 *   3. 内网/本机 → 直连
 *   4. 国内域名/IP → 直连（保证国内站点不掉速）
 *   5. 其余 → 走代理
 */

const path = require('path');
const os = require('os');
const { nodeToOutbound } = require('./nodes');
const {
  CATEGORY_PRESETS,
  CHINA_SUFFIXES,
  PRIVATE_CIDRS,
  DIRECT_DOMAIN_KEYWORDS,
  AD_DOMAIN_KEYWORDS,
} = require('./acceleration');

const DEFAULT_SETTINGS = {
  inboundPort: 2080,
  clashApiPort: 9090,
  // 局域网共享：开启后手机等设备可用「本机IP + inboundPort」走同一个代理
  allowLan: false,
  tun: { enabled: false, address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'], mtu: 9000 },
  systemProxy: { enabled: false, bypass: '<local>' },
  dns: {
    local: '223.5.5.5',
    localBackup: '119.29.29.29',
    remote: 'https://1.1.1.1/dns-query',
    remoteBackup: 'https://8.8.8.8/dns-query',
    strategy: 'prefer_ipv4',
  },
  route: {
    final: 'proxy',
    blockAds: true,
    bypassChina: true,
    // 国内域名/IP 的判定数据源：auto=优先本地规则集，失败回退内置 geo 库
    geoSource: 'auto',
    ruleSets: false,
    sniffer: true,
  },
  acceleration: {
    categories: ['twitter'],
    customSuffixes: [],
  },
  log: {
    level: 'info',
    toFile: true,
  },
  compatibility: {
    // auto: 按内核实际版本决定；也可强制 'legacy' / 'modern'
    schema: 'auto',
  },
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function withDefaults(settings) {
  return deepMerge(DEFAULT_SETTINGS, settings || {});
}

/** 收集本次要强制走代理的域名后缀 */
function accelerationSuffixes(acceleration) {
  const set = new Set();
  for (const key of (acceleration && acceleration.categories) || []) {
    const preset = CATEGORY_PRESETS[key];
    if (preset) preset.suffixes.forEach((s) => set.add(s));
  }
  for (const suffix of (acceleration && acceleration.customSuffixes) || []) {
    const clean = String(suffix)
      .trim()
      .replace(/^\*\./, '')
      .replace(/^\./, '')
      .toLowerCase();
    if (clean) set.add(clean);
  }
  return Array.from(set);
}

/** 解析 DoH/DoT 地址，得到主机名（现代语法需要把主机单独放进 server 字段） */
function splitDnsAddress(address) {
  const raw = String(address || '').trim();
  const match = raw.match(/^(https?|tls|h3|quic):\/\/([^/]+)/i);
  if (match) return match[2];
  return raw;
}

function buildDnsServers(settings, schema) {
  const { local, localBackup, remote, remoteBackup } = settings.dns;
  const servers = [];

  if (schema === 'modern') {
    servers.push({ type: 'udp', tag: 'dns-local', server: splitDnsAddress(local), detour: 'direct' });
    if (remote) {
      servers.push({
        type: 'https',
        tag: 'dns-remote',
        server: splitDnsAddress(remote),
        detour: 'proxy',
        domain_resolver: 'dns-local',
      });
    }
    if (remoteBackup) {
      servers.push({
        type: 'https',
        tag: 'dns-remote-backup',
        server: splitDnsAddress(remoteBackup),
        detour: 'proxy',
        domain_resolver: 'dns-local',
      });
    }
    if (localBackup) {
      servers.push({ type: 'udp', tag: 'dns-local-backup', server: splitDnsAddress(localBackup), detour: 'direct' });
    }
  } else {
    // 1.11 及更早：address 字段 + 单个 server 值，没有 domain_resolver
    servers.push({ tag: 'dns-local', address: splitDnsAddress(local), detour: 'direct' });
    if (remote) servers.push({ tag: 'dns-remote', address: remote, detour: 'proxy' });
    if (remoteBackup) servers.push({ tag: 'dns-remote-backup', address: remoteBackup, detour: 'proxy' });
    if (localBackup) servers.push({ tag: 'dns-local-backup', address: splitDnsAddress(localBackup), detour: 'direct' });
    // 广告域名解析成「本地成功但无记录」，等效于让请求直接落空
    servers.push({ tag: 'dns-block', address: 'rcode://success', detour: 'direct' });
  }
  return servers;
}

function buildDnsRules(settings, suffixes, schema, options = {}) {
  const rules = [];
  const remoteTag = 'dns-remote';
  const geo = options.geo || { mode: 'suffix' };
  const ruleSetTags = geo.ruleSets || [];

  if (settings.route.blockAds) {
    if (schema === 'modern') {
      rules.push({ domain_keyword: AD_DOMAIN_KEYWORDS, action: 'predefined', server: 'block' });
    } else {
      rules.push({ domain_keyword: AD_DOMAIN_KEYWORDS, server: 'dns-block' });
    }
  }

  // 加速域名：必须最先判定，用加密 DNS 解析，避免解析结果被污染
  if (suffixes.length) {
    rules.push({ domain_suffix: suffixes, server: remoteTag });
  }

  // 国内域名：用国内 DNS，拿到就近 IP（也避免国内 CDN 被解析到海外）
  if (settings.route.bypassChina) {
    if (geo.mode === 'ruleset' && ruleSetTags.length) {
      rules.push({ rule_set: ruleSetTags, server: 'dns-local' });
    } else if (geo.mode === 'legacy') {
      rules.push({ geosite: ['cn'], server: 'dns-local' });
    } else {
      rules.push({ domain_suffix: CHINA_SUFFIXES, server: 'dns-local' });
    }
  }

  rules.push({ domain_keyword: DIRECT_DOMAIN_KEYWORDS, server: 'dns-local' });
  // 注意：不要把「无条件的兜底规则」放进 DNS rules —— 1.11 会报 missing conditions，
  // 兜底由 dns.final 负责。
  return rules;
}

function buildDns(settings, suffixes, schema, options = {}) {
  const servers = buildDnsServers(settings, schema);
  const rules = buildDnsRules(settings, suffixes, schema, options);
  const dns = { servers, rules };

  if (schema === 'modern') {
    dns.final = settings.dns.remoteBackup ? ['dns-remote', 'dns-remote-backup'] : 'dns-remote';
    dns.strategy = settings.dns.strategy || 'prefer_ipv4';
    dns.independent_cache = true;
  } else {
    // 1.11 的 final/server 只接受单个字符串，多上游顺序写在 servers 里不起作用，
    // 这里用「主 DNS 失败即由系统解析兜底」的策略，保证不会因为一个 DNS 挂掉就断网。
    dns.final = 'dns-remote';
    dns.strategy = settings.dns.strategy || 'prefer_ipv4';
    dns.independent_cache = true;
  }
  return dns;
}

function buildRoute(settings, suffixes, schema, options = {}) {
  const rules = [];
  const geo = options.geo || { mode: 'suffix' };
  const ruleSetTags = geo.ruleSets || [];

  if (settings.route.blockAds) {
    rules.push({ domain_keyword: AD_DOMAIN_KEYWORDS, action: 'reject' });
  }
  if (settings.route.sniffer !== false) rules.push({ action: 'sniff' });

  // 加速域名优先于「国内直连」判定：即使某个 X 的域名被地理库判成国内，也必须走代理
  if (suffixes.length) {
    rules.push({ domain_suffix: suffixes, action: 'route', outbound: 'proxy' });
  }

  rules.push({ ip_is_private: true, action: 'route', outbound: 'direct' });
  rules.push({ domain_keyword: DIRECT_DOMAIN_KEYWORDS, action: 'route', outbound: 'direct' });

  // 手动模式（界面上可切换全局/直连）
  rules.push({ clash_mode: 'direct', action: 'route', outbound: 'direct' });
  rules.push({ clash_mode: 'global', action: 'route', outbound: 'proxy' });

  if (settings.route.bypassChina) {
    if (geo.mode === 'ruleset' && ruleSetTags.length) {
      rules.push({ rule_set: ruleSetTags, action: 'route', outbound: 'direct' });
    } else if (geo.mode === 'legacy') {
      rules.push({ geosite: ['cn'], action: 'route', outbound: 'direct' });
    } else {
      rules.push({ domain_suffix: CHINA_SUFFIXES, action: 'route', outbound: 'direct' });
    }

    rules.push({ ip_cidr: PRIVATE_CIDRS, action: 'route', outbound: 'direct' });

    if (geo.mode === 'legacy') {
      rules.push({ geoip: ['cn'], action: 'route', outbound: 'direct' });
    } else if (geo.mode === 'ruleset' && geo.ipRuleSets && geo.ipRuleSets.length) {
      rules.push({ rule_set: geo.ipRuleSets, action: 'route', outbound: 'direct' });
    }
  }

  const route = {
    rules,
    final: settings.route.final === 'direct' ? 'direct' : 'proxy',
    auto_detect_interface: true,
  };
  if (schema === 'modern') route.default_domain_resolver = 'dns-local';

  // 配置里不许引用未定义的 rule_set（内核会 FATAL）
  if (route.rule_set) delete route.rule_set;
  return route;
}

/**
 * @param {{settings: object, nodes: object[], selectedNodeId?: string}} state
 * @param {{schema?: 'legacy'|'modern', cacheDir?: string, logFile?: string, cacheFile?: string, log?: object}} [options]
 */
function buildConfig(state, options = {}) {
  const settings = withDefaults(state.settings);
  const nodes = Array.isArray(state.nodes) ? state.nodes : [];
  const warnings = [];
  const schema = options.schema === 'modern' ? 'modern' : 'legacy';

  if (!nodes.length) {
    throw new Error('还没有任何节点：请先在「节点」里粘贴分享链接，或导入订阅链接。');
  }

  const selected = nodes.find((n) => n.id === state.selectedNodeId) || nodes[0];
  if (!nodes.some((n) => n.id === selected.id)) warnings.push('选中的节点不存在，已自动回退到第一个节点。');

  const suffixes = accelerationSuffixes(settings.acceleration);
  if (!suffixes.length) warnings.push('加速域名列表为空，将只按「国内直连、其余走代理」分流。');

  // ── 分流数据源（国内域名/IP 判定）──────────────────────────────────────
  const geoFiles = options.geoFiles || {};
  const wantGeo = Boolean(settings.route.bypassChina);
  const preferRuleSets = options.preferRuleSets !== false;
  let geo;
  if (!wantGeo) {
    geo = { mode: 'off', ruleSets: [], ipRuleSets: [] };
  } else if (preferRuleSets && geoFiles.geositeCn && geoFiles.geoipCn) {
    geo = { mode: 'ruleset', ruleSets: ['geositeCn'], ipRuleSets: ['geoipCn'] };
  } else if (options.allowLegacyGeo) {
    geo = { mode: 'legacy', ruleSets: [], ipRuleSets: [] };
    warnings.push('已回退到内核内置 geo 库（需要环境变量放行，且 1.12 起会被移除）');
  } else {
    geo = { mode: 'suffix', ruleSets: [], ipRuleSets: [] };
    warnings.push('未取得 geo 规则集，改用内置域名后缀表做国内直连判定（覆盖略少但无需下载）');
  }

  // ── 出站 ────────────────────────────────────────────────────────────────
  // 保持与 nodes 同序（含失败项），这样可以用下标定位选中节点
  const nodeOutbounds = nodes.map((node, index) => {
    try {
      return nodeToOutbound(node, { tag: `node-${index}` });
    } catch (error) {
      warnings.push(`节点「${node.name}」无法转换：${error.message}`);
      return null;
    }
  });
  const badIndex = nodeOutbounds.indexOf(null);
  if (badIndex >= 0) {
    throw new Error(`节点「${nodes[badIndex].name}」配置不完整（${nodes[badIndex].type}），请修正或删除后再启动。`);
  }

  const selectedIndex = Math.max(
    0,
    nodes.findIndex((n) => n.id === selected.id)
  );
  const selectedTag = nodeOutbounds[selectedIndex].tag;
  const usableOutbounds = nodeOutbounds.filter(Boolean);

  if (schema === 'legacy') {
    // 1.11 的 dialer 不支持 domain_resolver，用 domain_strategy 控制解析偏好即可
    for (const outbound of usableOutbounds) {
      outbound.domain_strategy = settings.dns.strategy === 'ipv6_only' ? 'ipv6_only' : 'prefer_ipv4';
    }
  }

  const selectorOutbounds = [selectedTag, ...usableOutbounds.map((o) => o.tag).filter((t) => t !== selectedTag)];
  const outbounds = [
    {
      type: 'selector',
      tag: 'proxy',
      outbounds: selectorOutbounds,
      default: selectedTag,
      interrupt_exist_connections: false,
    },
    ...usableOutbounds,
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' },
  ];

  // ── 组装 ────────────────────────────────────────────────────────────────
  const dns = buildDns(settings, suffixes, schema, { geo });
  const route = buildRoute(settings, suffixes, schema, { geo });

  // 只在确实用到本地规则集时，才把 rule_set 定义写进配置
  const usedRuleSets = new Set();
  for (const rule of [...route.rules, ...dns.rules]) {
    for (const tag of [].concat(rule.rule_set || [])) usedRuleSets.add(tag);
  }
  if (usedRuleSets.size) {
    route.rule_set = Array.from(usedRuleSets).map((tag) => ({
      tag,
      type: 'local',
      format: 'binary',
      path: geoFiles[tag],
    }));
    const missingPath = route.rule_set.find((r) => !r.path);
    if (missingPath) throw new Error(`规则集 ${missingPath.tag} 缺少本地文件路径`);
  }

  const inbounds = [
    {
      type: 'mixed',
      tag: 'mixed-in',
      // 开启局域网共享后监听所有网卡，手机等设备才能连进来
      listen: settings.allowLan ? '0.0.0.0' : '127.0.0.1',
      listen_port: settings.inboundPort,
      sniff: true,
      sniff_override_destination: false,
      set_system_proxy: false,
    },
  ];

  if (settings.tun.enabled) {
    inbounds.push({
      type: 'tun',
      tag: 'tun-in',
      interface_name: 'dafengshu-tun',
      address: settings.tun.address,
      mtu: settings.tun.mtu || 9000,
      auto_route: true,
      strict_route: false,
      stack: 'mixed',
      sniff: true,
      sniff_override_destination: false,
    });
  }

  const config = {
    log: {
      level: settings.log.level || 'info',
      timestamp: true,
    },
    dns,
    inbounds,
    outbounds,
    route,
    experimental: {
      cache_file: {
        enabled: true,
        path: options.cacheFile || path.join(os.tmpdir(), 'dafengshu-cache.db'),
      },
      clash_api: {
        external_controller: `127.0.0.1:${settings.clashApiPort}`,
        default_mode: 'rule',
      },
    },
  };

  if (settings.log.toFile !== false && options.logFile) {
    config.log.output = options.logFile;
  }

  return {
    config,
    meta: {
      schema,
      selectedNode: { id: selected.id, name: selected.name, type: selected.type, server: selected.server },
      selectedTag,
      nodeTags: usableOutbounds.map((o) => o.tag),
      inboundPort: settings.inboundPort,
      clashApiPort: settings.clashApiPort,
      tunEnabled: Boolean(settings.tun.enabled),
      routing: {
        accelerationSuffixes: suffixes.length,
        bypassChina: Boolean(settings.route.bypassChina),
        blockAds: Boolean(settings.route.blockAds),
        geo: geo.mode,
        ruleSets: Array.from(usedRuleSets),
        final: route.final,
      },
    },
    warnings,
  };
}

/**
 * 探测内核接受的语法版本：用最小配置试探 DNS server 的写法。
 * @param {(config: object) => Promise<{ok: boolean, output: string}>} validate 校验函数
 */
async function detectSchema(validate) {
  const probeModern = {
    dns: {
      servers: [
        { type: 'udp', tag: 'dns-local', server: '223.5.5.5' },
        { type: 'https', tag: 'dns-remote', server: '1.1.1.1', domain_resolver: 'dns-local' },
      ],
      rules: [{ domain_suffix: ['x.com'], action: 'route', server: 'dns-remote' }],
      final: 'dns-remote',
    },
    inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }],
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: { rules: [], final: 'direct', default_domain_resolver: 'dns-local' },
  };
  try {
    const result = await validate(probeModern);
    if (result.ok) return 'modern';
  } catch {
    /* 探针失败视为旧版 */
  }
  return 'legacy';
}

module.exports = { DEFAULT_SETTINGS, buildConfig, withDefaults, accelerationSuffixes, detectSchema, splitDnsAddress };
