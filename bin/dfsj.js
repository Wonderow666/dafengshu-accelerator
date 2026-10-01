'use strict';

/**
 * 命令行入口：不启动图形界面也能完成全流程，
 * 同时也用于在无 Electron 环境下验证核心链路。
 *
 *   node bin/dfsj.js status
 *   node bin/dfsj.js add "vless://..."
 *   node bin/dfsj.js sub "https://机场订阅链接"
 *   node bin/dfsj.js check              生成配置并做语法校验
 *   node bin/dfsj.js start              前台启动加速（Ctrl+C 停止）
 *   node bin/dfsj.js start --tun --system-proxy
 *   node bin/dfsj.js test               全部节点测延迟
 *   node bin/dfsj.js twitter            检测 X/Twitter 是否可达
 *   node bin/dfsj.js kernel install
 *   node bin/dfsj.js logs
 */

const { App } = require('../src/core/app');
const { parseSubscriptionContent } = require('../src/core/subscription');

const args = process.argv.slice(2);
const command = args[0] || 'help';
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.slice(1).filter((a) => !a.startsWith('--'));

function out(...parts) {
  console.log(...parts);
}

function fmtTime(ts) {
  if (!ts) return '未知';
  return new Date(ts).toLocaleString('zh-CN');
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

async function withApp(fn) {
  const app = new App();
  try {
    return await fn(app);
  } finally {
    await app.dispose().catch(() => {});
  }
}

const commands = {
  async help() {
    out(`大枫树加速 · 命令行

用法: node bin/dfsj.js <命令> [参数] [--选项]

命令:
  status                      查看状态（内核、节点、订阅、系统代理）
  kernel [install|version]    安装或查看 sing-box 内核
  add <链接>                  添加单个节点（支持 vless/vmess/trojan/ss/hysteria2/tuic）
  sub <订阅链接>              拉取并合并订阅
  subs                        刷新全部订阅
  nodes                       列出节点
  use <序号|节点名>           切换节点
  rm <序号>                   删除节点
  reset                       清空所有节点与订阅（保留设置）
  check                       生成 sing-box 配置并校验（不启动）
  show                        打印生成的配置
  start                       前台启动加速（Ctrl+C 停止）
  test                        全部节点延迟测试
  twitter                     检测 X/Twitter 是否可达
  logs [行数]                 查看日志

选项:
  --tun                       使用 TUN 模式（接管全部流量，需要管理员权限）
  --system-proxy              设置 Windows 系统代理
  --no-system-proxy           不设置系统代理
  --proxy <地址>              先通过指定代理拉取订阅（引导用）
  --node <序号|名称>          指定节点
`);
  },

  async status(app) {
    await app.loadKernelVersion().catch(() => {});
    const snap = app.snapshot();
    const sysProxy = await app.systemProxyStatus();
    out('── 运行状态 ─────────────────────────────');
    out(`加速:        ${snap.runtime.running ? '运行中' : '已停止'}${snap.runtime.starting ? '（启动中）' : ''}`);
    if (snap.runtime.running) {
      out(`启动时间:    ${fmtTime(snap.runtime.startedAt)}`);
      out(`当前节点:    ${snap.runtime.meta ? snap.runtime.meta.selectedNode.name : '-'}`);
      out(`加速域名:    ${snap.runtime.meta ? snap.runtime.meta.routing.accelerationSuffixes : 0} 个`);
    }
    if (snap.runtime.error) out(`最近错误:    ${snap.runtime.error}`);
    out('── 内核 ─────────────────────────────────');
    out(`sing-box:    ${snap.kernel.installed ? `已安装 ${snap.kernel.version || ''}` : '未安装（首次启动会自动下载）'}`);
    out(`路径:        ${snap.kernel.path}`);
    out('── 环境 ─────────────────────────────────');
    out(`管理员权限:  ${snap.platform.isAdmin ? '是' : '否（TUN 模式需要）'}`);
    out(`系统代理:    ${sysProxy.enabled ? `已开启 ${sysProxy.server}` : '已关闭'}`);
    out(`数据目录:    ${snap.dataDir}`);
    out('── 节点 ─────────────────────────────────');
    if (!snap.nodes.length) {
      out('（还没有节点，用 add 或 sub 添加）');
    } else {
      snap.nodes.forEach((node, index) => {
        const mark = node.id === snap.selectedNodeId ? '*' : ' ';
        const delay = snap.delays[node.id] ? `${snap.delays[node.id]}ms` : '-';
        out(`${mark} ${String(index + 1).padStart(2)}. ${node.name}  [${node.type}] ${node.server}:${node.port}  延迟 ${delay}`);
      });
    }
    if (snap.subscriptions.length) {
      out('── 订阅 ─────────────────────────────────');
      for (const sub of snap.subscriptions) {
        out(`${sub.title || sub.url}`);
        out(`   节点 ${sub.nodeCount || 0} 个 · 更新于 ${fmtTime(sub.lastUpdate)}${sub.lastError ? ` · 错误: ${sub.lastError}` : ''}`);
        if (sub.traffic && sub.traffic.total) {
          out(`   流量 ${fmtBytes(sub.traffic.upload + sub.traffic.download)} / ${fmtBytes(sub.traffic.total)} · 到期 ${fmtTime(sub.traffic.expire * 1000)}`);
        }
      }
    }
  },

  async kernel(app, params) {
    const action = params[0] || 'install';
    if (action === 'version') {
      const { getVersion, binaryPath } = require('../src/core/kernel');
      out(`路径: ${binaryPath()}`);
      out(`版本: ${(await getVersion()) || '未安装'}`);
      return;
    }
    app.on('log', (line) => out(`  ${line}`));
    const result = await app.ensureKernel({ force: flags.has('--force') });
    out(JSON.stringify(result, null, 2));
  },

  async add(app, params) {
    const text = params.join(' ');
    if (!text) throw new Error('请提供节点链接，例如：node bin/dfsj.js add "vless://..."');
    const parsed = parseSubscriptionContent(text);
    const result = app.importFromText(text);
    out(`已解析 ${result.parsed} 个节点，新增 ${result.added} 个（共 ${result.total} 个）`);
    for (const node of parsed.nodes) out(`  + ${node.name} [${node.type}] ${node.server}:${node.port}`);
    if (result.errors.length) out(`  跳过: ${result.errors.slice(0, 5).join('; ')}`);
  },

  async sub(app, params) {
    const url = params[0];
    if (!url) throw new Error('请提供订阅链接');
    const result = await app.refreshSubscription(url);
    out(`订阅「${result.title}」更新完成：解析 ${result.nodeCount} 个，新增 ${result.added} 个，更新 ${result.updated} 个`);
  },

  async subs(app) {
    const results = await app.refreshAllSubscriptions();
    if (!results.length) out('还没有配置任何订阅');
    for (const r of results) out(r.ok ? `✓ ${r.url} → 新增 ${r.added}` : `✗ ${r.url} → ${r.error}`);
  },

  async nodes(app) {
    const snap = app.snapshot();
    if (!snap.nodes.length) {
      out('（还没有节点）');
      return;
    }
    snap.nodes.forEach((node, index) => {
      const mark = node.id === snap.selectedNodeId ? '*' : ' ';
      out(`${mark} ${String(index + 1).padStart(2)}. ${node.name} [${node.type}] ${node.server}:${node.port}`);
    });
  },

  async use(app, params) {
    const key = params.join(' ');
    const snap = app.snapshot();
    const byIndex = Number.parseInt(key, 10);
    const node = Number.isInteger(byIndex) && byIndex > 0 ? snap.nodes[byIndex - 1] : snap.nodes.find((n) => n.name === key);
    if (!node) throw new Error(`找不到节点: ${key}`);
    await app.selectNode(node.id);
    out(`已切换到: ${node.name}`);
  },

  async rm(app, params) {
    const index = Number.parseInt(params[0], 10);
    const snap = app.snapshot();
    const node = snap.nodes[index - 1];
    if (!node) throw new Error(`序号无效: ${params[0]}`);
    app.removeNode(node.id);
    out(`已删除: ${node.name}`);
  },

  async reset(app) {
    app.store.setNodes([]);
    app.store.state.subscriptions = [];
    app.store.persist();
    out('已清空所有节点与订阅');
  },

  async check(app) {
    const { config, meta, warnings } = await app.buildConfigOnly();
    const { CoreProcess } = require('../src/core/process');
    const binary = require('../src/core/kernel').installed();
    out(`节点: ${meta.selectedNode.name} [${meta.selectedNode.type}]`);
    out(`配置语法: ${meta.schema === 'modern' ? '1.12+ (modern)' : '1.11 及更早 (legacy)'}`);
    out(`出站 ${config.outbounds.length} 个 · 路由规则 ${config.route.rules.length} 条 · DNS 规则 ${config.dns.rules.length} 条`);
    out(`加速域名 ${meta.routing.accelerationSuffixes} 个 · 分流依据 ${meta.routing.geo}`);
    for (const warning of warnings) out(`! ${warning}`);
    require('fs').writeFileSync(app.p.configFile, JSON.stringify(config, null, 2), 'utf8');
    out(`配置已写入: ${app.p.configFile}`);
    if (!binary) {
      out('（内核未安装，跳过 sing-box 语法校验；执行 kernel install 后再试）');
      return;
    }
    const core = new CoreProcess({ binary, configFile: app.p.configFile, clashApiPort: meta.clashApiPort });
    const result = await core.validate(config);
    out(result.ok ? '✓ sing-box 配置校验通过' : `✗ 配置校验失败:\n${result.output}`);
    if (!result.ok) process.exitCode = 1;
  },

  async show(app) {
    const { config, meta } = await app.buildConfigOnly();
    out(`// 配置语法: ${meta.schema}`);
    out(JSON.stringify(config, null, 2));
  },

  async start(app, params) {
    if (flags.has('--tun')) await app.updateSettings({ tun: { enabled: true } });
    if (flags.has('--system-proxy')) await app.updateSettings({ systemProxy: { enabled: true } });
    if (flags.has('--no-system-proxy')) await app.updateSettings({ systemProxy: { enabled: false } });
    if (params[0]) {
      const snap = app.snapshot();
      const node = snap.nodes.find((n) => n.name === params[0]);
      if (node) await app.selectNode(node.id);
    }

    app.on('log', (line) => out(`[${new Date().toLocaleTimeString('zh-CN')}] ${line}`));
    await app.start();
    const meta = app.status.meta;
    out('');
    out(`✓ 加速已启动 · 节点 ${meta.selectedNode.name}`);
    out(`  TUN: ${meta.tunEnabled ? '已开启' : '未开启'} · 本地代理 127.0.0.1:${meta.inboundPort} · Clash API ${meta.clashApiPort}`);
    out('  按 Ctrl+C 停止加速');
    out('');

    const stop = async () => {
      out('\n正在停止…');
      await app.stop();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // 前台常驻
    await new Promise(() => {});
  },

  async test(app) {
    app.on('delay', (entry) => {
      out(entry.ok ? `  ${entry.name}: ${entry.delay}ms` : `  ${entry.name}: 失败（${entry.error}）`);
    });
    const results = await app.testAllNodes();
    const ok = results.filter((r) => r.ok);
    out('');
    out(`完成：${ok.length}/${results.length} 个节点可用`);
    if (ok.length) {
      const fastest = ok.reduce((a, b) => (a.delay <= b.delay ? a : b));
      out(`最快: ${fastest.name} ${fastest.delay}ms`);
    }
  },

  async twitter(app) {
    const result = await app.checkTwitter();
    out(result.ok ? `✓ X/Twitter 可达（${result.delay}ms）` : `✗ 无法访问 X/Twitter：${result.error}`);
    if (!result.ok) process.exitCode = 1;
  },

  async logs(app, params) {
    const lines = Number.parseInt(params[0], 10) || 60;
    const logs = app.getLogs(lines);
    out(`── 内核日志 (${logs.files.kernel}) ──`);
    out(logs.kernel.slice(-lines).join('\n') || '(空)');
    out('');
    out(`── 应用日志 (${logs.files.app}) ──`);
    out(logs.app.slice(-Math.min(lines, 30)).join('\n') || '(空)');
  },
};

async function main() {
  const handler = commands[command];
  if (!handler) {
    out(`未知命令: ${command}`);
    await commands.help();
    process.exitCode = 1;
    return;
  }
  try {
    await withApp((app) => handler(app, positional));
  } catch (error) {
    console.error(`\n✗ ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { commands };
