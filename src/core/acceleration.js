'use strict';

/**
 * 「加速什么」的定义 + 分流预设。
 *
 * 设计目标：既要让 Twitter/X 走代理，又不让国内站点被绕远路拖慢。
 * 所以默认策略是：国内直连、其余走代理；预设域名列表会强制走代理（优先级最高），
 * 这样即使某个 X 的 CDN 域名被国内规则误判，也仍然走代理。
 */

/** Twitter / X 及其素材、短链、登录依赖的域名 */
const TWITTER_SUFFIXES = [
  'x.com',
  'twitter.com',
  't.co',
  'twimg.com',
  'twttr.com',
  'twttr.net',
  'twitterstat.us',
  'ads-twitter.com',
  'twitter.biz',
  'pscp.tv',
  'periscope.tv',
  'periscope.co',
  'nitter.net',
  'nitter.poast.org',
  'nitter.privacydev.net',
  'tweetdeck.twitter.com',
];

/** X 登录/注册依赖的第三方（Cloudflare Turnstile、Arkose 验证码、Google 登录） */
const TWITTER_DEPENDENCIES = [
  'challenges.cloudflare.com',
  'client-api.arkoselabs.com',
  'arkoselabs.com',
  'funcaptcha.com',
  'accounts.google.com',
  'gstatic.com',
  'googleusercontent.com',
  'recaptcha.net',
];

const CATEGORY_PRESETS = {
  twitter: {
    label: 'Twitter / X',
    suffixes: [...TWITTER_SUFFIXES, ...TWITTER_DEPENDENCIES],
    alwaysOn: true,
  },
  telegram: {
    label: 'Telegram',
    suffixes: ['telegram.org', 'telegram.me', 't.me', 'telesco.pe', 'tdesktop.com'],
  },
  youtube: {
    label: 'YouTube',
    suffixes: ['youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com', 'ggpht.com', 'youtube-nocookie.com'],
  },
  openai: {
    label: 'OpenAI / ChatGPT',
    suffixes: ['openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com', 'sora.com'],
  },
  google: {
    label: 'Google',
    suffixes: ['google.com', 'googleapis.com', 'gstatic.com', 'google.co.jp', 'google.co.uk', 'withgoogle.com'],
  },
  github: {
    label: 'GitHub / 开发',
    suffixes: ['github.com', 'githubusercontent.com', 'githubassets.com', 'ghcr.io', 'npmjs.com', 'docker.io'],
  },
  meta: {
    label: 'Instagram / Facebook / WhatsApp',
    suffixes: ['instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net', 'whatsapp.com', 'whatsapp.net'],
  },
  discord: {
    label: 'Discord',
    suffixes: ['discord.com', 'discordapp.com', 'discord.gg', 'discordapp.net'],
  },
  wikipedia: {
    label: 'Wikipedia',
    suffixes: ['wikipedia.org', 'wikimedia.org', 'wiktionary.org'],
  },
  reddit: {
    label: 'Reddit',
    suffixes: ['reddit.com', 'redd.it', 'redditstatic.com', 'redditmedia.com'],
  },
  tiktok: {
    label: 'TikTok',
    suffixes: ['tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'musical.ly', 'byteoversea.com'],
  },
};

/** 国内域名：命中则直连（geosite-cn 规则集不可用时的兜底） */
const CHINA_SUFFIXES = [
  'cn',
  'baidu.com',
  'bdstatic.com',
  'qq.com',
  'gtimg.com',
  'qpic.cn',
  'qcloud.com',
  'myqcloud.com',
  'weixin.qq.com',
  'taobao.com',
  'tmall.com',
  'alicdn.com',
  'alipay.com',
  'aliyun.com',
  'alibaba.com',
  'jd.com',
  '360buyimg.com',
  'bilibili.com',
  'hdslb.com',
  'bilivideo.com',
  'douyin.com',
  'bytedance.com',
  'bytednsdoc.com',
  'ixigua.com',
  'toutiao.com',
  'weibo.com',
  'sina.com.cn',
  'sinaimg.cn',
  'zhihu.com',
  'zhimg.com',
  '163.com',
  '126.net',
  'sohu.com',
  'iqiyi.com',
  'youku.com',
  'acgvideo.com',
  'meituan.com',
  'dianping.com',
  'ctrip.com',
  'pinduoduo.com',
  'xiaohongshu.com',
  'xhscdn.com',
  'kuaishou.com',
  'mi.com',
  'xiaomi.com',
  'huawei.com',
  'hicloud.com',
  'oppo.com',
  'vivo.com',
  'unionpay.com',
  'icbc.com.cn',
  'cmbchina.com',
  '12306.cn',
  'gov.cn',
  'edu.cn',
  'cnki.net',
  'csdn.net',
  'gitee.com',
  'jianguoyun.com',
  'nutstore.net',
  'qiniu.com',
  'upyun.com',
  'lanzou.com',
  'douban.com',
  'doubanio.com',
  'ximalaya.com',
  'qidian.com',
  'zhipin.com',
  'lagou.com',
  '58.com',
  'ganji.com',
  'ke.com',
  'anjuke.com',
  'sf-express.com',
  'cainiao.com',
];

/** 国内 DNS / DoH 主机名（直连查询，避免被污染） */
const CHINA_DNS_HOSTS = [
  'dns.alidns.com',
  'doh.pub',
  'dns.pub',
  'dot.pub',
  '1.12.12.12',
  '120.53.53.53',
  '223.5.5.5',
  '223.6.6.6',
  '119.29.29.29',
  '180.76.76.76',
];

/** 常见「国内大内网 / 保留地址」网段，命中直连 */
const PRIVATE_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '224.0.0.0/4',
  '255.255.255.255/32',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

/** 客户端自身、内网服务、局域网直连域名 */
const DIRECT_DOMAIN_KEYWORDS = [
  'localhost',
  'local',
  'lan',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
  'msftconnecttest.com',
  'msftncsi.com',
  'windowsupdate.com',
  'microsoft.com',
  'live.com',
  'office.com',
  'apple.com',
  'icloud.com',
  'wechat.com',
  'weixin.com',
  'tenpay.com',
  'alipayobjects.com',
];

/** 广告 / 统计 / 追踪域名：默认拦截（可在设置里关闭） */
const AD_DOMAIN_KEYWORDS = [
  'mmstat.com',
  'cnzz.com',
  'umeng.com',
  'umengcloud.com',
  'growingio.com',
  'sensorsdata.cn',
  'admaster.com.cn',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  'adnxs.com',
  'adsrvr.org',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'moatads.com',
  'amazon-adsystem.com',
  'quantserve.com',
  '2mdn.net',
];

/** 启动时需要预热的域名（让 TUN 起来后第一批请求就命中规则） */
const WARMUP_DOMAINS = ['x.com', 'api.x.com', 'abs.twimg.com', 'pbs.twimg.com', 'video.twimg.com'];

function suffixSetToRules(suffixes, outbound, extra = {}) {
  const list = Array.from(new Set(suffixes.filter(Boolean)));
  if (!list.length) return null;
  return {
    domain_suffix: list,
    outbound,
    ...extra,
  };
}

module.exports = {
  TWITTER_SUFFIXES,
  TWITTER_DEPENDENCIES,
  CATEGORY_PRESETS,
  CHINA_SUFFIXES,
  CHINA_DNS_HOSTS,
  PRIVATE_CIDRS,
  DIRECT_DOMAIN_KEYWORDS,
  AD_DOMAIN_KEYWORDS,
  WARMUP_DOMAINS,
  suffixSetToRules,
};
