'use strict';

/**
 * 验证打包产物能否「开箱即用」：
 *   1. 内核能按 resources/bin 布局被找到并执行
 *   2. 随包内置的规则集能被识别为分流数据源
 *   3. 用一个临时数据目录（模拟全新用户），能生成配置并通过内核校验
 *
 * 用法: DAFENGSHU_RESOURCES=<dist>/resources node scripts/verify-packaged.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const kernel = require('../src/core/kernel');
const geo = require('../src/core/geo');
const { resourcesDir, paths, binDir } = require('../src/core/paths');
const { CoreProcess } = require('../src/core/process');
const { App } = require('../src/core/app');
const { parseUri } = require('../src/core/nodes');

async function main() {
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  console.log(`资源目录: ${resourcesDir()}`);
  console.log(`数据目录: ${paths().home}\n`);

  // 1. 内核
  const binary = kernel.installed();
  record('在 resources/bin 找到 sing-box 内核', Boolean(binary), binary || binDir());
  if (binary) {
    const version = await kernel.getVersion(binary);
    record('内核可执行并返回版本', Boolean(version), String(version));
  }

  // 2. 随包规则集
  const bundled = { geositeCn: geo.bundledRuleSet('geositeCn'), geoipCn: geo.bundledRuleSet('geoipCn') };
  record('随包内置 geosite-cn 规则集', Boolean(bundled.geositeCn), bundled.geositeCn || '(缺失)');
  record('随包内置 geoip-cn 规则集', Boolean(bundled.geoipCn), bundled.geoipCn || '(缺失)');

  const available = geo.availableRuleSets();
  record('规则集可被识别为可用数据源', Boolean(available.geositeCn && available.geoipCn));

  // 3. 模拟全新用户：全新数据目录 + 一个临时节点，生成配置并用内核校验
  const node = parseUri('trojan://test-password@example.com:443?security=tls&sni=example.com#打包验证节点');
  const app = new App();
  app.store.addNodes([node]);
  record('临时节点写入成功', app.store.state.nodes.length === 1);

  const resolved = await app.resolveGeo(app.store.state.settings);
  record('geo 数据源解析为 ruleset（无需联网下载）', Object.keys(resolved.files).length === 2, Object.keys(resolved.files).join(', '));

  const { config, meta } = await app.buildConfigOnly();
  record('配置分流依据为内置规则集', meta.routing.geo === 'ruleset', meta.routing.geo);
  record('配置语法自适应结果', Boolean(meta.schema), meta.schema);

  if (binary) {
    const core = new CoreProcess({ binary, configFile: paths().configFile, clashApiPort: 9090 });
    const check = await core.validate(config);
    record('打包版生成的配置通过 sing-box 校验', check.ok, check.ok ? '' : check.output.split('\n')[0]);
  }

  await app.dispose().catch(() => {});

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 项通过`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`验证失败: ${error.message}`);
  process.exitCode = 1;
});
