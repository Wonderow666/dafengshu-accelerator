'use strict';

/**
 * sing-box 内核进程管理：写配置 → 校验 → 启动 → 健康检查 → 停止。
 *
 * 关于 TUN：Windows 上 TUN 需要管理员权限，非管理员启动会直接失败，
 * 所以启动前先自查，给出可操作的提示（而不是丢一个看不懂的报错）。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

function isAdmin() {
  if (process.platform !== 'win32') return true;
  try {
    const { execFileSync } = require('child_process');
    // net session 在非管理员下会返回「拒绝访问」(exit code 2)
    execFileSync('net', ['session'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000 });
    return true;
  } catch (error) {
    return error && error.status === 0;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 通过 Clash API 判断内核是否真的可用了（比只看进程存活可靠） */
async function probeClashApi(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write('GET /version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => done(data.includes('200')));
    socket.on('error', () => done(false));
  });
}

class CoreProcess {
  constructor(options) {
    this.binary = options.binary;
    this.args = options.args || ['run', '-c'];
    this.configFile = options.configFile;
    this.logFile = options.logFile;
    this.clashApiPort = options.clashApiPort || 9090;
    this.env = options.env || null;
    this.log = options.log || { info() {}, warn() {}, error() {} };
    this.child = null;
    this.startedAt = 0;
    this.lastError = '';
    this.exitInfo = null;
    this.restarts = 0;
    this.detectedSchema = null;
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** 用临时文件校验配置，不污染真正要用的 configFile */
  validateFile(config, file) {
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
    return new Promise((resolve) => {
      execFile(
        this.binary,
        ['check', '-c', file],
        { windowsHide: true, timeout: 20000 },
        (error, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`.replace(/\u001b\[\d+m/g, '').trim();
          const ok = !output.includes('FATAL') && !output.includes('ERROR');
          resolve({ ok, output: error && !output ? error.message : output });
        }
      );
    });
  }

  /** 写入配置并让内核做一次语法/语义校验 */
  async validate(config) {
    return this.validateFile(config, this.configFile);
  }

  /** 探测内核支持的配置语法（legacy=1.11 及更早，modern=1.12+），结果会缓存 */
  async detectSchema(force = false) {
    if (this.detectedSchema && !force) return this.detectedSchema;
    const { detectSchema } = require('./config');
    const probeFile = `${this.configFile}.probe`;
    const schema = await detectSchema((config) => this.validateFile(config, probeFile));
    this.detectedSchema = schema;
    try {
      fs.rmSync(probeFile, { force: true });
    } catch {
      /* 忽略 */
    }
    this.log.info(`内核配置语法: ${schema === 'modern' ? '1.12+ (modern)' : '1.11 及更早 (legacy)'}`);
    return schema;
  }

  async start(config, options = {}) {
    if (this.isRunning()) throw new Error('内核已经在运行中');
    if (config.inbounds.some((i) => i.type === 'tun') && !isAdmin()) {
      throw new Error(
        'TUN 模式需要管理员权限：请关闭 TUN 模式，或以管理员身份重新启动本程序（右键 → 以管理员身份运行）。'
      );
    }

    const check = await this.validate(config);
    if (!check.ok) {
      throw new Error(`配置校验失败：\n${check.output}`);
    }

    const logToFile = config.log && typeof config.log.output === 'string' && config.log.output;
    const stdio = logToFile
      ? ['ignore', 'ignore', 'ignore'] // 内核自己写日志文件，父进程不抓管道（也避免 Windows 管道限制）
      : ['ignore', 'pipe', 'pipe'];

    this.child = spawn(this.binary, [...this.args, this.configFile], {
      windowsHide: true,
      stdio,
      cwd: path.dirname(this.binary),
      env: this.env ? { ...process.env, ...this.env } : process.env,
    });

    if (!logToFile) {
      const collect = (chunk) => {
        const text = chunk.toString('utf8').trim();
        if (text) this.log.info(`[内核] ${text}`);
      };
      this.child.stdout.on('data', collect);
      this.child.stderr.on('data', collect);
    }

    this.child.on('error', (error) => {
      this.lastError = error.message;
      this.log.error(`内核启动失败: ${error.message}`);
    });

    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, at: Date.now() };
      this.log.warn(`内核已退出 code=${code} signal=${signal}`);
      if (typeof options.onExit === 'function') options.onExit(this.exitInfo);
    });

    this.startedAt = Date.now();

    // 等 Clash API 就绪，最多等 12 秒
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (!this.isRunning()) {
        throw new Error(
          `内核启动后立即退出${this.lastError ? `：${this.lastError}` : ''}。请查看日志 ${this.logFile || ''} 排查。`
        );
      }
      if (await probeClashApi(this.clashApiPort)) {
        this.log.info(`内核已就绪（${Date.now() - this.startedAt}ms）`);
        this.restarts = 0;
        return { ok: true, startupMs: Date.now() - this.startedAt };
      }
      await sleep(300);
    }

    throw new Error('内核启动超时：请检查端口是否被占用，或节点配置是否正确。');
  }

  async stop(options = {}) {
    if (!this.child) return { ok: true, alreadyStopped: true };
    const child = this.child;
    const pid = child.pid;
    this.child = null;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (how) => {
        if (settled) return;
        settled = true;
        resolve({ ok: true, how });
      };

      child.once('exit', () => finish('graceful'));

      try {
        child.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }

      setTimeout(() => {
        if (settled) return;
        // Windows 上 SIGTERM 对某些进程无效，用 taskkill 兜底
        try {
          if (process.platform === 'win32') {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => finish('killed'));
          } else {
            child.kill('SIGKILL');
            finish('killed');
          }
        } catch {
          finish('killed');
        }
      }, options.timeoutMs || 4000);
    });
  }

  /** 读取内核日志尾部（默认最后 200 行） */
  tailLog(lines = 200) {
    try {
      if (!this.logFile || !fs.existsSync(this.logFile)) return [];
      const content = fs.readFileSync(this.logFile, 'utf8');
      return content.split(/\r?\n/).filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }

  clearLog() {
    try {
      if (this.logFile && fs.existsSync(this.logFile)) fs.writeFileSync(this.logFile, '', 'utf8');
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { CoreProcess, isAdmin, probeClashApi };
