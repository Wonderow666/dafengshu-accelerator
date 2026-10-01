'use strict';

/**
 * 手机配置文件分发服务。
 *
 * 用途：sing-box 手机版不认 vless:// / hysteria2:// 这类分享链接，
 * 只认自己的 JSON 配置。这个脚本把 desktop 生成的配置放在局域网里，
 * 让手机通过「从文件导入」或扫码方式拿到。
 *
 * 用法:
 *   node scripts/serve-mobile-config.js            # 默认端口 8899
 *   node scripts/serve-mobile-config.js 9000       # 指定端口
 *
 * 手机和电脑必须在同一个 WiFi 下。
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'mobile', 'sing-box-config.json');
const PORT = Number.parseInt(process.argv[2], 10) || 8899;

/** 列出本机的局域网 IPv4 地址（排除虚拟网卡） */
function lanAddresses() {
  const result = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (/virtual|vmware|vbox|hyper-v|loopback|docker|wsl/i.test(name)) continue;
      result.push({ name, address: item.address });
    }
  }
  return result;
}

function main() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`找不到配置文件: ${CONFIG_FILE}`);
    console.error('请先生成配置（mobile/sing-box-config.json）');
    process.exitCode = 1;
    return;
  }

  const initialBody = fs.readFileSync(CONFIG_FILE, 'utf8');
  // 启动时先校验一次，配置写坏了直接报出来
  try {
    JSON.parse(initialBody);
  } catch (error) {
    console.error(`配置文件不是合法 JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/config' || req.url.startsWith('/config?')) {
      // 每次请求都重新读文件：改完配置不用重启服务，避免手机拿到旧内容
      let body;
      try {
        body = fs.readFileSync(CONFIG_FILE, 'utf8');
        JSON.parse(body); // 顺带校验，配置写坏了能立刻发现
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`配置文件读取失败: ${error.message}`);
        console.error(`  ! 配置文件有问题: ${error.message}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Disposition': 'attachment; filename="sing-box-config.json"',
      });
      res.end(body);
      console.log(
        `  ← 手机下载了配置 (${new Date().toLocaleTimeString('zh-CN')})  ` +
          `dns.servers[0]=${JSON.parse(body).dns.servers[0].type || '(legacy)'}`
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('大枫树加速 · 手机配置分发服务\n配置文件地址: /config\n');
  });

  server.listen(PORT, '0.0.0.0', () => {
    const addresses = lanAddresses();
    console.log('==================================================');
    console.log('  手机配置分发服务已启动');
    console.log('==================================================\n');
    if (!addresses.length) {
      console.log('⚠️  没有检测到局域网地址，请确认已连接 WiFi/网线\n');
    }
    for (const item of addresses) {
      const url = `http://${item.address}:${PORT}/config`;
      console.log(`  ${item.name}`);
      console.log(`    下载地址: ${url}`);
      console.log(`    扫码导入: sing-box://import-remote-profile?url=${url}\n`);
    }
    console.log('--------------------------------------------------');
    console.log('手机操作：');
    console.log('  方式 1（推荐）: 手机浏览器打开上面的「下载地址」→ 下载 json 文件');
    console.log('                  → sing-box「添加配置文件」→「从文件导入」');
    console.log('  方式 2: sing-box「扫描二维码」→ 扫下面的二维码');
    console.log('--------------------------------------------------');
    console.log('按 Ctrl+C 停止服务\n');

    // 如果本机装了 qrcode 库就用，否则提示用户手动生成
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const QRCode = require('qrcode-terminal');
      const target = addresses.length ? addresses[0].address : '127.0.0.1';
      const uri = `sing-box://import-remote-profile?url=http://${target}:${PORT}/config`;
      console.log(`二维码内容: ${uri}\n`);
      QRCode.generate(uri, { small: true });
    } catch {
      console.log('（未安装 qrcode-terminal，无法在终端显示二维码；用「方式 1」即可）\n');
    }
  });
}

if (require.main === module) main();

module.exports = { lanAddresses };
