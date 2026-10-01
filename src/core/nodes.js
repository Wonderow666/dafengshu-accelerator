'use strict';

/**
 * 节点模型 + 分享链接解析。
 *
 * 支持从「分享链接」导入：vless / vmess / trojan / ss / socks / http / hysteria2 / tuic
 * 也支持从 Clash(mihomo) 的 proxies 对象导入（订阅 YAML/JSON 用）。
 *
 * 统一节点结构：
 * {
 *   id, name, type, server, port,
 *   uuid, password, method, username, flow,
 *   tls: { enabled, sni, alpn[], insecure, fingerprint, realityPublicKey, realityShortId, allowInsecure },
 *   transport: { type: 'tcp'|'ws'|'grpc'|'http'|'httpupgrade', path, host, serviceName, headers },
 *   extra: {}   // 未识别的协议字段，原样保留便于排查
 * }
 */

const { decodeBase64Flexible, safeJson, shortId, toStringArray } = require('./util');

const SUPPORTED_SCHEMES = [
  'vless',
  'vmess',
  'trojan',
  'ss',
  'socks',
  'socks5',
  'http',
  'https',
  'hysteria2',
  'hy2',
  'hysteria',
  'tuic',
];

class NodeParseError extends Error {}

function toBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function portOf(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new NodeParseError(`端口不合法: ${value}`);
  }
  return port;
}

/**
 * 校验节点是否具备该协议必需的凭证。
 * 必须在这里拦住：否则生成的出站会因为字段值为 undefined 而被 JSON 丢掉，
 * 到内核启动时才报错，用户看不到「哪个节点缺什么」。
 */
function validateNode(node) {
  const missing = [];
  const type = node.type;
  if (!node.server) missing.push('服务器地址');
  if (!node.port) missing.push('端口');

  switch (type) {
    case 'vless':
    case 'vmess':
      if (!node.uuid) missing.push('UUID');
      break;
    case 'trojan':
    case 'hysteria2':
      if (!node.password) missing.push('密码');
      break;
    case 'tuic':
      if (!node.uuid) missing.push('UUID');
      if (!node.password) missing.push('密码');
      break;
    case 'ss':
      if (!node.method) missing.push('加密方式');
      break;
    default:
      break;
  }

  if (missing.length) {
    throw new NodeParseError(`节点「${node.name || node.server}」缺少 ${missing.join('、')}`);
  }
  return node;
}

function finalize(node) {
  const id = shortId(
    [node.type, node.server, node.port, node.uuid || node.password || node.username || '', node.name].join('|')
  );
  const normalized = {
    id,
    name: node.name && String(node.name).trim() ? String(node.name).trim() : `${node.server}:${node.port}`,
    type: node.type,
    server: node.server,
    port: node.port,
    uuid: node.uuid || '',
    password: node.password || '',
    username: node.username || '',
    method: node.method || '',
    flow: node.flow || '',
    tls: {
      enabled: Boolean(node.tls && node.tls.enabled),
      sni: (node.tls && node.tls.sni) || '',
      alpn: (node.tls && node.tls.alpn) || [],
      insecure: Boolean(node.tls && node.tls.insecure),
      fingerprint: (node.tls && node.tls.fingerprint) || '',
      realityPublicKey: (node.tls && node.tls.realityPublicKey) || '',
      realityShortId: (node.tls && node.tls.realityShortId) || '',
      allowInsecure: Boolean(node.tls && node.tls.allowInsecure),
    },
    transport: {
      type: (node.transport && node.transport.type) || 'tcp',
      path: (node.transport && node.transport.path) || '',
      host: (node.transport && node.transport.host) || '',
      serviceName: (node.transport && node.transport.serviceName) || '',
      headers: (node.transport && node.transport.headers) || {},
    },
    extra: node.extra || {},
  };
  validateNode(normalized);
  return normalized;
}

/** 从 URI 解析：vless:// vmess:// trojan:// ss:// socks:// http(s):// hysteria2:// tuic:// */
function parseUri(uri) {
  const raw = String(uri).trim();
  if (!raw) throw new NodeParseError('空链接');

  const lower = raw.toLowerCase();
  if (lower.startsWith('vmess://')) return parseVmess(raw);
  if (lower.startsWith('ss://')) return parseShadowsocks(raw);
  if (lower.startsWith('ssr://')) throw new NodeParseError('暂不支持 ShadowsocksR(ssr)');
  if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://')) return parseGeneric(raw, 'hysteria2');
  if (lower.startsWith('hysteria://')) throw new NodeParseError('暂不支持 hysteria v1，建议服务端改用 hysteria2');
  if (lower.startsWith('tuic://')) return parseGeneric(raw, 'tuic');

  const scheme = (raw.match(/^([a-z0-9+.-]+):\/\//i) || [])[1];
  if (!scheme) throw new NodeParseError(`无法识别的链接: ${raw.slice(0, 40)}`);
  if (!SUPPORTED_SCHEMES.includes(scheme.toLowerCase())) {
    throw new NodeParseError(`暂不支持该协议: ${scheme}`);
  }
  const normalizedScheme = scheme.toLowerCase() === 'socks5' ? 'socks' : scheme.toLowerCase();
  if (normalizedScheme === 'https') return parseGeneric(raw, 'http');
  return parseGeneric(raw, normalizedScheme);
}

/** 通用 userinfo@host:port?query#name 结构 */
function parseGeneric(raw, type) {
  let url;
  try {
    url = new URL(raw.replace(/^([a-z0-9+.-]+):\/\//i, (m) => m.toLowerCase()));
  } catch {
    throw new NodeParseError('链接格式不正确，请确认复制完整');
  }
  const params = url.searchParams;
  const password = decodeURIComponent(url.password || '');
  const username = decodeURIComponent(url.username || '');
  const server = url.hostname;
  if (!server) throw new NodeParseError('缺少服务器地址');
  if (!url.port && type !== 'http' && type !== 'socks') {
    throw new NodeParseError('链接缺少端口号，请确认复制完整');
  }
  const port = type === 'http' ? Number.parseInt(url.port || '80', 10) : portOf(url.port);

  const security = (params.get('security') || params.get('tls') || '').toLowerCase();
  const isReality = security === 'reality';
  const tlsEnabled =
    isReality ||
    security === 'tls' ||
    security === 'xtls' ||
    type === 'hysteria2' ||
    type === 'tuic' ||
    params.get('tls') === '1' ||
    Boolean(params.get('sni'));

  const transportType = (params.get('type') || params.get('obfs') || 'tcp').toLowerCase();

  // 注意：URL 解析器总会把第一个冒号前的内容当成「用户名」。
  // trojan / hysteria2 用单段 userinfo 当密码，所以两种位置都要接住。
  const singleSecret = password || username;

  const node = {
    type,
    server,
    port,
    uuid: type === 'vless' || type === 'vmess' ? username : '',
    password: type === 'vless' || type === 'vmess' ? '' : singleSecret,
    username: type === 'socks' || type === 'http' ? username : '',
    flow: params.get('flow') || '',
    tls: {
      enabled: tlsEnabled,
      sni: params.get('sni') || params.get('peer') || params.get('host') || '',
      alpn: toStringArray(params.get('alpn')),
      insecure: toBool(params.get('allowInsecure'), false) || toBool(params.get('insecure'), false),
      allowInsecure: toBool(params.get('allowInsecure'), false),
      fingerprint: params.get('fp') || '',
      realityPublicKey: params.get('pbk') || '',
      realityShortId: params.get('sid') || '',
    },
    transport: {
      type: normalizeTransport(transportType),
      path: params.get('path') || '',
      host: params.get('host') || '',
      serviceName: params.get('serviceName') || '',
      headers: {},
    },
    name: decodeURIComponent(url.hash.replace(/^#/, '')),
    extra: {},
  };

  if (type === 'hysteria2') {
    // hysteria2://password@host:port?sni=..&insecure=1
    node.password = password || username;
  }
  if (type === 'tuic') {
    // tuic://uuid:password@host:port?sni=..
    node.uuid = username;
    node.password = password;
  }

  for (const [key, value] of params.entries()) {
    if (!(key in node.extra) && !['security', 'type', 'sni', 'path', 'host', 'alpn', 'fp', 'pbk', 'sid', 'flow'].includes(key)) {
      node.extra[key] = value;
    }
  }
  return finalize(node);
}

function normalizeTransport(type) {
  const t = String(type || '').toLowerCase();
  if (['ws', 'websocket'].includes(t)) return 'ws';
  if (['grpc', 'gun'].includes(t)) return 'grpc';
  if (['http', 'h2', 'h2c'].includes(t)) return 'http';
  if (['httpupgrade'].includes(t)) return 'httpupgrade';
  if (['tcp', 'none', ''].includes(t)) return 'tcp';
  return t;
}

/** vmess://base64(JSON) */
function parseVmess(raw) {
  const body = raw.slice('vmess://'.length).trim();
  const decoded = decodeBase64Flexible(body);
  const json = safeJson(decoded || body);
  if (!json) throw new NodeParseError('vmess 链接解不出 JSON，链接可能被截断');

  const tlsSetting = String(json.tls || '').toLowerCase();
  const host = json.host || json.sni || '';
  const net = normalizeTransport(json.net || 'tcp');
  const node = {
    type: 'vmess',
    server: String(json.add || '').trim(),
    port: portOf(json.port),
    uuid: String(json.id || '').trim(),
    password: '',
    method: json.scy || json.security || 'auto',
    tls: {
      enabled: tlsSetting === 'tls' || tlsSetting === 'reality',
      sni: json.sni || host || '',
      alpn: toStringArray(json.alpn),
      insecure: toBool(json.allowInsecure, false) || toBool(json.skip_cert_verify, false),
    },
    transport: {
      type: net,
      path: json.path || '',
      host,
      serviceName: json.path || '',
      headers: json.type === 'http' ? { Host: host } : {},
    },
    name: json.ps || json.remark || '',
    extra: {},
  };
  if (!node.server) throw new NodeParseError('vmess 链接缺少服务器地址');
  if (!node.uuid) throw new NodeParseError('vmess 链接缺少 uuid');
  return finalize(node);
}

/** ss:// 两种格式：ss://base64(method:pass)@host:port#name 与 ss://base64(method:pass@host:port)#name */
function parseShadowsocks(raw) {
  const withoutScheme = raw.slice('ss://'.length);
  const hashIndex = withoutScheme.indexOf('#');
  const name = hashIndex >= 0 ? decodeURIComponent(withoutScheme.slice(hashIndex + 1)) : '';
  let body = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;

  // 先拆查询串（plugin= 等）
  let query = '';
  const qIndex = body.indexOf('?');
  if (qIndex >= 0) {
    query = body.slice(qIndex + 1);
    body = body.slice(0, qIndex);
  }

  let method = '';
  let password = '';
  let server = '';
  let port = 0;

  if (body.includes('@')) {
    const atIndex = body.lastIndexOf('@');
    const userInfo = body.slice(0, atIndex);
    const hostPart = body.slice(atIndex + 1);
    const decodedUser = userInfo.includes(':') ? decodeURIComponent(userInfo) : decodeBase64Flexible(userInfo);
    const sep = decodedUser.indexOf(':');
    if (sep < 0) throw new NodeParseError('ss 链接缺少加密方式或密码');
    method = decodedUser.slice(0, sep);
    password = decodedUser.slice(sep + 1);
    const hostSep = hostPart.lastIndexOf(':');
    server = decodeURIComponent(hostPart.slice(0, hostSep));
    port = portOf(hostPart.slice(hostSep + 1));
  } else {
    const decoded = decodeBase64Flexible(body);
    if (!decoded) throw new NodeParseError('ss 链接无法解析');
    const atIndex = decoded.lastIndexOf('@');
    if (atIndex < 0) throw new NodeParseError('ss 链接缺少服务器地址');
    const userInfo = decoded.slice(0, atIndex);
    const hostPart = decoded.slice(atIndex + 1);
    const sep = userInfo.indexOf(':');
    method = userInfo.slice(0, sep);
    password = userInfo.slice(sep + 1);
    const hostSep = hostPart.lastIndexOf(':');
    server = hostPart.slice(0, hostSep);
    port = portOf(hostPart.slice(hostSep + 1));
  }

  const params = new URLSearchParams(query);
  const pluginRaw = params.get('plugin') || '';
  const extra = {};
  if (pluginRaw) {
    const [pluginName, pluginOpts] = pluginRaw.split(';');
    extra.plugin = pluginName;
    extra.pluginOpts = pluginOpts || '';
  }

  return finalize({
    type: 'ss',
    server: server.trim(),
    port,
    method: method.trim(),
    password,
    tls: { enabled: false },
    transport: { type: 'tcp' },
    name,
    extra,
  });
}

/** Clash(mihomo) proxies 数组里的一项 -> 统一节点 */
function parseClashProxy(proxy) {
  if (!proxy || typeof proxy !== 'object') throw new NodeParseError('代理项不是对象');
  const type = String(proxy.type || '').toLowerCase();
  const server = proxy.server;
  const port = portOf(proxy.port);
  if (!server) throw new NodeParseError('缺少 server 字段');

  const tlsEnabled = toBool(proxy.tls, false);
  const base = {
    server,
    port,
    name: proxy.name || '',
    tls: {
      enabled: tlsEnabled,
      sni: proxy.servername || proxy.sni || '',
      alpn: toStringArray(proxy.alpn),
      insecure: toBool(proxy['skip-cert-verify'], false),
      fingerprint: proxy['client-fingerprint'] || '',
      realityPublicKey: proxy['reality-opts'] ? proxy['reality-opts']['public-key'] || '' : '',
      realityShortId: proxy['reality-opts'] ? proxy['reality-opts']['short-id'] || '' : '',
    },
    transport: {
      type: normalizeTransport(proxy.network || 'tcp'),
      path: proxy['ws-path'] || (proxy['ws-opts'] && proxy['ws-opts'].path) || '',
      host:
        proxy['ws-headers'] && proxy['ws-headers'].Host
          ? proxy['ws-headers'].Host
          : (proxy['ws-opts'] && proxy['ws-opts'].headers && proxy['ws-opts'].headers.Host) || '',
      serviceName: proxy['grpc-opts'] ? proxy['grpc-opts']['grpc-service-name'] || '' : '',
      headers: {},
    },
    extra: {},
  };

  switch (type) {
    case 'vless':
      return finalize({
        ...base,
        type: 'vless',
        uuid: proxy.uuid,
        flow: proxy.flow || '',
        password: '',
      });
    case 'vmess':
      return finalize({
        ...base,
        type: 'vmess',
        uuid: proxy.uuid,
        method: proxy.cipher || 'auto',
        password: '',
      });
    case 'trojan':
      return finalize({ ...base, type: 'trojan', password: proxy.password, tls: { ...base.tls, enabled: true } });
    case 'ss':
      return finalize({
        ...base,
        type: 'ss',
        method: proxy.cipher,
        password: proxy.password,
        tls: { ...base.tls, enabled: false },
        extra: proxy.plugin ? { plugin: proxy.plugin, pluginOpts: proxy['plugin-opts'] } : {},
      });
    case 'hysteria2':
    case 'hy2':
      return finalize({ ...base, type: 'hysteria2', password: proxy.password, tls: { ...base.tls, enabled: true } });
    case 'tuic':
      return finalize({
        ...base,
        type: 'tuic',
        uuid: proxy.uuid || '',
        password: proxy.password || '',
        tls: { ...base.tls, enabled: true },
      });
    case 'socks5':
    case 'socks':
      return finalize({ ...base, type: 'socks', username: proxy.username || '', password: proxy.password || '' });
    case 'http':
      return finalize({ ...base, type: 'http', username: proxy.username || '', password: proxy.password || '' });
    default:
      throw new NodeParseError(`暂不支持该协议: ${proxy.type}`);
  }
}

/**
 * 节点 -> sing-box outbound
 * @param {object} node 统一节点
 * @param {{tag?: string, resolveServer?: boolean}} options
 */
function nodeToOutbound(node, options = {}) {
  validateNode(node);
  const tag = options.tag || node.name;
  const outbound = { type: node.type, tag, server: node.server, server_port: node.port };

  const tls = {};
  if (node.tls && node.tls.enabled) {
    tls.enabled = true;
    if (node.tls.sni) tls.server_name = node.tls.sni;
    if (node.tls.insecure || node.tls.allowInsecure) tls.insecure = true;
    if (node.tls.alpn && node.tls.alpn.length) tls.alpn = node.tls.alpn;
    if (node.tls.fingerprint) tls.utls = { enabled: true, fingerprint: node.tls.fingerprint };
    if (node.tls.realityPublicKey) {
      tls.reality = { enabled: true, public_key: node.tls.realityPublicKey };
      if (node.tls.realityShortId) tls.reality.short_id = node.tls.realityShortId;
    }
  }

  const transport = {};
  if (node.transport && node.transport.type && node.transport.type !== 'tcp') {
    const type = node.transport.type;
    transport.type = type;
    if (type === 'ws') {
      if (node.transport.path) transport.path = node.transport.path;
      const host = node.transport.host || (node.tls && node.tls.sni);
      if (host) transport.headers = { Host: host };
    } else if (type === 'grpc') {
      transport.service_name = node.transport.serviceName || node.transport.path || '';
    } else if (type === 'http') {
      if (node.transport.host) transport.host = [node.transport.host];
      if (node.transport.path) transport.path = node.transport.path;
    } else if (type === 'httpupgrade') {
      transport.host = node.transport.host || '';
      transport.path = node.transport.path || '';
    }
  }

  switch (node.type) {
    case 'vless':
      outbound.uuid = node.uuid;
      if (node.flow) outbound.flow = node.flow;
      if (Object.keys(tls).length) outbound.tls = tls;
      if (Object.keys(transport).length) outbound.transport = transport;
      break;
    case 'vmess':
      outbound.uuid = node.uuid;
      outbound.security = node.method || 'auto';
      if (Object.keys(tls).length) outbound.tls = tls;
      if (Object.keys(transport).length) outbound.transport = transport;
      break;
    case 'trojan':
      outbound.password = node.password;
      outbound.tls = Object.keys(tls).length ? tls : { enabled: true };
      if (Object.keys(transport).length) outbound.transport = transport;
      break;
    case 'ss':
      outbound.method = node.method;
      outbound.password = node.password;
      if (Object.keys(transport).length) outbound.transport = transport;
      break;
    case 'socks':
    case 'http':
      if (node.username) outbound.username = node.username;
      if (node.password) outbound.password = node.password;
      if (node.type === 'http' && Object.keys(tls).length) outbound.tls = tls;
      break;
    case 'hysteria2':
      outbound.password = node.password;
      outbound.tls = Object.keys(tls).length ? tls : { enabled: true };
      if (node.extra && node.extra.obfs) {
        outbound.obfs = { type: node.extra.obfs, password: node.extra['obfs-password'] || '' };
      }
      break;
    case 'tuic':
      outbound.uuid = node.uuid;
      outbound.password = node.password;
      outbound.tls = Object.keys(tls).length ? tls : { enabled: true };
      break;
    default:
      throw new NodeParseError(`暂不支持导出该协议: ${node.type}`);
  }

  if (options.resolveServer === false) delete outbound.domain_resolver;
  return outbound;
}

module.exports = {
  NodeParseError,
  SUPPORTED_SCHEMES,
  validateNode,
  parseUri,
  parseClashProxy,
  nodeToOutbound,
  normalizeTransport,
};
