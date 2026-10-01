# DaFengShu Accelerator

[简体中文](README.md) · **English**

A **Windows desktop client** for routing traffic through your own server, built on
[sing-box](https://sing-box.sagernet.org/). It provides a GUI, a system tray, node management,
latency testing, subscription import, system proxy and TUN mode — plus a **LAN sharing** feature
so your phone or tablet can reuse the PC's tunnel over Wi-Fi.

> **This project does not provide any servers, nodes or subscriptions.**
> You need your own VPS (see [Server Setup Guide](docs/VPS-服务端搭建.md)) or an existing
> subscription link. The software handles the client side only.

```
┌──────────────┐   TUN / system proxy   ┌────────────────┐   your encrypted link   ┌──────────────┐
│ Browser/apps │ ─────────────────────▶ │  This client   │ ──────────────────────▶ │  Your server │ ──▶ Internet
│              │                        │  (sing-box)    │                         │  (you own it)│
└──────────────┘                        └────────────────┘                         └──────────────┘
```

---

## Contents

- [Why this project exists](#why-this-project-exists)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Build from source](#build-from-source)
- [CLI](#cli)
- [Testing & verification](#testing--verification)
- [Architecture](#architecture)
- [Two implementation details worth knowing](#two-implementation-details-worth-knowing)
- [Troubleshooting](#troubleshooting)
- [The debugging story](#the-debugging-story)
- [License](#license)

---

## Why this project exists

Most proxy clients assume a working network path and a stable config schema. In practice,
when you build your own server you hit problems that no client helps you diagnose:

- the server's firewall silently drops packets while every self-check on the server looks fine
- the client silently generates a config your kernel version no longer accepts
- the endpoint gets throttled after a burst of requests, then recovers a few minutes later
- your phone can't reach the PC's proxy because of the Wi-Fi repeater in between

This client was written to make those cases **observable**: it validates the generated config with
the real kernel before every start, checks that every referenced outbound/rule-set actually exists,
adapts its output to the kernel's schema version, and ships a CLI that can be used when the GUI
can't tell you enough.

---

## Features

| Feature | Notes |
| --- | --- |
| **Schema-adaptive config** | Detects at startup whether the kernel speaks the legacy (≤1.11) or modern (1.12+) schema, and emits the matching format. Wrong-shaped configs make sing-box exit with `FATAL`, so this is decided empirically, not assumed. |
| **Split routing** | Selected domains are forced through the proxy (highest priority); LAN, China domains and China IPs go direct; everything else goes through the proxy. |
| **DNS anti-poisoning** | Proxied domains resolve over encrypted DoH **through the tunnel**; China domains use a domestic resolver so CDNs resolve to nearby IPs. |
| **System proxy or TUN** | System proxy needs no privileges; TUN takes over every program but requires Administrator. |
| **LAN sharing** | Bind the proxy to `0.0.0.0` so phones/tablets on the same Wi-Fi can use it. Includes the Windows firewall rule. |
| **Latency & reachability tests** | Per-node latency, and a direct "can I actually reach the target service" probe. |
| **Subscriptions** | Clash/mihomo YAML, base64 link lists, and plain link lists. Shows traffic quota and expiry. |
| **Safe to stop** | The original system-proxy state is backed up and restored, including after a crash. |
| **Protocols** | vless, vmess, trojan, ss, hysteria2, tuic, socks, http — with ws / grpc / h2 / httpupgrade transports, REALITY and uTLS fingerprints. |

---

## Install

### Option A — download the installer

Grab `dafengshu-accelerator-*-setup.exe` from
[**Releases**](https://github.com/Wonderow666/dafengshu-accelerator/releases) and run it.

The sing-box kernel and the China routing rule-sets are **bundled inside the package**, so the
first run needs **no downloads at all**.

> The installer is **not code-signed**, so Windows SmartScreen may warn about an unknown publisher.

### Option B — build from source

```powershell
npm install
npm run fetch:core      # downloads the sing-box kernel (multi-mirror, retries)
npm run rulesets        # downloads the China routing rule-sets (optional but recommended)
npm start
```

---

## Quick start

1. **Nodes** tab → paste a share link (`vless://…`, `trojan://…`, `ss://…`, `hysteria2://…`) → *Import*
   — or **Subscriptions** tab → paste your subscription URL → *Add and update*
2. **Accelerate** tab → press the big round button
3. Use the *Check reachability* button to confirm the tunnel actually works end-to-end

**TUN mode** (takes over every program) requires running the app **as Administrator**.

**Let your phone share the PC's tunnel**:

1. Accelerate tab → turn on **LAN sharing** (a firewall rule is added for you)
2. The card below shows the host and port to use, e.g. `192.168.1.8` / `2080`
3. On the phone: *Wi-Fi → current network → Proxy → Manual*, enter that host and port
4. Both devices must be on the **same Wi-Fi network**

---

## Build from source

```powershell
npm run pack        # NSIS installer  → dist\dafengshu 加速-*-安装包.exe
npm run pack:dir    # unpacked app dir → dist\win-unpacked\
```

The build copies the **kernel**, the **routing rule-sets** and the **icons** into `resources/`,
so the resulting package works offline on first run.

Two environment quirks are already handled by `scripts/pack.js`:

| Quirk | Handling |
| --- | --- |
| electron-builder downloads Electron and NSIS from GitHub, which is unreachable from some networks | `pack.js` defaults `ELECTRON_MIRROR` and `ELECTRON_BUILDER_BINARIES_MIRROR` to public mirrors |
| Editing the exe icon requires unpacking `winCodeSign`, which contains macOS symlinks that a non-elevated account cannot create | `build.win.signAndEditExecutable` is set to `false` (does not affect functionality; enable Windows Developer Mode and flip it back to `true` if you want a custom exe icon) |

### CI

[`.github/workflows/build.yml`](.github/workflows/build.yml) builds the installer on every push to
`main` (uploaded as an artifact) and publishes a Release when a `v*` tag is pushed.

---

## CLI

The core is deliberately **Electron-free**, so everything is scriptable:

```powershell
node bin/dfsj.js status                    # kernel / nodes / subscriptions / system proxy / latency
node bin/dfsj.js add "vless://…"           # add a node
node bin/dfsj.js sub "https://…"           # import a subscription
node bin/dfsj.js nodes                     # list nodes
node bin/dfsj.js use 2                     # switch to node #2
node bin/dfsj.js check                     # generate config and validate it with the real kernel
node bin/dfsj.js show                      # print the generated config
node bin/dfsj.js start --tun               # run in the foreground (Ctrl+C to stop)
node bin/dfsj.js test                      # latency test every node
node bin/dfsj.js twitter                   # probe whether the target service is reachable
node bin/dfsj.js logs 100                  # tail logs
node bin/dfsj.js kernel install            # install/update the kernel
node bin/dfsj.js reset                     # clear nodes and subscriptions
```

---

## Testing & verification

Everything below runs **without Electron**:

```powershell
npm test                        # 22 unit tests: link parsing, subscriptions, config generation,
                                #               and reference-integrity checks
node scripts/smoke.js           # parses real share links, generates BOTH config schemas
node scripts/runtime-check.js   # end-to-end: really starts the kernel and verifies
                                # ports / Clash API / direct-routing / clean shutdown
node scripts/verify-packaged.js # verifies the packaged build works for a fresh user offline
node bin/dfsj.js check          # validates the generated config with the real sing-box binary
```

`runtime-check.js` output on a real machine:

```
OK  内核启动并就绪 — 2727ms
OK  本地代理端口 2080 已监听
OK  Clash API 可读取内核版本 — sing-box 1.11.15
OK  经本地代理访问国内站点（应为直连成功） — HTTP 200
OK  停止后端口已释放
10/10 项通过
```

---

## Architecture

```
src/core/        Pure Node core — no Electron dependency, shared by GUI and CLI
  app.js         Application facade: start/stop, subscriptions, latency tests
  config.js      sing-box config generation (schema-adaptive)
  nodes.js       Share link ↔ node model ↔ sing-box outbound
  subscription.js Subscription parsing (Clash YAML / base64 / plain link list)
  geo.js         Rule-set acquisition and geo data-source decision
  process.js     Kernel process lifecycle (validate / start / health-check / stop)
  kernel.js      Kernel download (multi-mirror + version fallback)
  system-proxy.js Windows system proxy (+ LAN addresses, firewall rules)
  speedtest.js   Real-link latency testing via the Clash API
  store.js       Persistence for settings and nodes
src/main/        Electron main process (window / tray / IPC)
src/renderer/    UI (plain HTML/CSS/JS — no build step)
scripts/         Kernel fetch, icon generation, packing, smoke/OCR/runtime checks
docs/            Server setup guide, VPS buying guide, debugging notes (Chinese)
test/            node:test unit tests
```

---

## Two implementation details worth knowing

### 1. Schema detection instead of schema assumptions

sing-box 1.12 moved DNS servers from `{ "address": "1.1.1.1" }` to
`{ "type": "https", "server": "1.1.1.1" }`, and later versions removed `inbound.sniff`,
self-defined `direct` outbounds, DNS `detour`, `independent_cache` and the TUN `stack` field.

**A field in the wrong place makes sing-box exit immediately with `FATAL`.** So instead of assuming
a version, the client **probes the installed kernel with a minimal config** and generates the
matching schema. It also validates the finished config with the real kernel before every start,
and checks that every referenced outbound, rule-set and DNS server actually exists.

### 2. Offline-first routing data

China-direct routing normally needs `geosite`/`geoip` data, but those built-ins are deprecated
(1.8) and removed (1.12+), and the rule-set mirrors are often unreachable exactly when you need
them most — during first setup, before any tunnel exists.

So rule-sets are **downloaded at build time and bundled**, with a runtime fallback chain:

```
bundled/local rule-sets  →  download from mirrors  →  built-in geo (with the required env vars)  →  internal domain-suffix table
```

The app therefore routes correctly on first run with no network access.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| ICMP works, port 22 works, **every other port is dead** | the IP is being blocked specifically | change IP or region |
| Port 22 works, 443 is closed, but the server shows it listening | server-side `ufw` did not allow 443 | `ufw allow 443/tcp` |
| **A freshly created server fails the 443 test** | **expected** — nothing is listening on 443 yet | install the server first, then test |
| `REALITY: processed invalid connection` (a few ms) | client/server parameter mismatch | compare UUID / public key / short id / flow |
| Handshake succeeds, then `connection reset by peer` | the disguise target is unreachable | switch SNI (e.g. to `www.apple.com`) |
| Everything suddenly dies, works again minutes later | burst-triggered throttling | **wait 5–10 minutes, do not change config** |
| Phone can't reach the PC's LAN proxy | router/repeater isolates clients | put both devices on the main router's SSID |

Full write-up with packet captures and the migration table:
**[docs/调试实录.md](docs/调试实录.md)** (Chinese).

---

## The debugging story

Building this client involved a long, real debugging session. The notes document **8 concrete
failure modes** with symptom → diagnosis → root cause → fix, including:

1. Deleting machines because a fresh server "fails" the 443 test (it has nothing listening yet)
2. Vultr's Debian image ships with `ufw` enabled, allowing only port 22
3. REALITY parameter mismatches — and why key pairs must be *derived*, not remembered
4. Choosing a bad disguise target (Akamai-hosted endpoints were unstable; Apple's worked)
5. Changing the SSH port without opening it in the firewall first
6. sing-box schema migration across 1.11 → 1.17
7. A Wi-Fi repeater silently isolating the phone from the PC
8. Datacenter IPs being rate-limited by the destination service

Read it here: **[docs/调试实录.md](docs/调试实录.md)**.
There is also a [VPS buying guide](docs/VPS-购买指南.md) and a
[server setup guide](docs/VPS-服务端搭建.md) (both Chinese).

---

## License

[MIT](LICENSE) © 2026 Wonderow666

This is a general-purpose network proxy client. It **does not provide any server, node or
subscription**. Users must provide their own server and are solely responsible for how they use it.
Please comply with the laws and regulations of your jurisdiction.
