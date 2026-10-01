'use strict';

const crypto = require('crypto');

/** 稳定的短 id：同样的连接参数得到同样的 id（便于去重） */
function shortId(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 12);
}

function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 宽松的 base64 解码：支持 URL-safe 与缺失 padding，兼容 UTF-8 文本 */
function decodeBase64Flexible(input) {
  let s = String(input).trim().replace(/\s+/g, '');
  if (!s) return '';
  if (s.length % 4 === 1) s = s.slice(0, -1); // 非法长度，丢弃尾字符（常见于截断）
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return '';
  try {
    const buf = Buffer.from(s, 'base64');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    // 解码结果里出现大量替换字符说明这本来就不是 base64
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (bad > text.length / 10) return '';
    return text;
  } catch {
    return '';
  }
}

/** 看起来像 base64 编码的订阅正文？ */
function looksLikeBase64Blob(text) {
  const s = String(text).trim();
  if (s.length < 16) return false;
  if (s.includes('://')) return false;
  if (/\s/.test(s)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(s);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把 "a,b" / ["a","b"] / "a b" 之类统一成干净的字符串数组 */
function toStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function uniqueByName(items, key = 'name') {
  const seen = new Map();
  const out = [];
  for (const item of items) {
    const base = String(item[key] || '未命名').trim() || '未命名';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    out.push(count === 0 ? item : { ...item, [key]: `${base} (${count + 1})` });
  }
  return out;
}

/** 极简日志器：同时写文件与控制台，避免依赖 */
function createLogger(file) {
  const fs = require('fs');
  const lines = [];
  const maxMemory = 800;
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(require('path').dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch {
      stream = null;
    }
  }
  function write(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    lines.push(line);
    if (lines.length > maxMemory) lines.shift();
    if (stream) stream.write(line + '\n');
    if (process.env.DAFENGSHU_VERBOSE) console.log(line);
  }
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    tail: (n = 200) => lines.slice(-n),
    file: file || null,
    close: () => stream && stream.end(),
  };
}

module.exports = {
  shortId,
  randomId,
  decodeBase64Flexible,
  looksLikeBase64Blob,
  safeJson,
  toStringArray,
  uniqueByName,
  createLogger,
};
