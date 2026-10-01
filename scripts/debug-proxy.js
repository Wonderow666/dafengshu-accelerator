'use strict';

/**
 * 诊断用 HTTP 代理：监听 2081，把收到的原始请求原样打印出来。
 * 用来判断手机（或任何设备）经过代理时到底发了什么。
 *
 * 用法: node scripts/debug-proxy.js [端口]
 */

const net = require('net');

const PORT = Number.parseInt(process.argv[2], 10) || 2081;

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n[${new Date().toLocaleTimeString('zh-CN')}] 新连接来自 ${peer}`);

  let buffer = '';
  socket.setTimeout(15000, () => {
    console.log(`[超时] ${peer} 15 秒内没有发送完整请求，已断开`);
    socket.destroy();
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8', 0, Math.min(chunk.length, 4096));
    const firstLine = buffer.split('\r\n')[0];
    console.log(`  收到数据 ${chunk.length} 字节，首行: ${firstLine}`);

    if (buffer.includes('\r\n\r\n') || buffer.startsWith('CONNECT')) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      const head = headerEnd >= 0 ? buffer.slice(0, headerEnd) : buffer;
      console.log('  ---- 完整请求头 ----');
      head.split('\r\n').forEach((line) => console.log('  | ' + line));
      console.log('  --------------------');

      // 回一个明确的错误，让客户端知道代理不转发（诊断用）
      socket.write(
        'HTTP/1.1 502 Bad Gateway\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n' +
          'Connection: close\r\n\r\n' +
          '这是诊断代理：你的请求已经成功到达电脑，但本代理不转发流量。\n' +
          'Your request reached the PC proxy. This is a diagnostic proxy and does not forward traffic.\n'
      );
      setTimeout(() => socket.destroy(), 300);
    }
  });

  socket.on('error', (error) => console.log(`  [错误] ${peer}: ${error.message}`));
  socket.on('close', () => console.log(`  [关闭] ${peer}`));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(56));
  console.log(`  诊断代理已启动，监听 0.0.0.0:${PORT}`);
  console.log('='.repeat(56));
  console.log('\n在手机上把代理改成:');
  console.log('  主机名: 192.168.1.8');
  console.log(`  端口:   ${PORT}`);
  console.log('\n然后手机浏览器打开 http://ip-api.com/json');
  console.log('这里会打印出手机实际发送的请求内容。');
  console.log('\n按 Ctrl+C 停止\n');
});
