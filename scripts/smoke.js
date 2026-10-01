'use strict';

/**
 * 冒烟检查：不启动内核，只验证「节点解析 → 配置生成」这条链路。
 * 用法: node scripts/smoke.js
 */

const assert = require('assert');
const { parseUri } = require('../src/core/nodes');
const { parseSubscriptionContent } = require('../src/core/subscription');
const { buildConfig } = require('../src/core/config');

const samples = [
  'vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=tls&sni=example.com&type=ws&path=%2Fws&host=example.com&fp=chrome#东京-测试节点',
  // vmess 链接是 base64(JSON)，这里按真实格式生成，避免手写出错
  'vmess://' +
    Buffer.from(
      JSON.stringify({
        v: '2',
        ps: '美国-测试节点',
        add: '1.2.3.4',
        port: '443',
        id: '11111111-2222-3333-4444-555555555555',
        aid: '0',
        scy: 'auto',
        net: 'ws',
        type: 'none',
        host: 'cdn.example.com',
        path: '/path',
        tls: 'tls',
        sni: 'cdn.example.com',
      })
    ).toString('base64'),
  'trojan://password123@trojan.example.com:443?security=tls&sni=trojan.example.com&type=grpc&serviceName=grpcsvc#香港-Trojan',
  'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@ss.example.com:8388#新加坡-SS',
  'hysteria2://letmein@hy2.example.com:8443?sni=hy2.example.com&insecure=1#日本-HY2',
  'tuic://11111111-2222-3333-4444-555555555555:letmein@tuic.example.com:443?sni=tuic.example.com&alpn=h3#韩国-TUIC',
];

const nodes = [];
for (const uri of samples) {
  const node = parseUri(uri);
  nodes.push(node);
  console.log(
    `✓ ${node.type.padEnd(9)} ${node.name.padEnd(18)} ${node.server}:${node.port} ` +
      `tls=${node.tls.enabled} transport=${node.transport.type}`
  );
}

const badInputs = ['ssr://whatever', 'hysteria://x@1.2.3.4:443', 'vless://not-a-uuid@host'];
for (const bad of badInputs) {
  try {
    parseUri(bad);
    throw new Error(`本应拒绝: ${bad}`);
  } catch (error) {
    console.log(`✓ 正确拒绝 ${bad.slice(0, 24)} → ${error.message}`);
  }
}

// Clash 订阅（含嵌套字段与内联数组）
const clashYaml = `
proxies:
  - name: "Clash 节点一"
    type: vless
    server: cf.example.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    tls: true
    servername: cf.example.com
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: cf.example.com
    client-fingerprint: chrome
  - name: "Clash 节点二"
    type: trojan
    server: t2.example.com
    port: 8443
    password: pw
    skip-cert-verify: true
    alpn: [h2, http/1.1]
`;
const clashResult = parseSubscriptionContent(clashYaml);
assert.strictEqual(clashResult.nodes.length, 2, 'Clash 订阅应解析出 2 个节点');
assert.strictEqual(clashResult.nodes[0].transport.type, 'ws', 'ws-opts.path 应被识别');
assert.strictEqual(clashResult.nodes[0].transport.path, '/ws', 'ws 路径应正确');
assert.strictEqual(clashResult.nodes[0].tls.fingerprint, 'chrome', 'client-fingerprint 应被识别');
assert.deepStrictEqual(clashResult.nodes[1].tls.alpn, ['h2', 'http/1.1'], '内联数组应被解析');
console.log(`✓ Clash 订阅解析出 ${clashResult.nodes.length} 个节点`);

// base64 订阅
const base64Sub = Buffer.from(samples.slice(0, 3).join('\n')).toString('base64');
const base64Result = parseSubscriptionContent(base64Sub);
assert.strictEqual(base64Result.nodes.length, 3, 'base64 订阅应解析出 3 个节点');
console.log(`✓ base64 订阅解析出 ${base64Result.nodes.length} 个节点 (${base64Result.format})`);

// 配置生成（新旧两套语法都要能生成）
const { config, meta, warnings } = buildConfig(
  {
    settings: {
      tun: { enabled: true },
      acceleration: { categories: ['twitter', 'youtube'] },
    },
    nodes,
    selectedNodeId: nodes[3].id,
  },
  { schema: 'legacy', allowLegacyGeo: true }
);

assert.strictEqual(meta.selectedNode.name, '新加坡-SS', '选中的节点应为第 4 个');
assert.ok(config.inbounds.some((i) => i.type === 'tun'), 'TUN 入站应存在');
assert.ok(config.inbounds.some((i) => i.type === 'mixed'), 'mixed 入站应存在');
assert.ok(config.outbounds.some((o) => o.tag === 'proxy' && o.type === 'selector'), 'selector 出站应存在');

const twitterRuleIndex = config.route.rules.findIndex(
  (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('x.com')
);
const chinaRuleIndex = config.route.rules.findIndex((r) => r.geosite && r.geosite.includes('cn'));
assert.ok(twitterRuleIndex >= 0, '应有 x.com 的强制代理规则');
assert.ok(chinaRuleIndex >= 0, '应有 geosite:cn 国内直连规则');
assert.ok(twitterRuleIndex < chinaRuleIndex, '加速域名规则必须早于国内直连规则（否则 X 会被判成直连）');

const dnsRemoteRule = config.dns.rules.find(
  (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('x.com')
);
assert.strictEqual(dnsRemoteRule.server, 'dns-remote', 'x.com 必须用加密 DNS 解析（防污染）');

const legacyDnsServer = config.dns.servers.find((s) => s.tag === 'dns-local');
assert.ok(legacyDnsServer.address, 'legacy 语法应使用 address 字段');
assert.ok(!legacyDnsServer.type, 'legacy 语法不应出现 type 字段（1.11 会 FATAL）');
assert.ok(
  config.dns.rules.every((r) => Object.keys(r).some((k) => !['server', 'action', 'outbound'].includes(k))),
  'DNS 规则必须带匹配条件（1.11 对无条件规则会报 missing conditions）'
);

// 本地规则集模式：必须引用已定义的 rule_set
const withRuleSets = buildConfig(
  { settings: {}, nodes, selectedNodeId: nodes[0].id },
  { schema: 'legacy', geoFiles: { geositeCn: 'C:/tmp/a.srs', geoipCn: 'C:/tmp/b.srs' } }
);
assert.strictEqual(withRuleSets.meta.routing.geo, 'ruleset');
const defined = new Set((withRuleSets.config.route.rule_set || []).map((r) => r.tag));
const referenced = [];
for (const rule of [...withRuleSets.config.route.rules, ...withRuleSets.config.dns.rules]) {
  for (const tag of [].concat(rule.rule_set || [])) referenced.push(tag);
}
assert.ok(referenced.length > 0, '规则集模式下应有 rule_set 引用');
for (const tag of referenced) assert.ok(defined.has(tag), `rule_set ${tag} 未定义`);
console.log('✓ 本地规则集模式引用完整');

// 现代语法（1.12+）
const modern = buildConfig(
  { settings: { acceleration: { categories: ['twitter'] } }, nodes, selectedNodeId: nodes[0].id },
  { schema: 'modern' }
);
assert.strictEqual(modern.config.dns.servers.find((s) => s.tag === 'dns-local').type, 'udp', 'modern 语法用 type 字段');
assert.ok(modern.config.route.default_domain_resolver, 'modern 语法应有 route.default_domain_resolver');
assert.ok(!modern.config.dns.servers.some((s) => s.address), 'modern 语法不应出现 address 字段');
console.log('✓ 新旧两套配置语法均可生成');

const json = JSON.stringify(config);
assert.ok(!json.includes('undefined'), '配置中不应出现 undefined');
assert.ok(json.length > 2000, '配置内容看起来太小，可能有生成问题');

// 引用完整性校验：这是内核能否成功启动的关键
const outboundTags = new Set(config.outbounds.map((o) => o.tag));
const dnsTags = new Set(config.dns.servers.map((s) => s.tag));
const refs = [];
for (const rule of [...config.route.rules, ...config.dns.rules]) {
  if (rule.outbound) refs.push({ kind: 'outbound', value: rule.outbound });
  for (const r of [].concat(rule.rule_set || [])) refs.push({ kind: 'rule_set', value: r });
  if (typeof rule.server === 'string' && rule.server.startsWith('dns-')) {
    refs.push({ kind: 'dns', value: rule.server });
  }
}
for (const ref of refs) {
  const pool = ref.kind === 'outbound' ? outboundTags : dnsTags;
  assert.ok(pool.has(ref.value), `配置引用了不存在的 ${ref.kind}: ${ref.value}`);
}
assert.ok(dnsTags.has('dns-local') && dnsTags.has('dns-remote'), '本地与远程 DNS 都应存在');

console.log(`✓ 配置生成成功：${config.outbounds.length} 个出站 / ${config.route.rules.length} 条路由规则 / ${config.dns.rules.length} 条 DNS 规则`);
console.log(`✓ 加速域名 ${meta.routing.accelerationSuffixes} 个，分流依据: ${meta.routing.geo}`);
if (warnings.length) console.log(`! 警告: ${warnings.join(' | ')}`);
console.log('\n全部冒烟检查通过 ✅');
