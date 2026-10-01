# 服务端搭建指南（VPS + sing-box）

> **重要**：本软件只是「客户端」，它负责把你电脑上的推特流量加密后送到一台境外服务器。
> **那台服务器需要你自己准备**（一台海外 VPS）。软件本身不提供、也不出售任何线路。
> 如果你已经有「机场订阅链接」，可以跳过本文，直接在软件的「订阅」页导入。

> 📖 **还没买服务器？** 先看 [购买 VPS 指南](VPS-购买指南.md) —— 里面讲了怎么挑机房、避坑（IP 被封、流量不够、年付陷阱）以及下单流程。

---

## 0. 先明确三件事

| 项目 | 说明 |
| --- | --- |
| VPS 位置 | 首选 **日本 / 新加坡 / 韩国 / 美国西海岸**（离你近、推特访问快）。香港线路延迟最低但部分 IP 已被 X 风控 |
| 系统 | **Debian 12** 或 **Ubuntu 22.04/24.04**（本文命令以此为准） |
| 配置 | 1 核 512MB 起步足够，日本节点月付通常 3～6 美元 |

买好 VPS 后，你会拿到：**IP 地址**、**root 密码**（或 SSH 密钥）。
先用 SSH 登录一次，确认能连上：

```bash
ssh root@你的服务器IP
```

---

## 1. 一条命令装好服务端

登录 VPS 后，按顺序执行：

```bash
# 更新系统
apt update && apt upgrade -y

# 装依赖
apt install -y curl wget unzip openssl

# 下载 sing-box 服务端（1.11.15，与本客户端内置内核同版本，兼容性最好）
cd /root
curl -LO https://github.com/SagerNet/sing-box/releases/download/v1.11.15/sing-box-1.11.15-linux-amd64.tar.gz

# 如果上面这条卡住不动，说明你从服务器访问 GitHub 也不快，改用镜像：
# curl -LO https://gh-proxy.com/https://github.com/SagerNet/sing-box/releases/download/v1.11.15/sing-box-1.11.15-linux-amd64.tar.gz

tar -xzf sing-box-1.11.15-linux-amd64.tar.gz
install -m 755 sing-box-1.11.15-linux-amd64/sing-box /usr/local/bin/sing-box
sing-box version   # 能打印版本号就成功了
```

---

## 2. 推荐方案：VLESS + Reality（不需要域名、不需要证书）

**为什么选它**：不需要买域名、不需要申请 TLS 证书，流量特征接近正常 HTTPS，
在你所在网络环境下被识别的概率最低；客户端只需填 4 个参数。

### 2.1 生成密钥与 UUID

```bash
# 生成 Reality 密钥对（记住输出的 PrivateKey 和 PublicKey）
sing-box generate reality-keypair

# 生成一个 UUID 当作你的身份凭据
sing-box generate uuid

# 生成 short id
sing-box generate rand --hex 8
```

把这三样记下来，例如：

```
PrivateKey:  ████（服务端用，不要外传）
PublicKey:   ████（客户端用，等下要填）
UUID:        ████（客户端用）
ShortId:     ████（两边都要）
```

### 2.2 写服务端配置

```bash
cat > /etc/sing-box/config.json <<'EOF'
{
  "log": { "level": "warn", "timestamp": true },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "::",
      "listen_port": 443,
      "users": [
        {
          "uuid": "把这里换成你的 UUID",
          "flow": "xtls-rprx-vision"
        }
      ],
      "tls": {
        "enabled": true,
        "server_name": "www.microsoft.com",
        "reality": {
          "enabled": true,
          "handshake": {
            "server": "www.microsoft.com",
            "server_port": 443
          },
          "private_key": "把这里换成你的 PrivateKey",
          "short_id": ["把这里换成你的 ShortId"]
        }
      }
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ]
}
EOF
```

> `server_name` / `handshake.server` 用 `www.microsoft.com` 这类**境外大站**即可，
> 它的作用是让 Reality 伪装成访问该站点的 TLS 流量。同一个域名要在两处保持一致。

### 2.3 设置开机自启

```bash
cat > /etc/systemd/system/sing-box.service <<'EOF'
[Unit]
Description=sing-box service
After=network.target nss-lookup.target

[Service]
User=root
ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/config.json
Restart=on-failure
RestartSec=5s
LimitNOFILE=infinity

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now sing-box
systemctl status sing-box --no-pager     # 看到 active (running) 即成功
```

### 2.4 放行端口

```bash
# 如果 VPS 商家后台有安全组/防火墙，也要在后台放行 443/TCP
ufw allow 443/tcp 2>/dev/null || true
```

### 2.5 拿到客户端链接

把下面内容填好后，就是可以粘进本软件「节点」页的分享链接：

```
vless://你的UUID@你的服务器IP:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.microsoft.com&fp=chrome&pbk=你的PublicKey&sid=你的ShortId&type=tcp#日本-Reality
```

在软件里：**节点 → 粘贴链接 → 导入节点**，然后回到「加速」页启动。

---

## 3. 备选方案：Trojan / Shadowsocks

如果你想用更简单的协议（例如给路由器用），参考下面两段最小配置。

<details>
<summary>Trojan + 自签证书（需要域名）</summary>

```bash
# 用你的域名申请证书（这里以 acme.sh 为例）
curl https://get.acme.sh | sh -s email=你的邮箱
~/.acme.sh/acme.sh --issue -d 你的域名 --standalone
~/.acme.sh/acme.sh --install-cert -d 你的域名 \
  --key-file /etc/sing-box/key.pem --fullchain-file /etc/sing-box/cert.pem
```

```json
{
  "inbounds": [
    {
      "type": "trojan",
      "listen": "::",
      "listen_port": 443,
      "users": [{ "password": "自己设一个强密码", "flow": "xtls-rprx-vision" }],
      "tls": {
        "enabled": true,
        "server_name": "你的域名",
        "certificate_path": "/etc/sing-box/cert.pem",
        "key_path": "/etc/sing-box/key.pem"
      }
    }
  ],
  "outbounds": [{ "type": "direct", "tag": "direct" }]
}
```

客户端链接：

```
trojan://你的密码@你的域名:443?security=tls&sni=你的域名&type=tcp#香港-Trojan
```

</details>

<details>
<summary>Shadowsocks 2022（最简单，抗封锁一般）</summary>

```bash
sing-box generate rand --base64 16   # 生成密码
```

```json
{
  "inbounds": [
    {
      "type": "shadowsocks",
      "listen": "::",
      "listen_port": 8388,
      "method": "2022-blake3-aes-128-gcm",
      "password": "上一步生成的密码"
    }
  ],
  "outbounds": [{ "type": "direct", "tag": "direct" }]
}
```

客户端链接（`method:password` 需要 base64）：

```
ss://<base64(2022-blake3-aes-128-gcm:密码)>@你的服务器IP:8388#新加坡-SS
```

</details>

---

## 4. 验证服务端是否正常

**在服务器上**自测：

```bash
ss -lntp | grep -E '443|8388'          # 端口在监听
journalctl -u sing-box -n 30 --no-pager # 看有没有报错
```

**在你自己电脑上**（Windows PowerShell）：

```powershell
Test-NetConnection 你的服务器IP -Port 443
# TcpTestSucceeded : True 表示端口通
```

如果端口不通：八成是 VPS 商家后台的安全组没放行，去后台加一条 443/TCP 入站规则。

---

## 5. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 软件启动后推特还是打不开 | 看「日志」页有没有 `FATAL`；先在软件里点「检测 X 可达性」看具体错误 |
| 节点延迟测试全部失败 | 服务端没起或端口没放行；先在电脑上 `Test-NetConnection` 确认端口 |
| 能上 Google 但上不了 X | X 对 IP 风控较严，换节点地区（日本/新加坡通常比香港好） |
| 国内网站变慢 | 确认「国内网站直连」是开启状态；见 README 的分流说明 |
| TUN 模式启动报权限错误 | 关掉程序，右键「以管理员身份运行」；或只用系统代理模式 |
| 443 端口被占用 | 服务器上原有 Nginx 等在占用，改 `listen_port` 并把客户端链接里的端口一起改 |

---

## 6. 安全提醒

- 本文所有密码、UUID、密钥都请自行重新生成，**不要照抄示例**。
- 不要把服务端配置、订阅链接发到公开场合，那等于把你的线路送给别人用。
- 定期 `apt upgrade`，保持系统与内核为较新版本。
- 请遵守你所在地区的法律法规使用网络服务。
