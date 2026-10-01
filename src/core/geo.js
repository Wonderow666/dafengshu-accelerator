'use strict';

/**
 * 规则集（rule-set）获取与 geo 数据源决策。
 *
 * 背景：sing-box 从 1.8 起弃用内置 geosite/geoip，1.12 起彻底移除：
 *   - `geosite: ['cn']` / `geoip: ['cn']` 需要环境变量 ENABLE_DEPRECATED_GEOIP/GEOSITE=true 才能用；
 *   - 官方推荐改用 rule-set（.srs 文件），既可远程下载也可本地缓存。
 *
 * 麻烦之处：GeoIp/GeoSite 规则集的官方源（raw.githubusercontent.com、jsdelivr）
 * 在国内往往直连不通 —— 而「首次运行还没有可用代理」正是需要它的时刻。
 *
 * 所以这里做两件事：
 *   1. 用多个镜像源把 .srs 下载到本地缓存，之后完全离线可用（且 1.12+ 也能用）；
 *   2. 下载失败时自动回退到内置 geo 库并设置所需环境变量（保证首次也能跑通）。
 */

const fs = require('fs');
const path = require('path');
const { ensureDir, paths, builtinRuleSetsDir } = require('./paths');

const RULE_SETS = {
  geositeCn: {
    file: 'geosite-cn.srs',
    label: '国内域名库 (geosite-cn)',
    paths: ['rule-set/geosite-cn.srs', 'SagerNet/sing-geosite'],
  },
  geoipCn: {
    file: 'geoip-cn.srs',
    label: '国内 IP 库 (geoip-cn)',
    paths: ['rule-set/geoip-cn.srs', 'SagerNet/sing-geoip'],
  },
};

/** 镜像模板：{repo} 形如 SagerNet/sing-geosite，{filePath} 形如 rule-set/geosite-cn.srs */
const MIRRORS = [
  (repo, filePath) => `https://raw.githubusercontent.com/${repo}/rule-set/${filePath.replace('rule-set/', '')}`,
  (repo, filePath) => `https://cdn.jsdelivr.net/gh/${repo}@rule-set/${filePath.replace('rule-set/', '')}`,
  (repo, filePath) => `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/rule-set/${filePath.replace('rule-set/', '')}`,
  (repo, filePath) => `https://ghfast.top/https://raw.githubusercontent.com/${repo}/rule-set/${filePath.replace('rule-set/', '')}`,
  (repo, filePath) => `https://ghproxy.net/https://raw.githubusercontent.com/${repo}/rule-set/${filePath.replace('rule-set/', '')}`,
];

/** 使用内置 geo 库时必须设置的环境变量（sing-box 1.8+ 的弃用开关） */
const LEGACY_GEO_ENV = { ENABLE_DEPRECATED_GEOIP: 'true', ENABLE_DEPRECATED_GEOSITE: 'true' };

function ruleSetDir() {
  return ensureDir(path.join(paths().cache, 'ruleset'));
}

/** 用户缓存里的规则集（可更新） */
function cachedRuleSet(tag) {
  const meta = RULE_SETS[tag];
  if (!meta) return null;
  const file = path.join(paths().cache, 'ruleset', meta.file);
  return fs.existsSync(file) && fs.statSync(file).size > 1024 ? file : null;
}

/** 随包内置的规则集（只读，保证首次运行也能离线分流） */
function bundledRuleSet(tag) {
  const meta = RULE_SETS[tag];
  if (!meta) return null;
  const file = path.join(builtinRuleSetsDir(), meta.file);
  return fs.existsSync(file) && fs.statSync(file).size > 1024 ? file : null;
}

/** 优先级：用户缓存（较新） → 随包内置 */
function localRuleSetFile(tag) {
  return cachedRuleSet(tag) || bundledRuleSet(tag);
}

/** 已缓存的规则集（可用于生成配置） */
function availableRuleSets() {
  const result = {};
  for (const tag of Object.keys(RULE_SETS)) {
    const file = localRuleSetFile(tag);
    if (file) result[tag] = file;
  }
  return result;
}

async function downloadOne(tag, options = {}) {
  const meta = RULE_SETS[tag];
  // 下载永远写入用户缓存目录，不去动只读的随包资源
  const target = path.join(ruleSetDir(), meta.file);

  const existing = localRuleSetFile(tag);
  if (existing && !options.force) {
    return {
      tag,
      ok: true,
      cached: true,
      file: existing,
      size: fs.statSync(existing).size,
      bundled: existing === bundledRuleSet(tag),
    };
  }

  const timeout = options.timeout || 12000;
  const errors = [];
  for (const build of MIRRORS) {
    const url = build(meta.paths[1], meta.paths[0]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'dafengshu-accelerator' },
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1024) throw new Error('内容过小，可能是错误页');
      fs.writeFileSync(target, buffer);
      return { tag, ok: true, file: target, size: buffer.length, source: new URL(url).host };
    } catch (error) {
      clearTimeout(timer);
      errors.push(`${new URL(url).host}: ${error.name === 'AbortError' ? '超时' : error.message}`);
    }
  }
  return { tag, ok: false, errors };
}

/**
 * 尝试把所有需要的规则集准备好。
 * @returns {Promise<{ok: boolean, files: Record<string,string>, legacyEnv: Record<string,string>, results: object[]}>}
 */
async function ensureRuleSets(options = {}) {
  const log = options.log || { info() {}, warn() {} };
  const results = [];
  for (const tag of Object.keys(RULE_SETS)) {
    const result = await downloadOne(tag, options);
    results.push(result);
    if (result.ok) {
      log.info(
        `规则集就绪: ${RULE_SETS[tag].label}${result.cached ? (result.bundled ? '（随包内置）' : '（本地缓存）') : ` ← ${result.source}`}`
      );
    } else {
      log.warn(`规则集下载失败: ${RULE_SETS[tag].label}`);
    }
  }

  const files = availableRuleSets();
  const ok = Object.keys(files).length === Object.keys(RULE_SETS).length;
  return {
    ok,
    files,
    // 回退方案需要这两个环境变量，否则内核会 FATAL 退出
    legacyEnv: { ENABLE_DEPRECATED_GEOIP: 'true', ENABLE_DEPRECATED_GEOSITE: 'true' },
    results,
  };
}

module.exports = {
  RULE_SETS,
  MIRRORS,
  LEGACY_GEO_ENV,
  availableRuleSets,
  cachedRuleSet,
  bundledRuleSet,
  localRuleSetFile,
  ensureRuleSets,
  ruleSetDir,
};
