'use strict';

/**
 * 探测当前 sing-box 版本接受的配置语法（DNS server 的新旧两种写法、TUN 字段等）。
 * 做法：把候选配置写进临时文件，逐个跑 `sing-box check`，看哪个被接受。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const kernel = require('../src/core/kernel');

const binary = kernel.installed();
if (!binary) {
  console.error('未找到 sing-box，请先运行 npm run fetch:core');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-probe-'));

function check(name, config) {
  const file = path.join(tmp, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return new Promise((resolve) => {
    execFile(binary, ['check', '-c', file], { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.replace(/\u001b\[\d+m/g, '').trim();
      resolve({ name, ok: !error && !output.includes('FATAL'), output });
    });
  });
}

const baseInbound = { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 };
const baseOutbound = [
  { type: 'direct', tag: 'direct' },
  { type: 'block', tag: 'block' },
];

const cases = [
  [
    'dns-legacy-address',
    {
      dns: {
        servers: [
          { tag: 'dns-local', address: '223.5.5.5', detour: 'direct' },
          { tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: 'direct', domain_resolver: 'dns-local' },
        ],
        rules: [{ domain_suffix: ['x.com'], server: 'dns-remote' }],
        final: 'dns-remote',
        strategy: 'prefer_ipv4',
      },
      inbounds: [baseInbound],
      outbounds: baseOutbound,
      route: { rules: [{ domain_suffix: ['x.com'], outbound: 'direct' }], final: 'direct' },
    },
  ],
  [
    'dns-new-typed',
    {
      dns: {
        servers: [
          { type: 'udp', tag: 'dns-local', server: '223.5.5.5', detour: 'direct' },
          { type: 'https', tag: 'dns-remote', server: '1.1.1.1', detour: 'direct', domain_resolver: 'dns-local' },
        ],
        rules: [{ domain_suffix: ['x.com'], server: 'dns-remote' }],
        final: 'dns-remote',
        strategy: 'prefer_ipv4',
      },
      inbounds: [baseInbound],
      outbounds: baseOutbound,
      route: { rules: [{ domain_suffix: ['x.com'], outbound: 'direct' }], final: 'direct' },
    },
  ],
  [
    'dns-legacy-plain-ip',
    {
      dns: {
        servers: ['223.5.5.5', 'https://1.1.1.1/dns-query'],
        rules: [{ domain_suffix: ['x.com'], server: 'https://1.1.1.1/dns-query' }],
      },
      inbounds: [baseInbound],
      outbounds: baseOutbound,
      route: { rules: [], final: 'direct' },
    },
  ],
  [
    'route-default-domain-resolver',
    {
      dns: { servers: [{ tag: 'dns-local', address: '223.5.5.5' }] },
      inbounds: [baseInbound],
      outbounds: baseOutbound,
      route: { rules: [], final: 'direct', default_domain_resolver: 'dns-local' },
    },
  ],
  [
    'outbound-domain-resolver',
    {
      dns: { servers: [{ tag: 'dns-local', address: '223.5.5.5' }] },
      inbounds: [baseInbound],
      outbounds: [{ type: 'direct', tag: 'direct', domain_resolver: 'dns-local' }, { type: 'block', tag: 'block' }],
      route: { rules: [], final: 'direct' },
    },
  ],
  [
    'tun-fields',
    {
      inbounds: [
        {
          type: 'tun',
          tag: 'tun-in',
          interface_name: 'dafengshu-tun',
          address: ['172.19.0.1/30'],
          mtu: 9000,
          auto_route: true,
          strict_route: false,
          stack: 'mixed',
          sniff: true,
          endpoint_independent_nat: false,
        },
      ],
      outbounds: baseOutbound,
      route: { rules: [], final: 'direct' },
    },
  ],
  [
    'route-actions-and-clash-mode',
    {
      inbounds: [baseInbound],
      outbounds: baseOutbound,
      route: {
        rules: [
          { action: 'sniff' },
          { clash_mode: 'direct', action: 'route', outbound: 'direct' },
          { ip_is_private: true, action: 'route', outbound: 'direct' },
          { domain_keyword: ['ads.example.com'], action: 'reject' },
        ],
        final: 'direct',
      },
      experimental: { clash_api: { external_controller: '127.0.0.1:9090', default_mode: 'rule' } },
    },
  ],
  [
    'dns-hosts-and-rule-set',
    {
      dns: {
        servers: [{ tag: 'dns-local', address: '223.5.5.5' }],
        hosts: { 'dns.alidns.com': ['223.5.5.5'] },
      },
      inbounds: [baseInbound],
      outbounds: baseOutbound,
      route: {
        rules: [{ rule_set: ['geositeCn'], outbound: 'direct' }],
        final: 'direct',
        rule_set: [
          {
            tag: 'geositeCn',
            type: 'remote',
            format: 'binary',
            url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs',
            download_detour: 'direct',
            update_interval: '7d',
          },
        ],
      },
    },
  ],
];

(async () => {
  const version = await kernel.getVersion(binary);
  console.log(`sing-box 版本: ${version}\n`);
  const results = [];
  for (const [name, config] of cases) {
    results.push(await check(name, config));
  }
  for (const r of results) {
    console.log(`${r.ok ? '✅ 接受' : '❌ 拒绝'}  ${r.name}`);
    if (!r.ok) console.log(`         ${r.output.split('\n').slice(0, 3).join('\n         ')}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
})();
