# 大枫树加速

**简体中文** · [English](README.en.md)

面向 Windows 的 **Twitter / X 加速客户端**：图形界面 + 规则引擎，内置 [sing-box](https://sing-box.sagernet.org/) 内核完成实际转发。

```
┌──────────────┐   TUN / 系统代理   ┌──────────────┐   你的加密线路   ┌──────────────┐
│ 浏览器 / 客户端 │ ────────────────▶ │  本软件       │ ──────────────▶ │ 你的海外 VPS  │ ──▶ X / Twitter
│ (推特 App 等)  │                   │ sing-box 内核 │                 │ (你自己准备)   │
└──────────────┘                   └──────────────┘                 └──────────────┘
```

> ⚠️ **本软件不提供线路。** 你需要自己准备一台海外 VPS，或者使用你已有的机场订阅链接。
> 软件负责的是「怎么把流量稳稳地送出去」这一半。
>
> - 不知道买什么服务器 → [购买 VPS 指南](docs/VPS-购买指南.md)
> - 服务器已到手 → [服务端搭建指南](docs/VPS-服务端搭建.md)

---

## 快速开始

### 方式一：装安装包（推荐给只想用的）

```powershell
npm install
npm run pack          # 产物：dist\大枫树加速-0.1.0-安装包.exe（约 86 MB）
```

双击安装，之后从开始菜单或桌面快捷方式启动即可 —— **内核与规则集已随包内置，开箱即用**。

### 方式二：从源码运行（开发/调试）

```powershell
# 1. 安装依赖（首次）
npm install

# 2. 下载 sing-box 内核（中国大陆网络建议用这个脚本，走 curl + 多镜像）
npm run fetch:core

# 3. 启动图形界面
npm start
```

然后：

1. **节点** 页粘贴你的分享链接（`vless://` / `trojan://` / `ss://` / `hysteria2://` …）→ 「导入节点」
   或 **订阅** 页填入机场订阅链接 → 「添加并更新」
2. 回到 **加速** 页，点中间的大圆按钮
3. 打开 X 试试；点「检测 X 可达性」可以直接告诉你链路通不通

如果要用 TUN 模式（接管推特客户端等所有程序）：关掉软件，**右键 → 以管理员身份运行**。

---

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| **只加速你需要的** | Twitter/X 及其 CDN、短链、登录验证域名**强制走代理**，并优先于任何「国内直连」判定 |
| **国内网站不掉速** | geosite/geoip 判定国内域名与 IP，直连不走代理（国内 CDN 不会被解析到海外） |
| **DNS 防污染** | X 相关域名用**加密 DoH 经代理**解析，国内域名用国内 DNS；节点域名解析走国内 DNS，避免「用代理 DNS 解析代理服务器」的死循环 |
| **两种接管方式** | TUN 全局透明代理（需管理员）或系统代理（免管理员、只影响浏览器类程序） |
| **一键体检** | 全部节点测延迟、单节点测速、**「X 到底通不通」**直接探测 `api.x.com` |
| **多协议** | vless / vmess / trojan / ss / hysteria2 / tuic / socks / http，支持 ws / grpc / h2 / httpupgrade 传输与 Reality / uTLS 指纹 |
| **订阅** | 解析 Clash(mihomo) YAML、base64 链接列表、通用订阅，显示流量与到期时间 |
| **安全还原** | 改系统代理前先备份原设置，停止时原样恢复；异常退出也不会把你的网络设置弄丢 |
| **广告拦截** | 默认拦截常见广告/统计域名（可在「分流」页关闭） |

---

## 界面速览

- **加速**：总开关、TUN / 系统代理开关、当前节点、分流概览、一键检测 X 可达性
- **节点**：导入分享链接、节点列表、单选切换、逐个测速、删除
- **订阅**：添加/更新/删除订阅，显示节点数、流量、到期时间与错误原因
- **分流**：勾选要加速的服务（Twitter 必选）、额外域名后缀、国内直连、广告拦截、端口与 DNS
- **日志**：内核与应用日志，一键打开日志目录
- **关于**：运行环境、内核版本、配置预览（可直接看到生成的 sing-box 配置）

---

## 命令行用法

图形界面之外也提供完整 CLI，便于排查问题或在无桌面环境使用：

```powershell
node bin/dfsj.js status                    # 查看状态（内核/节点/订阅/系统代理/延迟）
node bin/dfsj.js add "vless://..."         # 添加节点
node bin/dfsj.js sub "https://订阅链接"     # 拉取订阅
node bin/dfsj.js nodes                     # 列出节点
node bin/dfsj.js use 2                     # 切换到第 2 个节点
node bin/dfsj.js check                     # 生成配置并用内核语法校验（不启动）
node bin/dfsj.js show                      # 打印生成的完整配置
node bin/dfsj.js start --tun               # 前台启动（Ctrl+C 停止）
node bin/dfsj.js test                      # 全部节点测延迟
node bin/dfsj.js twitter                   # 检测 X/Twitter 可达性
node bin/dfsj.js logs 100                  # 查看日志
node bin/dfsj.js kernel install            # 安装/更新内核
node bin/dfsj.js reset                     # 清空节点与订阅
```

---

## 分流规则顺序（为什么 X 不会被误判成直连）

```
1. 广告 / 统计域名            → 拦截
2. 加速域名（x.com / twimg.com …）→ 走代理   ← 优先级最高，压过下面所有「直连」判定
3. 内网 / 本机地址            → 直连
4. 国内域名（geosite:cn）      → 直连
5. 国内 IP（geoip:cn）         → 直连
6. 其余全部                   → 走代理
```

DNS 侧同样分流：X 相关域名 → 加密 DoH（经代理，防污染）；国内域名 → 国内 DNS（拿到就近 IP）。

---

## 工作原理与目录结构

```
src/core/        纯 Node 核心（不依赖 Electron，可单独测试与 CLI 复用）
  app.js         应用门面：连接/断开/订阅/测速的统一编排
  config.js      sing-box 配置生成（按内核版本自适应新旧语法）
  nodes.js       分享链接 ↔ 统一节点模型 ↔ sing-box 出站
  subscription.js 订阅解析（Clash YAML / base64 / 明文，含自写的极简 YAML 解析器）
  acceleration.js 加速域名与直连预设
  geo.js         规则集获取与 geo 数据源决策
  process.js     内核进程管理（校验/启动/健康检查/停止）
  kernel.js      内核下载（多镜像 + 版本回退）
  system-proxy.js Windows 系统代理（含原状态备份还原）
  speedtest.js   经 Clash API 的真实链路测速与 X 可达性探测
  store.js       设置与节点的本地持久化
src/main/        Electron 主进程（窗口 / 托盘 / IPC）
src/renderer/    界面（原生 HTML/CSS/JS，无构建步骤）
scripts/         内核下载、图标生成、冒烟检查、运行时验证等辅助脚本
docs/            VPS 服务端搭建指南
test/            node:test 单元测试
data/            运行时数据（设置、节点、日志、生成的配置）
resources/bin/   sing-box 内核
```

### 几个值得一提的实现细节

- **配置语法自适应**：sing-box 1.12 把 DNS 配置从 `address` 改成了 `type + server`，字段放错位置内核会直接 FATAL。
  本软件启动时用最小配置**探测内核支持的语法**，再据此生成配置，因此 1.11 与 1.12+ 都能用。
- **geo 数据源双轨**：优先使用本地 `.srs` 规则集（离线可用、1.12 也不会失效）；
  在国内直连不通、下载失败时，回退到内核内置 geo 库并自动设置所需环境变量，保证**首次运行就能跑通**。
- **校验先于启动**：每次启动都会先跑 `sing-box check`，并检查配置里引用的出站 / 规则集 / DNS 是否都存在，
  避免"启动了但静默失败"。

---

## 打包与分发

```powershell
npm run pack        # 生成 NSIS 安装包 → dist\大枫树加速-0.1.0-安装包.exe
npm run pack:dir    # 只生成免安装目录 → dist\win-unpacked\
```

打包会自动把 **sing-box 内核**、**国内分流规则集**、**应用图标** 放进 `resources/`，
因此安装后**首次运行完全不需要联网下载任何东西**（这也是为什么规则集会随包内置）。

打包版与开发版的目录差异：

| 用途 | 开发版 | 打包版 |
| --- | --- | --- |
| 代码 | 仓库 `src/` | `resources/app.asar` |
| 内核 / 规则集 / 图标 | 仓库 `resources/` | 安装目录 `resources/`（extraResources） |
| 设置、节点、日志 | 仓库 `data/` | `%APPDATA%\大枫树加速\` |

`src/core/paths.js` 会自动判断运行环境选择正确的目录，所以两种形态行为一致。

> **打包环境提示（两个坑都已在项目内处理）**
>
> 1. **构件下载被墙**：electron-builder 需要额外从 GitHub 下载 Electron 二进制和 NSIS 打包器。
>    `scripts/pack.js` 已默认把 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`
>    指向 npmmirror 镜像，所以 `npm run pack` 可直接用，无需手动设环境变量。
> 2. **符号链接权限**：Windows 上改写 exe 图标/签名需要解压 `winCodeSign` 缓存，
>    而该缓存内含 macOS 用的符号链接 —— 普通权限账户创建符号链接会失败。
>    因此 `build.win.signAndEditExecutable` 默认设为 `false`（不影响功能，只是 exe 不带自定义图标）。
>    想要带图标的 exe：打开「设置 → 系统 → 开发者选项」里的**开发者模式**，
>    再把该项改回 `true` 重新打包。

### 打包产物的自动化验证

```powershell
# 用隔离的临时数据目录 + 打包后的 resources，模拟「全新用户 + 打包版」
$env:DAFENGSHU_RESOURCES = "$PWD\dist\win-unpacked\resources"
$env:DAFENGSHU_HOME = "$env:TEMP\dfsj-fresh-user"
node scripts/verify-packaged.js
```

实测结果（10/10 通过）：内核可执行并返回版本、随包规则集被识别为分流数据源、
全新用户无需联网即可生成配置并通过 `sing-box check`。

---

## 开发与验证

```powershell
npm test                        # 22 项单元测试（解析 / 订阅 / 配置生成 / 引用完整性）
node scripts/smoke.js           # 冒烟：真实链接解析 → 生成新旧两套配置
node scripts/runtime-check.js   # 端到端：真启动内核，验证端口/Clash API/国内直连/停止清理
node scripts/verify-packaged.js # 打包产物开箱即用验证（需先打包）
node bin/dfsj.js check          # 用真实内核校验生成的配置
```

`runtime-check.js` 的效果（本机实测）：

```
✅ 内核启动并就绪 — 2727ms
✅ 本地代理端口 2080 已监听
✅ Clash API 可读取内核版本 — sing-box 1.11.15
✅ 经本地代理访问国内站点（应为直连成功） — HTTP 200
✅ 停止后端口已释放
10/10 项通过
```

---

## 打包成 exe

```powershell
npm run pack     # 产物在 release/ 目录
```

---

## 常见问题

**客户端侧**

| 现象 | 处理 |
| --- | --- |
| 首次 `npm start` 卡在下载内核 | 用 `npm run fetch:core`（走 curl + 多镜像），或手动把 `sing-box.exe` 放进 `resources/bin/` |
| TUN 模式报权限错误 | 关掉软件，右键「以管理员身份运行」；或只用系统代理模式 |
| 点启动后目标站点仍打不开 | 「日志」页看有无 FATAL；点「检测 X 可达性」看具体错误；确认节点本身能通 |
| 国内网站变慢 | 确认「国内网站直连」开启，且 geo 数据源不是被手动设成了「只用软件内置域名表」 |
| 端口冲突 | 「分流」页改本地代理端口 / Clash API 端口 |
| 想完全卸载 | 停止加速 → 删除本目录即可（系统代理会在停止时还原） |

**排障速查（自建线路最容易踩的坑）**

| 现象 | 大概率原因 | 去做 |
| --- | --- | --- |
| ICMP 通、22 通、其它端口全不通 | IP 被针对性封锁 | 换 IP 或换机房 |
| 22 通、443 不通，服务端 `ss` 显示在监听 | 服务端 `ufw` 没放行 443 | `ufw allow 443/tcp` |
| **新开的机器 443 不通** | **正常现象** —— 还没装服务端，没人监听 | 装完服务端再测 |
| 日志 `REALITY: processed invalid connection`（几毫秒） | 客户端与服务端参数不匹配 | 比对 UUID / 公钥 / ShortId / flow |
| 握手成功但 `connection reset by peer` | 伪装目标不可达 | 换 SNI，如 `www.apple.com` |
| 突然全部不可达，几分钟后自己好了 | 密集请求触发的临时限速 | **等 5～10 分钟，别急着改配置** |
| 手机连不上电脑的局域网代理 | 路由器/中继器做了设备隔离 | 两台设备都连主路由器的 SSID |

> 完整排查过程、根因分析和复现命令见 **[调试实录.md](docs/调试实录.md)** —— 包含 8 个真实踩坑案例、
> `tcpdump` 抓包判读、sing-box 1.11→1.17 字段迁移对照表，以及一套分层定位方法论。

---

## 免责声明

本软件是通用的网络代理客户端，**不提供任何服务器、线路或订阅**。使用者需自行准备服务器，
并自行承担使用行为的一切后果与法律责任。请遵守你所在国家或地区的法律法规。

---

## 开源协议

[MIT](LICENSE) © 2026 Wonderow666

本软件是通用的网络代理客户端，**不提供任何服务器、线路或订阅**。
使用者需自行准备服务器，并自行承担使用行为的一切后果与法律责任。
请遵守你所在国家或地区的法律法规。
