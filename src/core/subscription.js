'use strict';

/**
 * 订阅解析：把「订阅正文」变成节点数组。
 * 依次尝试：明文链接 / base64 正文 / Clash(mihomo) YAML 或 JSON / 纯 JSON 节点数组。
 */

const { decodeBase64Flexible, looksLikeBase64Blob, safeJson } = require('./util');
const { parseUri, parseClashProxy, NodeParseError } = require('./nodes');

/** 订阅里的 UA 常被机场用来区分返回格式，这里统一用 Clash 的 UA（最容易被识别成标准订阅） */
const SUBSCRIPTION_UA =
  'clash-verge/v1.6.6 mihomo/1.18.0 Clash/1.18.0';

function coerceScalar(value) {
  let s = String(value).trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((v) => coerceScalar(v))
      .filter((v) => v !== '');
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return '';
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

/**
 * 极简 YAML 解析器，只覆盖 Clash 订阅里 proxies 段用到的结构：
 * 列表项 + 嵌套映射 + 内联数组。不追求通用性，但对手写和机器生成的订阅都够用。
 */
function parseSimpleYaml(text) {
  const src = String(text).replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (const raw of src) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    lines.push({ text: raw.replace(/\s+$/, ''), indent: (raw.match(/^( *)/) || ['', ''])[1].length });
  }

  function keyValue(content) {
    const idx = content.indexOf(':');
    if (idx <= 0) return null;
    return { key: content.slice(0, idx).trim(), rest: content.slice(idx + 1).trim() };
  }

  /** 一个块的内容直到缩进小于等于 parentIndent */
  function untilDedent(pos, parentIndent) {
    const inner = [];
    while (pos < lines.length && lines[pos].indent > parentIndent) {
      inner.push(lines[pos].text);
      pos += 1;
    }
    return { text: inner.join('\n'), pos };
  }  function parseMap(pos, stopIndent) {
    const map = {};
    while (pos < lines.length) {
      if (lines[pos].indent <= stopIndent) break;
      const kv = keyValue(lines[pos].text.trim());
      const indent = lines[pos].indent;
      pos += 1;
      if (!kv) continue;
      if (kv.rest !== '') {
        map[kv.key] = coerceScalar(kv.rest);
        continue;
      }
      if (pos < lines.length && lines[pos].indent > indent) {
        const child = parseBlock(pos, indent);
        map[kv.key] = child.value;
        pos = child.pos;
      } else {
        map[kv.key] = '';
      }
    }
    return { value: map, pos };
  }

  function parseList(pos, stopIndent) {
    const list = [];
    while (pos < lines.length) {
      const dashLine = lines[pos];
      if (dashLine.indent < stopIndent) break;
      if (!/^-\s/.test(dashLine.text.trim())) break;
      const dashIndent = dashLine.indent;
      const inline = dashLine.text.trim().replace(/^-\s*/, '');
      pos += 1;
      const item = {};
      let pendingKey = null;
      // 列表项的键通常缩进在破折号之后（"- name: x\n  type: y"），基准取键的缩进而非破折号缩进
      let contentIndent = dashIndent + 2;

      const kv = inline ? keyValue(inline) : null;
      if (kv) {
        if (kv.rest !== '') item[kv.key] = coerceScalar(kv.rest);
        else pendingKey = kv.key;
      }

      while (pos < lines.length) {
        const line = lines[pos];
        if (line.indent <= dashIndent) break;
        if (/^-\s/.test(line.text.trim())) break;
        if (Object.keys(item).length || pendingKey !== null) contentIndent = line.indent;
        const kv2 = keyValue(line.text.trim());
        const lineIndent = line.indent;
        pos += 1;
        if (!kv2) continue;
        if (kv2.rest !== '') {
          item[kv2.key] = coerceScalar(kv2.rest);
          pendingKey = null;
          continue;
        }
        if (pos < lines.length && lines[pos].indent > lineIndent) {
          const child = parseBlock(pos, lineIndent);
          item[kv2.key] = child.value;
          pos = child.pos;
        } else {
          item[kv2.key] = '';
        }
        pendingKey = null;
      }

      if (pendingKey !== null) item[pendingKey] = '';
      list.push(item);
    }
    return { value: list, pos };
  }

  /** 看下一行决定这个块是列表还是映射 */
  function parseBlock(pos, parentIndent) {
    // 注意：这里不能用 untilDedent 预扫后再交给 parseList/parseMap —— 那会把游标推到块尾。
    // 只需看第一行的内容判断块类型。
    const firstContent = lines[pos] ? lines[pos].text.trim() : '';
    if (/^-\s/.test(firstContent)) {
      return parseList(pos, lines[pos].indent);
    }
    return parseMap(pos, parentIndent);
  }

  const root = {};
  let pos = 0;
  while (pos < lines.length) {
    if (lines[pos].indent !== 0) {
      pos += 1;
      continue;
    }
    const kv = keyValue(lines[pos].text.trim());
    const indent = lines[pos].indent;
    pos += 1;
    if (!kv) continue;
    if (kv.rest !== '') {
      root[kv.key] = coerceScalar(kv.rest);
      continue;
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      const child = parseBlock(pos, indent);
      root[kv.key] = child.value;
      pos = child.pos;
    } else {
      root[kv.key] = '';
    }
  }
  return root;
}

function extractUris(text) {
  return String(text)
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /^[a-z0-9+.-]+:\/\//i.test(line));
}

function parseFromUriList(text) {
  const nodes = [];
  const errors = [];
  for (const uri of extractUris(text)) {
    try {
      nodes.push(parseUri(uri));
    } catch (error) {
      errors.push(`${String(uri).slice(0, 48)}… → ${error.message}`);
    }
  }
  return { nodes, errors };
}

function parseFromClashObject(proxies) {
  const nodes = [];
  const errors = [];
  if (!Array.isArray(proxies)) return { nodes, errors };
  proxies.forEach((proxy, index) => {
    try {
      nodes.push(parseClashProxy(proxy));
    } catch (error) {
      errors.push(`proxies[${index}] ${proxy && proxy.name ? proxy.name : ''} → ${error.message}`);
    }
  });
  return { nodes, errors };
}

/**
 * @param {string} content 订阅正文
 * @returns {{nodes: object[], errors: string[], format: string}}
 */
function parseSubscriptionContent(content) {
  const text = String(content || '');
  if (!text.trim()) return { nodes: [], errors: ['订阅内容为空'], format: 'empty' };

  // 1) 明文链接
  let result = parseFromUriList(text);
  if (result.nodes.length) return { ...result, format: 'uri-list' };

  // 2) base64 正文
  if (looksLikeBase64Blob(text) || !/^[\s\S]*:\s/.test(text)) {
    const decoded = decodeBase64Flexible(text);
    if (decoded) {
      const fromDecoded = parseFromUriList(decoded);
      if (fromDecoded.nodes.length) return { ...fromDecoded, format: 'base64-uri-list' };
      const clash = tryClash(decoded);
      if (clash.nodes.length) return { ...clash, format: 'base64-clash' };
    }
  }

  // 3) Clash YAML / JSON
  const clash = tryClash(text);
  if (clash.nodes.length) return { ...clash, format: 'clash' };

  // 4) 纯 JSON 节点数组
  const json = safeJson(text);
  if (Array.isArray(json)) {
    const fromJson = json
      .map((item) => {
        try {
          return typeof item === 'string' ? parseUri(item) : parseClashProxy(item);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (fromJson.length) return { nodes: fromJson, errors: [], format: 'json-nodes' };
  }

  return {
    nodes: [],
    errors: result.errors.length ? result.errors : ['无法识别订阅格式（既不是链接列表，也不是 Clash 订阅）'],
    format: 'unknown',
  };
}

function tryClash(text) {
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{')) {
    const json = safeJson(trimmed);
    if (json && Array.isArray(json.proxies)) return parseFromClashObject(json.proxies);
  }
  if (!/^\s*proxies\s*:/m.test(trimmed)) return { nodes: [], errors: [] };
  try {
    const yaml = parseSimpleYaml(trimmed);
    return parseFromClashObject(yaml.proxies);
  } catch (error) {
    return { nodes: [], errors: [`Clash 订阅解析失败: ${error.message}`] };
  }
}

/** 订阅响应头里机场常放的流量/到期信息 */
function parseSubscriptionHeaders(headers) {
  const get = (name) => {
    const value = headers && (headers.get ? headers.get(name) : headers[name]);
    return value == null ? '' : String(value);
  };
  const info = {
    upload: Number.parseInt(get('subscription-userinfo').match(/upload=(\d+)/)?.[1] || '0', 10),
    download: Number.parseInt(get('subscription-userinfo').match(/download=(\d+)/)?.[1] || '0', 10),
    total: Number.parseInt(get('subscription-userinfo').match(/total=(\d+)/)?.[1] || '0', 10),
    expire: Number.parseInt(get('subscription-userinfo').match(/expire=(\d+)/)?.[1] || '0', 10),
    title: get('profile-title').replace(/^base64:/i, '') || '',
  };
  if (info.title && /^[A-Za-z0-9+/=]+$/.test(info.title)) {
    info.title = decodeBase64Flexible(info.title) || info.title;
  }
  return info;
}

/**
 * 把新节点并入现有列表：用户手动添加的节点不动，订阅节点先按 id 去重、再按名字去重。
 * @param {object[]} existing
 * @param {object[]} incoming
 * @param {{source?: string}} options
 */
function mergeNodes(existing, incoming, options = {}) {
  const source = options.source || 'subscription';
  const manualNames = new Set(existing.filter((n) => n.from === 'manual').map((n) => n.name));
  const result = existing.slice();
  const byId = new Map(result.map((n) => [n.id, n]));
  const usedNames = new Set(result.map((n) => n.name));

  let added = 0;
  let updated = 0;

  for (const node of incoming) {
    const tagged = { ...node, from: source };
    const hit = byId.get(node.id);
    if (hit) {
      Object.assign(hit, tagged);
      updated += 1;
      continue;
    }
    let name = tagged.name;
    if (usedNames.has(name)) {
      if (manualNames.has(name)) {
        let n = 2;
        while (usedNames.has(`${name} (${n})`)) n += 1;
        name = `${name} (${n})`;
      } else {
        // 同名不同配置：保留两者，加后缀区分
        let n = 2;
        while (usedNames.has(`${name} (${n})`)) n += 1;
        name = `${name} (${n})`;
      }
    }
    const finalNode = { ...tagged, name };
    usedNames.add(name);
    byId.set(finalNode.id, finalNode);
    result.push(finalNode);
    added += 1;
  }
  return { nodes: result, added, updated };
}

function nodeSummary(node) {
  return `${node.name} · ${node.type} · ${node.server}:${node.port}`;
}

module.exports = {
  SUBSCRIPTION_UA,
  parseSimpleYaml,
  parseSubscriptionContent,
  parseSubscriptionHeaders,
  mergeNodes,
  nodeSummary,
  NodeParseError,
};
