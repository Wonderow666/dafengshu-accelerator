'use strict';

/**
 * Windows 系统代理设置。
 *
 * 只改当前用户（HKCU）的 Internet Settings，不需要管理员权限；
 * 改完必须广播 WM_SETTINGCHANGE / 调用 InternetSetOption，否则浏览器不会立刻生效。
 */

const { execFile } = require('child_process');

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function runPowerShell(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    execFile('powershell.exe', args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`PowerShell 执行失败: ${stderr || error.message}`));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

/** 读取当前系统代理状态 */
async function getSystemProxy() {
  if (process.platform !== 'win32') {
    return { enabled: false, server: '', supported: false };
  }
  try {
    const script = [
      `$p = Get-ItemProperty -Path '${REG_PATH}' -ErrorAction SilentlyContinue`,
      'if ($p) {',
      '  $obj = [ordered]@{ enabled = [bool]$p.ProxyEnable; server = [string]$p.ProxyServer; bypass = [string]$p.ProxyOverride }',
      '  $obj | ConvertTo-Json -Compress',
      '} else { \'{"enabled":false,"server":"","bypass":""}\' }',
    ].join('\n');
    const out = await runPowerShell(script);
    const parsed = JSON.parse(out || '{}');
    return {
      enabled: Boolean(parsed.enabled),
      server: parsed.server || '',
      bypass: parsed.bypass || '',
      supported: true,
    };
  } catch (error) {
    return { enabled: false, server: '', bypass: '', supported: false, error: error.message };
  }
}

/** 把代理指向本地内核的 mixed 入站 */
async function enableSystemProxy(host, port, options = {}) {
  if (process.platform !== 'win32') throw new Error('系统代理设置目前只支持 Windows');
  const bypass = options.bypass || '<local>';
  const script = [
    `Set-ItemProperty -Path '${REG_PATH}' -Name ProxyEnable -Value 1 -Type DWord`,
    `Set-ItemProperty -Path '${REG_PATH}' -Name ProxyServer -Value '${host}:${port}' -Type String`,
    `Set-ItemProperty -Path '${REG_PATH}' -Name ProxyOverride -Value '${bypass}' -Type String`,
    'Add-Type -Namespace Dafengshu -Name Native -MemberDefinition \'',
    '  [DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);',
    "  public static void Refresh() { InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0); InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0); }'",
    '-ErrorAction Stop',
    '[Dafengshu.Native]::Refresh()',
    "'ok'",
  ].join('\n');
  const out = await runPowerShell(script);
  return { ok: out.includes('ok'), server: `${host}:${port}`, bypass };
}

/** 关闭系统代理 */
async function disableSystemProxy() {
  if (process.platform !== 'win32') throw new Error('系统代理设置目前只支持 Windows');
  const script = [
    `Set-ItemProperty -Path '${REG_PATH}' -Name ProxyEnable -Value 0 -Type DWord`,
    'Add-Type -Namespace Dafengshu -Name Native -MemberDefinition \'',
    '  [DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);',
    "  public static void Refresh() { InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0); InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0); }'",
    '-ErrorAction Stop',
    '[Dafengshu.Native]::Refresh()',
    "'ok'",
  ].join('\n');
  const out = await runPowerShell(script);
  return { ok: out.includes('ok') };
}

/**
 * 带「记住并恢复原状态」的包装：启动前保存用户原本的系统代理设置，
 * 停止时还原，避免把用户的原有代理配置弄丢。
 */
class SystemProxyManager {
  constructor(log) {
    this.log = log || { info() {}, warn() {} };
    this.backup = null;
  }

  async enable(host, port, options = {}) {
    if (!this.backup) {
      this.backup = await getSystemProxy();
      this.log.info(`已记录原始系统代理: ${JSON.stringify(this.backup)}`);
    }
    const result = await enableSystemProxy(host, port, options);
    this.log.info(`系统代理已指向 ${host}:${port}`);
    return result;
  }

  async disable() {
    const result = await disableSystemProxy();
    this.log.info('系统代理已关闭');
    return result;
  }

  /** 进程退出时调用：如果原来是开着的，恢复原样而不是直接关掉 */
  async restore() {
    if (!this.backup) {
      await disableSystemProxy().catch(() => {});
      return { restored: 'disabled' };
    }
    try {
      if (this.backup.enabled && this.backup.server) {
        const [host, port] = this.backup.server.split(':');
        await enableSystemProxy(host, port, { bypass: this.backup.bypass || '<local>' });
        this.log.info(`已恢复原始系统代理 ${this.backup.server}`);
        return { restored: 'original', server: this.backup.server };
      }
      await disableSystemProxy();
      this.log.info('已关闭系统代理（原本就是关闭状态）');
      return { restored: 'disabled' };
    } catch (error) {
      this.log.warn(`恢复系统代理失败: ${error.message}`);
      return { restored: 'failed', error: error.message };
    } finally {
      this.backup = null;
    }
  }
}

/** 局域网 IPv4 地址（排除虚拟网卡），用于「局域网共享」提示手机该填什么 */
function getLanAddresses() {
  const os = require('os');
  const result = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (/virtual|vmware|vbox|hyper-v|loopback|docker|wsl|tailscale/i.test(name)) continue;
      result.push({ name, address: item.address });
    }
  }
  return result;
}

/**
 * 为「局域网共享」放行 Windows 防火墙入站端口。
 * 需要管理员权限；失败不致命（可手动放行），所以返回结果而不抛错。
 */
async function addFirewallRule(port) {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
  const name = '大枫树加速-局域网共享';
  const script = [
    `$existing = Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue`,
    'if ($existing) {',
    `  Remove-NetFirewallRule -DisplayName '${name}'`,
    '}',
    `New-NetFirewallRule -DisplayName '${name}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any | Out-Null`,
    "Write-Output 'created'",
  ].join('\n');
  try {
    const out = await runPowerShell(script, 30000);
    return { ok: true, action: out.trim(), port, name };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      hint:
        `可能需要管理员权限。也可手动放行：以管理员身份运行 PowerShell 并执行` +
        ` New-NetFirewallRule -DisplayName '大枫树加速-局域网共享' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    };
  }
}

/** 删除局域网共享的防火墙规则 */
async function removeFirewallRule() {
  if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' };
  const name = '大枫树加速-局域网共享';
  const script = [
    `$existing = Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue`,
    `if ($existing) { Remove-NetFirewallRule -DisplayName '${name}'; Write-Output 'removed' } else { Write-Output 'notfound' }`,
  ].join('\n');
  try {
    const out = await runPowerShell(script, 20000);
    return { ok: true, action: out.trim() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  getSystemProxy,
  enableSystemProxy,
  disableSystemProxy,
  SystemProxyManager,
  getLanAddresses,
  addFirewallRule,
  removeFirewallRule,
};
