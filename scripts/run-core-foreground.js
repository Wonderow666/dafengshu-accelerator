'use strict';

/** 直接前台运行内核，观察它到底为什么退出（打印 stdout/stderr 与退出码） */

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const kernel = require('../src/core/kernel');
const { paths } = require('../src/core/paths');

const p = paths();
const binary = kernel.installed();
const child = spawn(binary, ['run', '-c', p.configFile], {
  cwd: path.dirname(binary),
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (d) => process.stdout.write(`[out] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`[err] ${d}`));
child.on('exit', (code, signal) => {
  console.log(`\n>>> 内核退出 code=${code} signal=${signal}`);
  process.exit(0);
});
child.on('error', (e) => console.log(`spawn 错误: ${e.message}`));

setTimeout(() => {
  const socket = net.connect({ port: 2080, host: '127.0.0.1' }, () => {
    console.log('>>> 2080 端口已监听（内核在正常运行）');
    socket.destroy();
  });
  socket.setTimeout(1500, () => {
    console.log('>>> 2080 端口未监听');
    socket.destroy();
  });
  socket.on('error', () => console.log('>>> 2080 端口未监听（连接失败）'));
}, 2500);

setTimeout(() => {
  console.log('>>> 5 秒后内核仍在运行，视为正常。手动终止。');
  child.kill();
  setTimeout(() => process.exit(0), 500);
}, 5000);
