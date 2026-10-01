'use strict';

/** 渲染层逻辑：只管界面与调用主进程 API，不含任何网络/进程逻辑 */

const api = window.dfsj;

const state = {
  snapshot: null,
  settings: null,
  categories: {},
  delays: {},
  busy: false,
  linkProbe: null,
};

const $ = (id) => document.getElementById(id);

function setStatusbar(text, right) {
  $('statusbarText').textContent = text;
  if (right !== undefined) $('statusbarRight').textContent = right;
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, kind === 'error' ? 6000 : 3200);
}

/** 统一处理主进程返回的 {ok, data|error} */
async function call(promise, label) {
  const result = await promise;
  if (!result || result.ok === false) {
    const message = (result && result.error) || '未知错误';
    if (label !== false) toast(`${label ? label + '：' : ''}${message}`, 'error');
    throw new Error(message);
  }
  return result.data;
}

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
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

// ── 标签页 ───────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.tab}`));
      if (tab.dataset.tab === 'logs') refreshLogs();
    });
  });
}

// ── 加速页 ───────────────────────────────────────────────────────────────
function renderStatus() {
  const snap = state.snapshot;
  if (!snap) return;
  const runtime = snap.runtime || {};
  const power = $('btnPower');

  power.classList.toggle('on', Boolean(runtime.running));
  power.classList.toggle('busy', Boolean(runtime.starting));
  $('powerText').textContent = runtime.starting ? '启动中…' : runtime.running ? '停止加速' : '启动加速';

  const line = $('statusLine');
  line.classList.toggle('on', Boolean(runtime.running));
  line.classList.toggle('err', Boolean(runtime.error) && !runtime.running);
  line.textContent = runtime.starting ? '正在启动…' : runtime.running ? '加速运行中' : runtime.error ? '启动失败' : '已停止';

  const sub = $('statusSub');
  if (runtime.error) {
    sub.textContent = runtime.error;
  } else if (runtime.running && runtime.meta) {
    const probe = state.linkProbe;
    const probeText = probe
      ? probe.ok
        ? ` · X 延迟 ${probe.latency}ms`
        : ` · X 不可达（${probe.error}）`
      : '';
    sub.textContent = `节点：${runtime.meta.selectedNode.name} · 本地代理 127.0.0.1:${runtime.meta.inboundPort}${probeText}`;
  } else {
    sub.textContent = snap.nodes.length ? '点击上方按钮开始加速' : '先在「节点」或「订阅」里添加线路';
  }

  const meta = $('statusMeta');
  if (runtime.running && runtime.meta) {
    const m = runtime.meta;
    meta.textContent =
      `加速域名 ${m.routing.accelerationSuffixes} 个 · 国内直连 ${m.routing.bypassChina ? '开' : '关'} · ` +
      `广告拦截 ${m.routing.blockAds ? '开' : '关'} · 未匹配流量 ${m.routing.final === 'proxy' ? '走代理' : '直连'}\n` +
      `TUN ${m.tunEnabled ? '已接管' : '未接管'} · 系统代理 ${runtime.systemProxy ? '已设置' : '未设置'} · 内核语法 ${m.schema}`;
  } else {
    meta.textContent = '';
  }

  $('currentNode').textContent = snap.nodes.find((n) => n.id === snap.selectedNodeId)?.name || '未选择';

  $('swTun').checked = Boolean(state.settings && state.settings.tun.enabled);
  $('swSysProxy').checked = Boolean(state.settings && state.settings.systemProxy.enabled);
  $('swAllowLan').checked = Boolean(state.settings && state.settings.allowLan);
  renderLanInfo();

  const routing = runtime.meta ? runtime.meta.routing : null;
  $('routingSummary').innerHTML = routing
    ? [
        ['加速域名', `${routing.accelerationSuffixes} 个`],
        ['分流依据', routing.geo === 'builtin' ? '内置 geo 库' : '域名后缀表'],
        ['国内直连', routing.bypassChina ? '已开启' : '已关闭'],
        ['广告拦截', routing.blockAds ? '已开启' : '已关闭'],
        ['未匹配流量', routing.final === 'proxy' ? '走代理' : '直连'],
        ['本地代理', `127.0.0.1:${runtime.meta.inboundPort}`],
      ]
        .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${escapeHtml(v)}</b></div>`)
        .join('')
    : '<div class="kv"><span>状态</span><b>加速未启动</b></div>';

  $('brandSub').textContent = runtime.running
    ? `已连接 · ${runtime.meta ? runtime.meta.selectedNode.name : ''}`
    : snap.nodes.length
      ? `共 ${snap.nodes.length} 个节点`
      : '等待添加线路';

  const chipKernel = $('chipKernel');
  chipKernel.textContent = snap.kernel.installed ? `内核 ${snap.kernel.version || '已安装'}` : '内核未安装';
  chipKernel.className = `chip ${snap.kernel.installed ? 'ok' : 'warn'}`;

  const chipAdmin = $('chipAdmin');
  chipAdmin.textContent = snap.platform.isAdmin ? '管理员权限' : '普通权限';
  chipAdmin.className = `chip ${snap.platform.isAdmin ? 'ok' : ''}`;

  const tun = state.settings && state.settings.tun.enabled;
  if (tun && !snap.platform.isAdmin) {
    chipAdmin.textContent = 'TUN 需管理员';
    chipAdmin.className = 'chip bad';
  }
}

function renderNodes() {
  const snap = state.snapshot;
  if (!snap) return;
  const tbody = $('nodeTable');
  $('nodeCount').textContent = snap.nodes.length ? `（${snap.nodes.length} 个）` : '';
  $('nodeEmpty').hidden = snap.nodes.length > 0;

  tbody.innerHTML = snap.nodes
    .map((node, index) => {
      const selected = node.id === snap.selectedNodeId;
      const delay = state.delays[node.id] || snap.delays[node.id];
      const latClass = !delay ? '' : delay < 200 ? 'good' : delay < 500 ? 'mid' : 'bad';
      const badge = node.from === 'manual' ? 'manual' : 'sub';
      return `<tr class="${selected ? 'selected' : ''}" data-id="${node.id}">
        <td><input type="radio" name="node" ${selected ? 'checked' : ''} data-action="select" data-id="${node.id}" /></td>
        <td class="name">${escapeHtml(node.name)} <span class="badge ${badge}">${node.from === 'manual' ? '手动' : '订阅'}</span></td>
        <td>${escapeHtml(node.type)}</td>
        <td class="name">${escapeHtml(node.server)}:${node.port}</td>
        <td class="lat ${latClass}" data-lat="${node.id}">${delay ? `${delay} ms` : '-'}</td>
        <td>
          <button class="btn small" data-action="test" data-id="${node.id}">测速</button>
          <button class="btn small danger" data-action="remove" data-id="${node.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

function renderSubscriptions() {
  const snap = state.snapshot;
  if (!snap) return;
  const list = $('subList');
  const subs = snap.subscriptions || [];
  $('subEmpty').hidden = subs.length > 0;

  list.innerHTML = subs
    .map((sub) => {
      const traffic = sub.traffic && sub.traffic.total
        ? `<div class="sub-meta">流量 ${fmtBytes((sub.traffic.upload || 0) + (sub.traffic.download || 0))} / ${fmtBytes(
            sub.traffic.total
          )} · 到期 ${sub.traffic.expire ? fmtTime(sub.traffic.expire * 1000) : '未知'}</div>`
        : '';
      return `<div class="sub-item">
        <div class="sub-head">
          <div>
            <div><b>${escapeHtml(sub.title || sub.url)}</b></div>
            <div class="sub-url">${escapeHtml(sub.url)}</div>
          </div>
          <button class="btn small danger" data-sub-remove="${escapeHtml(sub.url)}">删除</button>
        </div>
        <div class="sub-meta">节点 ${sub.nodeCount || 0} 个 · 更新于 ${fmtTime(sub.lastUpdate)}${sub.format ? ` · 格式 ${escapeHtml(sub.format)}` : ''}</div>
        ${traffic}
        ${sub.lastError ? `<div class="sub-err">上次错误：${escapeHtml(sub.lastError)}</div>` : ''}
      </div>`;
    })
    .join('');
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  $('swBypassChina').checked = Boolean(settings.route.bypassChina);
  $('swBlockAds').checked = Boolean(settings.route.blockAds);
  $('selGeoSource').value = settings.route.geoSource || 'auto';
  $('selFinal').value = settings.route.final || 'proxy';
  $('inboundPort').value = settings.inboundPort;
  $('clashApiPort').value = settings.clashApiPort;
  $('dnsLocal').value = settings.dns.local;
  $('dnsRemote').value = settings.dns.remote;
  $('customSuffixes').value = (settings.acceleration.customSuffixes || []).join('\n');
}

function renderCategories(catalog) {
  const grid = $('catGrid');
  const selected = (state.settings && state.settings.acceleration.categories) || [];
  grid.innerHTML = catalog
    .map((cat) => {
      const checked = cat.alwaysOn || selected.includes(cat.key);
      return `<label class="cat ${cat.alwaysOn ? 'locked' : ''}">
        <input type="checkbox" data-cat="${cat.key}" ${checked ? 'checked' : ''} ${cat.alwaysOn ? 'disabled' : ''} />
        <span>${escapeHtml(cat.label)}${cat.alwaysOn ? '（必选）' : ''}</span>
      </label>`;
    })
    .join('');
}

function renderAbout(info) {
  const snap = state.snapshot;
  if (!snap) {
    $('aboutInfo').innerHTML = '<div class="kv"><span>状态</span><b>尚未取到运行状态</b></div>';
    return;
  }
  const rows = [
    ['软件版本', info.version],
    ['运行权限', info.isAdmin ? '管理员' : '普通用户'],
    ['sing-box 内核', snap.kernel.installed ? snap.kernel.version || '已安装' : '未安装'],
    ['内核路径', snap.kernel.path],
    ['数据目录', snap.dataDir],
    ['配置语法', snap.runtime.meta ? snap.runtime.meta.schema : '未探测'],
    ['平台', 'Windows'],
  ];
  $('aboutInfo').innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${escapeHtml(v)}</b></div>`)
    .join('');
}

/** 局域网共享提示：显示手机该填的主机名与端口 */
function renderLanInfo() {
  const settings = state.settings;
  const snap = state.snapshot;
  const enabled = Boolean(settings && settings.allowLan);
  $('lanCard').hidden = !enabled;
  if (!enabled) return;

  const addresses = (snap && snap.network && snap.network.lanAddresses) || [];
  const ip = addresses.length ? addresses[0].address : '（未检测到局域网地址）';
  const port = (settings && settings.inboundPort) || 2080;

  $('lanInfo').innerHTML = [
    ['主机名 / IP', ip],
    ['端口', String(port)],
    ['代理类型', 'HTTP / SOCKS5'],
    ['状态', snap && snap.runtime && snap.runtime.running ? '加速运行中' : '加速未启动'],
  ]
    .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${escapeHtml(v)}</b></div>`)
    .join('');
}

function setBusy(busy, text) {
  state.busy = busy;
  document.querySelectorAll('.btn').forEach((btn) => {
    if (btn.id !== 'btnPower') btn.disabled = busy;
  });
  $('btnPower').disabled = busy;
  if (text) setStatusbar(text);
}

// ── 数据刷新 ─────────────────────────────────────────────────────────────
async function refresh(showError = true) {
  try {
    state.snapshot = await call(api.getState(), showError ? '获取状态' : false);
    state.delays = state.snapshot.delays || {};
    renderStatus();
    renderNodes();
    renderSubscriptions();
    setStatusbar(state.snapshot.runtime.running ? '加速运行中' : '就绪');
  } catch (error) {
    setStatusbar(`状态获取失败：${error.message}`);
  }
}

async function refreshLogs() {
  try {
    const logs = await call(api.getLogs(300));
    const merged = [
      ...logs.kernel.slice(-200).map((l) => `[内核] ${l}`),
      ...logs.app.slice(-60).map((l) => `[应用] ${l}`),
    ];
    $('logBox').textContent = merged.join('\n') || '（暂无日志）';
    $('logBox').scrollTop = $('logBox').scrollHeight;
  } catch (error) {
    setStatusbar(`日志读取失败：${error.message}`);
  }
}

// ── 事件绑定 ─────────────────────────────────────────────────────────────
function bindEvents() {
  $('btnMinimize').addEventListener('click', () => api.minimize());
  $('btnClose').addEventListener('click', () => api.closeWindow());

  $('btnPower').addEventListener('click', async () => {
    const running = state.snapshot && state.snapshot.runtime.running;
    setBusy(true, running ? '正在停止…' : '正在启动…');
    try {
      await call(api.toggle(!running), false);
      await refresh();
      setStatusbar(running ? '已停止加速' : '加速已启动');
    } catch (error) {
      toast(error.message, 'error');
      await refresh();
    } finally {
      setBusy(false);
    }
  });

  const saveSetting = async (patch, label) => {
    try {
      state.settings = await call(api.updateSettings(patch), label);
      renderSettings();
      toast(`${label} 已保存`, 'ok');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  $('swTun').addEventListener('change', (e) => {
    if (e.target.checked && state.snapshot && !state.snapshot.platform.isAdmin) {
      toast('TUN 模式需要管理员权限：请关闭程序后右键「以管理员身份运行」', 'error');
      e.target.checked = false;
      return;
    }
    saveSetting({ tun: { enabled: e.target.checked } }, 'TUN 模式');
  });

  $('swSysProxy').addEventListener('change', (e) =>
    saveSetting({ systemProxy: { enabled: e.target.checked } }, '系统代理')
  );

  $('swAllowLan').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    try {
      state.settings = await call(api.updateSettings({ allowLan: enabled }), '局域网共享');
      toast(
        enabled ? '已开启局域网共享，手机可按下方提示设置代理' : '已关闭局域网共享',
        'ok'
      );
      if (enabled) {
        try {
          const preset = await call(api.addFirewallRule(), false);
          if (preset && preset.ok) setStatusbar('已添加防火墙放行规则');
        } catch {
          /* 防火墙规则失败不阻塞，界面会提示手动放行 */
        }
      }
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('btnImportNodes').addEventListener('click', async () => {
    const text = $('nodeInput').value.trim();
    if (!text) {
      toast('请先粘贴分享链接', 'error');
      return;
    }
    setBusy(true, '正在导入节点…');
    try {
      const result = await call(api.importNodes(text), '导入节点');
      $('importHint').textContent = `新增 ${result.added} 个（共 ${result.total} 个）${
        result.errors.length ? ` · 跳过 ${result.errors.length} 行` : ''
      }`;
      if (result.added === 0 && result.errors.length) toast(result.errors[0], 'error');
      else toast(`导入成功：新增 ${result.added} 个节点`, 'ok');
      $('nodeInput').value = '';
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  });

  $('btnClearInput').addEventListener('click', () => {
    $('nodeInput').value = '';
    $('importHint').textContent = '';
  });

  $('nodeTable').addEventListener('click', async (event) => {
    const target = event.target;
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (!action || !id) return;
    try {
      if (action === 'select') {
        await call(api.selectNode(id), '切换节点');
        await refresh();
        toast('已切换节点', 'ok');
      } else if (action === 'remove') {
        await call(api.removeNode(id), '删除节点');
        await refresh();
      } else if (action === 'test') {
        target.disabled = true;
        target.textContent = '测速中';
        const result = await call(api.testNode(id), false);
        target.disabled = false;
        target.textContent = '测速';
        const cell = document.querySelector(`[data-lat="${id}"]`);
        if (cell) {
          if (result.ok) {
            cell.textContent = `${result.delay} ms`;
            cell.className = `lat ${result.delay < 200 ? 'good' : result.delay < 500 ? 'mid' : 'bad'}`;
          } else {
            cell.textContent = '失败';
            cell.className = 'lat bad';
          }
        }
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  ['btnTestAll', 'btnTestAll2'].forEach((id) => {
    $(id).addEventListener('click', async () => {
      setBusy(true, '正在测速…');
      try {
        const results = await call(api.testAllNodes(), false);
        const ok = results.filter((r) => r.ok);
        toast(`测速完成：${ok.length}/${results.length} 个节点可用`, ok.length ? 'ok' : 'error');
        await refresh();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        setBusy(false);
      }
    });
  });

  $('btnCheckTwitter').addEventListener('click', async () => {
    setBusy(true, '正在检测 X 可达性…');
    try {
      const result = await call(api.checkTwitter(), false);
      if (result.ok) toast(`X/Twitter 可达，延迟 ${result.delay}ms`, 'ok');
      else toast(`X/Twitter 不可达：${result.error}`, 'error');
      state.linkProbe = result.ok ? { ok: true, latency: result.delay } : { ok: false, error: result.error };
      renderStatus();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  });

  $('btnAddSub').addEventListener('click', async () => {
    const url = $('subInput').value.trim();
    if (!url) {
      toast('请填写订阅链接', 'error');
      return;
    }
    setBusy(true, '正在拉取订阅…');
    try {
      const result = await call(api.addSubscription(url), '添加订阅');
      toast(`订阅「${result.title}」更新完成：新增 ${result.added} 个节点`, 'ok');
      $('subInput').value = '';
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
      await refresh();
    } finally {
      setBusy(false);
    }
  });

  $('btnRefreshSubs').addEventListener('click', async () => {
    setBusy(true, '正在更新全部订阅…');
    try {
      const results = await call(api.refreshSubscriptions(), '更新订阅');
      const ok = results.filter((r) => r.ok);
      toast(`订阅更新完成：${ok.length}/${results.length} 成功`, ok.length ? 'ok' : 'error');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  });

  $('subList').addEventListener('click', async (event) => {
    const url = event.target.dataset.subRemove;
    if (!url) return;
    try {
      await call(api.removeSubscription(url), '删除订阅');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  const saveRouting = async () => {
    const categories = Array.from(document.querySelectorAll('[data-cat]'))
      .filter((input) => input.checked)
      .map((input) => input.dataset.cat);
    const customSuffixes = $('customSuffixes')
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    await saveSetting({ acceleration: { categories, customSuffixes } }, '分流域名');
  };

  $('btnSaveRouting').addEventListener('click', saveRouting);
  $('btnSaveRoute').addEventListener('click', () =>
    saveSetting(
      {
        route: {
          bypassChina: $('swBypassChina').checked,
          blockAds: $('swBlockAds').checked,
          geoSource: $('selGeoSource').value,
          final: $('selFinal').value,
        },
      },
      '分流设置'
    )
  );

  $('btnSaveNet').addEventListener('click', () =>
    saveSetting(
      {
        inboundPort: Number.parseInt($('inboundPort').value, 10) || 2080,
        clashApiPort: Number.parseInt($('clashApiPort').value, 10) || 9090,
        dns: { local: $('dnsLocal').value.trim(), remote: $('dnsRemote').value.trim() },
      },
      '网络设置'
    )
  );

  $('btnRefreshLogs').addEventListener('click', refreshLogs);
  $('btnClearLogs').addEventListener('click', async () => {
    await call(api.clearLogs(), '清空日志');
    refreshLogs();
  });
  $('btnOpenLogDir').addEventListener('click', async () => {
    const logs = await call(api.getLogs(1));
    await call(api.openPath(logs.files.app.replace(/[^\\/]+$/, '')), false);
  });

  $('btnInstallKernel').addEventListener('click', async () => {
    setBusy(true, '正在下载内核…');
    $('progressCard').hidden = false;
    try {
      const result = await call(api.installKernel({}), false);
      if (result.ok) toast(`内核已就绪：${result.version}`, 'ok');
      else toast(result.error, 'error');
      await refresh();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
      $('progressCard').hidden = true;
    }
  });

  $('btnOpenDataDir').addEventListener('click', async () => {
    const info = await call(api.systemInfo(), false);
    await call(api.openPath(info.dataDir), false);
  });

  $('btnPreviewConfig').addEventListener('click', async () => {
    try {
      const { config, meta } = await call(api.previewConfig(), '生成配置');
      $('configBox').textContent = `// 配置语法: ${meta.schema}\n${JSON.stringify(config, null, 2)}`;
    } catch (error) {
      $('configBox').textContent = `生成失败：${error.message}`;
    }
  });
}

function bindPushEvents() {
  api.onStatus(() => refresh());
  api.onNodes(() => refresh());
  api.onSettings((settings) => {
    state.settings = settings;
    renderSettings();
  });
  api.onLog((line) => {
    const box = $('logBox');
    box.textContent += `[应用] ${line}\n`;
    box.scrollTop = box.scrollHeight;
  });
  api.onDelay((entry) => {
    state.delays[entry.id] = entry.ok ? entry.delay : null;
    const cell = document.querySelector(`[data-lat="${entry.id}"]`);
    if (cell) {
      if (entry.ok) {
        cell.textContent = `${entry.delay} ms`;
        cell.className = `lat ${entry.delay < 200 ? 'good' : entry.delay < 500 ? 'mid' : 'bad'}`;
      } else {
        cell.textContent = '失败';
        cell.className = 'lat bad';
      }
    }
  });
  api.onProgress((progress) => {
    $('progressCard').hidden = false;
    if (progress.percent != null) {
      $('progressBar').style.width = `${progress.percent}%`;
      $('progressText').textContent = `${progress.percent}% · ${fmtBytes(progress.received)} / ${fmtBytes(progress.total)}`;
    } else {
      $('progressText').textContent = `已下载 ${fmtBytes(progress.received)}`;
    }
  });
}

// ── 启动 ─────────────────────────────────────────────────────────────────
async function boot() {
  initTabs();
  bindEvents();
  bindPushEvents();

  const catalog = [
    { key: 'twitter', label: 'Twitter / X', alwaysOn: true },
    { key: 'telegram', label: 'Telegram' },
    { key: 'youtube', label: 'YouTube' },
    { key: 'openai', label: 'OpenAI / ChatGPT' },
    { key: 'google', label: 'Google' },
    { key: 'meta', label: 'Instagram / Facebook' },
    { key: 'discord', label: 'Discord' },
    { key: 'reddit', label: 'Reddit' },
    { key: 'tiktok', label: 'TikTok' },
    { key: 'github', label: 'GitHub' },
    { key: 'wikipedia', label: 'Wikipedia' },
  ];

  try {
    state.settings = await call(api.getSettings(), '读取设置');
    state.snapshot = await call(api.getState(), '读取状态');
  } catch (error) {
    setStatusbar(`初始化失败：${error.message}`);
  }

  renderCategories(catalog);
  renderSettings();
  await refresh();
  refreshLogs();

  const info = await call(api.systemInfo(), false).catch(() => ({ version: '-', isAdmin: false }));
  renderAbout(info);

  if (state.snapshot && state.snapshot.kernel && !state.snapshot.kernel.version) {
    // 主进程还在探测内核版本，稍后刷新
    setTimeout(() => refresh(false), 1200);
  }

  // 定期刷新运行状态
  setInterval(() => {
    if (!state.busy) refresh(false);
  }, 4000);
}

window.addEventListener('DOMContentLoaded', boot);
