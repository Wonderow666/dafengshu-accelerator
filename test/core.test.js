'use strict';

/**
 * 单元测试：节点解析、订阅解析、配置生成。
 * 运行：npm test      （等价于 node --test test/）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');

const { parseUri, parseClashProxy, nodeToOutbound, NodeParseError } = require('../src/core/nodes');
const { parseSubscriptionContent, mergeNodes, parseSubscriptionHeaders, parseSimpleYaml } = require('../src/core/subscription');
const { buildConfig, accelerationSuffixes, splitDnsAddress } = require('../src/core/config');
const { decodeBase64Flexible } = require('../src/core/util');

const sampleNodes = [
  parseUri('vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls&sni=a.example.com&type=ws&path=%2Fws#节点A'),
  parseUri('trojan://pw@b.example.com:8443?security=tls&sni=b.example.com#节点B'),
  parseUri('ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@c.example.com:8388#节点C'),
];

// ── 节点解析 ─────────────────────────────────────────────────────────────
test('解析 vless 分享链接', () => {
  const node = sampleNodes[0];
  assert.strictEqual(node.type, 'vless');
  assert.strictEqual(node.server, 'a.example.com');
  assert.strictEqual(node.port, 443);
  assert.strictEqual(node.tls.enabled, true);
  assert.strictEqual(node.tls.sni, 'a.example.com');
  assert.strictEqual(node.transport.type, 'ws');
  assert.strictEqual(node.transport.path, '/ws');
  assert.strictEqual(node.name, '节点A');
  assert.ok(node.id.length >= 8);
});

test('解析 vmess 链接（base64 JSON）', () => {
  const payload = {
    v: '2',
    ps: 'VM 节点',
    add: 'd.example.com',
    port: '443',
    id: '11111111-2222-3333-4444-555555555555',
    aid: '0',
    scy: 'auto',
    net: 'grpc',
    path: 'grpcsvc',
    tls: 'tls',
    sni: 'd.example.com',
  };
  const node = parseUri(`vmess://${Buffer.from(JSON.stringify(payload)).toString('base64')}`);
  assert.strictEqual(node.type, 'vmess');
  assert.strictEqual(node.uuid, payload.id);
  assert.strictEqual(node.transport.type, 'grpc');
  assert.strictEqual(node.name, 'VM 节点');
});

test('解析 ss 与 hysteria2 链接', () => {
  const ss = sampleNodes[2];
  assert.strictEqual(ss.type, 'ss');
  assert.strictEqual(ss.method, 'aes-256-gcm');
  assert.strictEqual(ss.password, 'password');

  const hy2 = parseUri('hysteria2://letmein@e.example.com:8443?sni=e.example.com&insecure=1#HY2');
  assert.strictEqual(hy2.type, 'hysteria2');
  assert.strictEqual(hy2.password, 'letmein');
  assert.strictEqual(hy2.tls.insecure, true);
});

test('拒绝不支持的协议并给出可读错误', () => {
  assert.throws(() => parseUri('ssr://whatever'), NodeParseError);
  assert.throws(() => parseUri('hysteria://x@1.2.3.4:443'), /hysteria v1/);
  assert.throws(() => parseUri('vless://uuid@host'), /端口/);
});

test('Clash proxies 对象转节点（含嵌套字段）', () => {
  const node = parseClashProxy({
    name: 'clash 节点',
    type: 'vless',
    server: 'f.example.com',
    port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    tls: true,
    servername: 'f.example.com',
    network: 'ws',
    'ws-opts': { path: '/path', headers: { Host: 'f.example.com' } },
    'client-fingerprint': 'chrome',
  });
  assert.strictEqual(node.transport.path, '/path');
  assert.strictEqual(node.tls.fingerprint, 'chrome');
  assert.strictEqual(node.tls.sni, 'f.example.com');
});

// ── 出站转换 ─────────────────────────────────────────────────────────────
test('节点转 sing-box 出站', () => {
  const outbound = nodeToOutbound(sampleNodes[0], { tag: 'node-0' });
  assert.strictEqual(outbound.type, 'vless');
  assert.strictEqual(outbound.tag, 'node-0');
  assert.strictEqual(outbound.server_port, 443);
  assert.strictEqual(outbound.tls.enabled, true);
  assert.strictEqual(outbound.transport.type, 'ws');
  assert.strictEqual(outbound.transport.headers.Host, 'a.example.com');
});

// ── 订阅解析 ─────────────────────────────────────────────────────────────
test('解析明文链接列表订阅', () => {
  const text = [
    'vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls#A',
    '# 这是注释',
    'trojan://pw@b.example.com:443?security=tls#B',
    '',
  ].join('\n');
  const result = parseSubscriptionContent(text);
  assert.strictEqual(result.nodes.length, 2);
  assert.strictEqual(result.format, 'uri-list');
});

test('解析 base64 订阅', () => {
  const text = 'vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls#A\ntrojan://pw@b.example.com:443#B';
  const result = parseSubscriptionContent(Buffer.from(text).toString('base64'));
  assert.strictEqual(result.nodes.length, 2);
  assert.strictEqual(result.format, 'base64-uri-list');
});

test('解析 Clash YAML 订阅（含缩进嵌套）', () => {
  const yaml = [
    'port: 7890',
    'proxies:',
    '  - name: "香港 01"',
    '    type: trojan',
    '    server: hk.example.com',
    '    port: 443',
    '    password: pw',
    '    skip-cert-verify: true',
    '    alpn: [h2, http/1.1]',
    '  - name: "日本 01"',
    '    type: vless',
    '    server: jp.example.com',
    '    port: 443',
    '    uuid: 11111111-2222-3333-4444-555555555555',
    '    tls: true',
    '    network: ws',
    '    ws-opts:',
    '      path: /ws',
    '      headers:',
    '        Host: jp.example.com',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    '      - "香港 01"',
  ].join('\n');
  const result = parseSubscriptionContent(yaml);
  assert.strictEqual(result.nodes.length, 2, '应解析出 2 个代理');
  assert.strictEqual(result.nodes[0].name, '香港 01');
  assert.deepStrictEqual(result.nodes[0].tls.alpn, ['h2', 'http/1.1']);
  assert.strictEqual(result.nodes[1].transport.path, '/ws');
  assert.strictEqual(result.nodes[1].transport.host, 'jp.example.com');
  assert.strictEqual(result.nodes[1].tls.enabled, true);
});

test('YAML 解析器处理嵌套映射与内联数组', () => {
  const parsed = parseSimpleYaml(['a:', '  b: 1', '  c:', '    d: true', 'list: [x, y, 3]'].join('\n'));
  assert.strictEqual(parsed.a.b, 1);
  assert.strictEqual(parsed.a.c.d, true);
  assert.deepStrictEqual(parsed.list, ['x', 'y', 3]);
});

test('订阅响应头解析出流量与到期时间', () => {
  const headers = new Map([
    ['subscription-userinfo', 'upload=1024; download=2048; total=107374182400; expire=1900000000'],
    ['profile-title', '我的机场'],
  ]);
  const info = parseSubscriptionHeaders({ get: (k) => headers.get(k) });
  assert.strictEqual(info.upload, 1024);
  assert.strictEqual(info.download, 2048);
  assert.strictEqual(info.total, 107374182400);
  assert.strictEqual(info.expire, 1900000000);
  assert.strictEqual(info.title, '我的机场');
});

test('合并订阅节点：去重 + 同名加后缀 + 保留手动节点', () => {
  const existing = [{ id: 'manual1', name: '手工节点', from: 'manual' }];
  const incoming = [
    { id: 'a', name: '香港', from: '' },
    { id: 'b', name: '香港', from: '' },
  ];
  const merged = mergeNodes(existing, incoming, { source: 'subscription' });
  assert.strictEqual(merged.nodes.length, 3);
  assert.strictEqual(merged.added, 2);
  const names = merged.nodes.map((n) => n.name);
  assert.ok(names.includes('香港'));
  assert.ok(names.includes('香港 (2)'), '同名节点应加后缀区分');
  assert.strictEqual(merged.nodes[0].from, 'manual', '手动节点应保留');
});

// ── 配置生成 ─────────────────────────────────────────────────────────────
const buildOptions = {
  schema: 'legacy',
  // 用内置 geo 库模式，便于断言 geosite/geoip 规则（实际运行时由 App 决定数据源）
  allowLegacyGeo: true,
  logFile: path.join(os.tmpdir(), 'dafengshu-test.log'),
};

test('配置生成：入站/出站/开关正确', () => {
  const { config, meta } = buildConfig(
    { settings: { tun: { enabled: true } }, nodes: sampleNodes, selectedNodeId: sampleNodes[1].id },
    buildOptions
  );
  assert.strictEqual(meta.selectedNode.name, '节点B');
  assert.ok(config.inbounds.some((i) => i.type === 'mixed'));
  assert.ok(config.inbounds.some((i) => i.type === 'tun'));
  const selector = config.outbounds.find((o) => o.tag === 'proxy');
  assert.strictEqual(selector.type, 'selector');
  assert.strictEqual(selector.default, meta.selectedTag, 'selector 默认项应指向选中节点');
  assert.ok(config.outbounds.some((o) => o.tag === 'direct'));
  assert.ok(config.outbounds.some((o) => o.tag === 'block'));
});

test('配置生成：Twitter 域名优先级高于国内直连', () => {
  const { config } = buildConfig({ settings: {}, nodes: sampleNodes }, buildOptions);
  const twitterIndex = config.route.rules.findIndex(
    (r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('x.com')
  );
  const chinaIndex = config.route.rules.findIndex((r) => r.geosite && r.geosite.includes('cn'));
  assert.ok(twitterIndex >= 0 && chinaIndex >= 0);
  assert.ok(twitterIndex < chinaIndex, 'x.com 规则必须排在 geosite:cn 之前');
});

test('配置生成：用本地规则集时不引用未定义的 rule_set', () => {
  const files = { geositeCn: 'C:/tmp/geosite-cn.srs', geoipCn: 'C:/tmp/geoip-cn.srs' };
  const { config, meta } = buildConfig({ settings: {}, nodes: sampleNodes }, { schema: 'legacy', geoFiles: files });
  assert.strictEqual(meta.routing.geo, 'ruleset');
  const defined = new Set((config.route.rule_set || []).map((r) => r.tag));
  assert.deepStrictEqual([...defined].sort(), ['geoipCn', 'geositeCn']);
  assert.ok(config.route.rule_set.every((r) => r.type === 'local' && r.path), '本地规则集必须给出文件路径');
  for (const rule of [...config.route.rules, ...config.dns.rules]) {
    for (const tag of [].concat(rule.rule_set || [])) {
      assert.ok(defined.has(tag), `规则集 ${tag} 未在 route.rule_set 里定义，内核会启动失败`);
    }
  }
});

test('配置生成：拿不到规则集时回退到内置域名后缀表', () => {
  const { config, meta } = buildConfig({ settings: {}, nodes: sampleNodes }, { schema: 'legacy', geoFiles: {} });
  assert.strictEqual(meta.routing.geo, 'suffix');
  assert.ok(!config.route.rule_set || config.route.rule_set.length === 0, '回退模式不应带 rule_set');
  const suffixRule = config.route.rules.find((r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('qq.com'));
  assert.ok(suffixRule, '回退模式应使用内置国内域名表');
});

test('配置生成：x.com 用加密 DNS 解析', () => {
  const { config } = buildConfig({ settings: {}, nodes: sampleNodes }, buildOptions);
  const rule = config.dns.rules.find((r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('x.com'));
  assert.strictEqual(rule.server, 'dns-remote');
  const remote = config.dns.servers.find((s) => s.tag === 'dns-remote');
  assert.ok(/^https:\/\//.test(remote.address), '远程 DNS 必须是加密的 DoH');
});

test('legacy 与 modern 两套语法不混用字段', () => {
  const legacy = buildConfig({ settings: {}, nodes: sampleNodes }, { schema: 'legacy' }).config;
  const modern = buildConfig({ settings: {}, nodes: sampleNodes }, { schema: 'modern' }).config;

  assert.ok(legacy.dns.servers.every((s) => s.address), 'legacy 用 address');
  assert.ok(legacy.dns.servers.every((s) => !s.type), 'legacy 不应出现 type');
  assert.ok(modern.dns.servers.every((s) => s.type && s.server), 'modern 用 type + server');
  assert.ok(modern.dns.servers.every((s) => !s.address), 'modern 不应出现 address');
  assert.ok(modern.route.default_domain_resolver, 'modern 需要 default_domain_resolver');
  assert.ok(!legacy.route.default_domain_resolver, 'legacy 不支持 default_domain_resolver');
  assert.ok(
    legacy.dns.rules.every((r) => Object.keys(r).some((k) => !['server', 'action'].includes(k))),
    'DNS 规则必须带匹配条件'
  );
});

test('配置生成：拒绝空节点与损坏节点', () => {
  assert.throws(() => buildConfig({ settings: {}, nodes: [] }, buildOptions), /还没有任何节点/);
  assert.throws(
    () => buildConfig({ settings: {}, nodes: [{ id: 'x', name: '坏的', type: 'vless' }] }, buildOptions),
    /配置不完整/
  );
});

test('加速域名：内置 Twitter 且支持自定义后缀', () => {
  const suffixes = accelerationSuffixes({
    categories: ['twitter', 'youtube'],
    customSuffixes: ['*.myapp.io', '.example.com'],
  });
  assert.ok(suffixes.includes('x.com'));
  assert.ok(suffixes.includes('twitter.com'));
  assert.ok(suffixes.includes('youtube.com'));
  assert.ok(suffixes.includes('myapp.io'), '应去掉 *. 前缀');
  assert.ok(suffixes.includes('example.com'), '应去掉 . 前缀');
});

test('DNS 地址解析（modern 语法需要纯主机名）', () => {
  assert.strictEqual(splitDnsAddress('https://1.1.1.1/dns-query'), '1.1.1.1');
  assert.strictEqual(splitDnsAddress('tls://8.8.8.8'), '8.8.8.8');
  assert.strictEqual(splitDnsAddress('223.5.5.5'), '223.5.5.5');
});

test('base64 宽松解码', () => {
  assert.strictEqual(decodeBase64Flexible(Buffer.from('hello').toString('base64')), 'hello');
  assert.strictEqual(decodeBase64Flexible('aGVsbG8'), 'hello', '缺少 padding 也应解出');
  assert.strictEqual(decodeBase64Flexible('这不是 base64!!!'), '');
});
