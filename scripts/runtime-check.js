'use strict';

/**
 * 运行时端到端验证（不需要真实可用的节点也能跑）：
 *   1. 内核能否真正启动并就绪
 *   2. 本地代理端口是否监听
 *   3. Clash API 是否可读
 *   4. 国内域名是否「直连」—— 用一个国内可达的地址验证，
 *      如果被错误地塞进代理隧道，这里会失败
 *   5. 停止后端口是否释放
 *
 * 用法: node scripts/runtime-check.js
 */

const net = require('net');
const { App } = require('../src/core/app');
const { clashRequest, getSelectedTag } = require('../src/core/speedtest');

function portOpen(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeout, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

/** 通过本地代理发一次 HTTP 请求（http 目标用绝对 URI，不需要 CONNECT） */
function viaProxy(port, targetUrl, timeout = 8000) {
  return new Promise((resolve) => {
    const url = new URL(targetUrl);
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      socket.write(
        `GET ${targetUrl} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: dafengshu-check\r\nConnection: close\r\n\r\n`
      );
    });
    let data = '';
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => finish({ ok: false, error: '超时' }));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 4096) finish(parse(data));
    });
    socket.on('end', () => finish(parse(data)));
    socket.on('error', (error) => finish({ ok: false, error: error.message }));

    function parse(raw) {
      if (!raw) return { ok: false, error: '空响应' };
      const statusLine = raw.split('\r\n')[0];
      const match = statusLine.match(/HTTP\/\d\.\d (\d+)/);
      if (!match) return { ok: false, error: `响应异常: ${statusLine.slice(0, 80)}`, raw: raw.slice(0, 200) };
      const code = Number.parseInt(match[1], 10);
      return { ok: code >= 200 && code < 400, status: code };
    }
  });
}

async function main() {
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const app = new App();
  const settings = app.store.state.settings;
  const inboundPort = settings.inboundPort;
  const clashPort = settings.clashApiPort;

  console.log(`节点数: ${app.store.state.nodes.length}，节点: ${app.store.state.nodes.map((n) => n.name).join(', ') || '(空)'}\n`);

  // 启动前端口应该是关闭的
  record('启动前 2080 端口未监听', !(await portOpen(inboundPort)));

  let startError = null;
  const started = Date.now();
  try {
    await app.start();
  } catch (error) {
    startError = error;
  }

  if (startError) {
    record('内核启动', false, startError.message.split('\n')[0]);
    await app.dispose().catch(() => {});
    process.exitCode = 1;
    return;
  }

  record('内核启动并就绪', true, `${Date.now() - started}ms`);
  record(`本地代理端口 ${inboundPort} 已监听`, await portOpen(inboundPort));
  record(`Clash API ${clashPort} 已监听`, await portOpen(clashPort));

  // Clash API 内容
  try {
    const version = await clashRequest(clashPort, '/version', { timeout: 4000 });
    const info = JSON.parse(version.body || '{}');
    record('Clash API 可读取内核版本', Boolean(info.version), `sing-box ${info.version || '?'}`);
  } catch (error) {
    record('Clash API 可读取内核版本', false, error.message);
  }

  try {
    const selected = await getSelectedTag(clashPort, 'proxy');
    record('selector 当前选中节点', Boolean(selected), String(selected));
  } catch (error) {
    record('selector 当前选中节点', false, error.message);
  }

  // 代理确实在工作：通过代理访问一个国内可达的地址（走 direct）
  const domestic = await viaProxy(inboundPort, 'http://www.baidu.com/');
  record('经本地代理访问国内站点（应为直连成功）', domestic.ok, domestic.ok ? `HTTP ${domestic.status}` : domestic.error);

  // 直连对照组
  const direct = await new Promise((resolve) => {
    const socket = net.connect({ port: 80, host: 'www.baidu.com' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(4000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
  record('本机直连国内站点（对照组）', direct, direct ? '可达' : '不可达（环境限制）');

  // 日志里应能看到内核已启动
  const logs = app.getLogs(50);
  const hasStarted = logs.kernel.some((line) => /started|sing-box/i.test(line));
  record('内核日志有启动记录', hasStarted, logs.kernel.slice(-2).join(' | ').slice(0, 120));

  // 停止并检查清理
  await app.stop();
  await new Promise((r) => setTimeout(r, 600));
  record('停止后端口已释放', !(await portOpen(inboundPort)));

  await app.dispose().catch(() => {});

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 项通过`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`运行验证失败: ${error.message}`);
  process.exitCode = 1;
});
