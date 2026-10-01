'use strict';

/**
 * 延迟与出口检测：通过 sing-box 的 Clash API 让「真实链路」去访问目标站点。
 *
 * 这是判断「能不能上 Twitter」最直接的方法：
 * 用内核里某个出站实际发起 HTTPS 请求，拿到状态码与耗时。
 */

const http = require('http');

const TWITTER_PROBE = 'https://api.x.com/1.1/guest/activate.json';
const GENERATE_204 = 'https://www.gstatic.com/generate_204';

function clashRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 8000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
    req.end(options.body || undefined);
  });
}

/** 通过某个出站测延迟；group 为 selector/urltest 时测的是「组内被选中的节点」 */
async function delayViaClash(port, tag, options = {}) {
  const testUrl = options.testUrl || GENERATE_204;
  const timeout = options.timeout || 5000;
  const path = `/proxies/${encodeURIComponent(tag)}/delay?timeout=${timeout}&url=${encodeURIComponent(testUrl)}`;
  const started = Date.now();
  try {
    const res = await clashRequest(port, path, { timeout: timeout + 3000 });
    const elapsed = Date.now() - started;
    if (res.status !== 200) {
      let message = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(res.body);
        if (parsed && parsed.message) message = parsed.message;
      } catch {
        /* 保留原始信息 */
      }
      return { ok: false, tag, error: message, elapsed };
    }
    const parsed = JSON.parse(res.body || '{}');
    return { ok: true, tag, delay: parsed.delay, elapsed };
  } catch (error) {
    return { ok: false, tag, error: error.message, elapsed: Date.now() - started };
  }
}

/** 用直连出口测一次，得到一个「本地网络基准延迟」 */
async function directDelay(port, options = {}) {
  return delayViaClash(port, 'direct', options);
}

/**
 * 出口检测：让指定出站实际访问一个目标 URL，返回状态码/耗时。
 * 注意：这里不解析响应内容，只看「能不能通」。
 */
async function probeViaClash(port, tag, url, options = {}) {
  const timeout = options.timeout || 8000;
  const path = `/proxies/${encodeURIComponent(tag)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`;
  return delayViaClash(port, tag, { testUrl: url, timeout });
}

/** 查 selector 当前选中的是哪个出站 */
async function getSelectedTag(port, groupTag = 'proxy') {
  try {
    const res = await clashRequest(port, `/proxies/${encodeURIComponent(groupTag)}`, { timeout: 3000 });
    if (res.status !== 200) return null;
    const parsed = JSON.parse(res.body);
    return parsed.now || null;
  } catch {
    return null;
  }
}

/** 切换 selector 的选中节点 */
async function selectTag(port, groupTag, outboundTag) {
  try {
    const res = await clashRequest(port, `/proxies/${encodeURIComponent(groupTag)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: outboundTag }),
      timeout: 4000,
    });
    return { ok: res.status === 204 || res.status === 200 };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 兼容旧名：直接对出站做一次真实请求，判断可用性 */
async function testTwitterReachability(port, tag, options = {}) {
  const result = await probeViaClash(port, tag, TWITTER_PROBE, options);
  return {
    ...result,
    reachable: result.ok,
    note: result.ok ? '链路可访问 X/Twitter API' : `无法访问 X/Twitter API：${result.error}`,
  };
}

module.exports = {
  TWITTER_PROBE,
  GENERATE_204,
  clashRequest,
  delayViaClash,
  directDelay,
  probeViaClash,
  getSelectedTag,
  selectTag,
  testTwitterReachability,
};
