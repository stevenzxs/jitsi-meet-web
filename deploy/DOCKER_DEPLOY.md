# Docker 部署方案

## 115.190.243.21：Web 更新使用本地产物

这台机器只有约 2 GiB 内存。Web 更新在 Windows 本地执行 `npm run build`，上传 `dist`，然后通过仓库根目录的 `docker-compose.prebuilt.yml` 挂载静态文件。服务器上不要运行 `docker compose build web` 或 `up --build`。

在 `D:\code\jitsi` 的 PowerShell 中执行（示例发布目录按实际当前目录调整）：

```powershell
Set-Location D:\code\jitsi\jitsi-meet-web
npm run build
Set-Location D:\code\jitsi
tar.exe -czf web-dist.tar.gz -C jitsi-meet-web/dist .
scp -i C:\Users\ZL\.ssh\id_ed25519 web-dist.tar.gz root@115.190.243.21:/opt/jitsi-app/releases/redeploy_20261014_092001/web-dist.tar.gz
scp -i C:\Users\ZL\.ssh\id_ed25519 jitsi-meet-web/nginx.conf root@115.190.243.21:/opt/jitsi-app/releases/redeploy_20261014_092001/jitsi-meet-web/nginx.conf
scp -i C:\Users\ZL\.ssh\id_ed25519 docker-compose.prebuilt.yml root@115.190.243.21:/opt/jitsi-app/releases/redeploy_20261014_092001/docker-compose.prebuilt.yml
```

服务器只解压并启动，命令中的 `--no-build` 必须保留：

```bash
cd /opt/jitsi-app/releases/redeploy_20261014_092001
mkdir -p jitsi-meet-web/dist
tar -xzf web-dist.tar.gz -C jitsi-meet-web/dist
docker compose -p jitsi-app -f docker-compose.yml -f docker-compose.prebuilt.yml up -d --no-build --no-deps web
curl -kI https://127.0.0.1/cm/desktop
free -h
```

修改 Vue 源码时，也同步相应源码文件到服务器发布目录，使下次发布的源码与运行版本一致。Electron 客户端单独在本地打包；仅改 Web 无需重打 Electron。

## 1. 项目组成

当前目录包含三个子项目：

- `jitsi-meet-api`：Spring Boot 3 + MyBatis Plus + SQLite，提供会议创建、预约、校验、历史记录和主持人 Jitsi JWT 签发接口，默认端口 `9000`，默认前缀 `/mapi`。
- `jitsi-meet-web`：Vue 3 + Vite 前端，构建后部署在 `/cm/` 子路径，浏览器通过同源 `/mapi/` 调 API，通过 `VITE_JITSI_SERVER` 加载 Jitsi `external_api.js`。
- `jitsi-meet-electron`：桌面客户端壳，属于客户端安装包，不放入 Docker 部署；安装后访问 Web 地址，例如 `https://your-domain/cm/desktop`。

本仓库的 `docker-compose.yml` 只部署 `web + api` 两个容器。Jitsi Meet 服务端有两种接入方式：

- **方式 A（已有 Jitsi 服务端）**：`VITE_JITSI_SERVER` 指向已有的 Jitsi 地址（如内网 `https://192.168.199.203`）。
- **方式 B（单机全栈，云服务器推荐）**：在同一台机器上用官方 [docker-jitsi-meet](https://github.com/jitsi/docker-jitsi-meet) 部署 Jitsi 服务端，前置 Nginx 自签 HTTPS 统一入口。第 6 章为已落地的云服务器实例。

## 2. 部署架构

### 方式 A：web + api（对接已有 Jitsi）

```text
Browser / Electron
  -> http(s)://your-domain/cm/      -> web 容器 Nginx 静态文件
  -> http(s)://your-domain/mapi/    -> web 容器 Nginx 反代 api:9000/mapi/
  -> https://jitsi-domain/external_api.js -> 外部 Jitsi Meet 服务

api 容器
  -> /app/data/jitsi-meet-api.sqlite.db   -> 宿主机 ./data/api 持久化
```

### 方式 B：单机全栈（含 Jitsi 服务端）

```text
Browser / Electron
  -> https://server:443                  -> 宿主 Nginx（自签证书，统一入口）
     ├── /cm/   -> web 容器 (127.0.0.1:9000)
     ├── /mapi/ -> web 容器 -> api 容器
     └── 其余   -> jitsi web 容器 (127.0.0.1:8000)
                    ├── prosody（token 校验）
                    ├── jicofo（会议协调）
                    └── jvb（音视频桥，UDP 10000 对外）
```

> 生产环境建议使用域名 + 正式证书替换自签证书。会议摄像头、麦克风和屏幕共享依赖浏览器安全上下文，**纯 HTTP 下浏览器会直接禁用设备**，自签 HTTPS（浏览器点继续）即可正常使用。

## 3. 配置项

先复制配置模板：

```bash
cp .env.example .env
```

重点修改：

```env
WEB_HTTP_PORT=8080
VITE_JITSI_SERVER=https://192.168.199.203
JITSI_TOKEN_APP_ID=zhsz
JITSI_TOKEN_APP_SECRET=replace-with-real-secret
JITSI_TOKEN_DOMAIN=192.168.199.203
```

说明：

- `VITE_JITSI_SERVER` 是浏览器访问 Jitsi 的地址，必须带 `http://` 或 `https://`。
- `JITSI_TOKEN_DOMAIN` 是签进 JWT 的 `sub` 字段，必须等于 Jitsi Prosody 的 VirtualHost：
  - 对接裸机/自建 Jitsi：通常是域名或 IP（如 `192.168.199.203`）。
  - 对接 docker-jitsi-meet：**填 `meet.jitsi`**（容器内 XMPP 域，不是服务器 IP）。
- `JITSI_TOKEN_APP_SECRET` 必须使用生产密钥，不能使用模板值，且与 Jitsi 服务端 `app_secret` 一致。
- `VITE_API_BASE_URL` 默认留空，表示前端同源请求 `/mapi`，由 Web Nginx 反代到 API。
- Vite 环境变量是构建期写入的，修改 `VITE_*` 后需要重新构建前端镜像。

## 4. 启动（方式 A）

```bash
docker compose up -d --build
```

访问：

- Web 首页：`http://服务器IP:8080/cm/`
- 桌面端入口：`http://服务器IP:8080/cm/desktop`
- API 健康检查：`http://服务器IP:8080/mapi/actuator/health`

查看日志：

```bash
docker compose logs -f api
docker compose logs -f web
```

停止：

```bash
docker compose down
```

## 5. Jitsi 服务端要求（方式 A）

如果启用主持人 token，Jitsi 服务端需要与 API 配置保持一致：

```lua
VirtualHost "192.168.199.203"
    authentication = "token"
    app_id = "zhsz"
    app_secret = "<与 JITSI_TOKEN_APP_SECRET 一致>"
    allow_empty_token = true
```

Jitsi Meet 前端配置：

```js
enableUserRolesBasedOnToken: true
```

Jicofo 配置：

```hocon
jicofo {
  conference {
    enable-auto-owner = false
  }
}
```

## 6. 云服务器实例：115.190.243.21（方式 B，已落地）

2026-09-01 已完成部署，可直接照此复刻到新机。

### 6.1 架构与配置

- 宿主 Nginx（`sites-available/jitsi-gateway`）：443 自签 HTTPS，80 跳转；`/cm/`、`/mapi/` 代理到 `127.0.0.1:9000`（web 容器），其余路径代理到 `127.0.0.1:8000`（Jitsi web 容器）。
- Jitsi 栈：`/opt/docker-jitsi-meet`（stable-11146-2），`.env` 关键值：
  - `HTTP_PORT=127.0.0.1:8000`、`DISABLE_HTTPS=1`、`ENABLE_HTTP_REDIRECT=0`
  - `PUBLIC_URL=https://115.190.243.21`
  - `ENABLE_AUTH=1`、`AUTH_TYPE=jwt`、`JWT_APP_ID=zhsz`、`JWT_APP_SECRET=<与 203 相同>`、`JWT_ALLOW_EMPTY=1`
  - `JVB_ADVERTISE_IPS=115.190.243.21`
  - `JICOFO_MAX_MEMORY=384m`、`VIDEOBRIDGE_MAX_MEMORY=768m`（2G 内存机器必须限额）
  - JVB 镜像必须是 `ghcr.io/jitsi/jvb:stable-11146-2`。不要添加 `docker-compose.override.yml` 覆盖为 `gm-jvb`；该镜像曾导致 DTLS-SRTP 无共同加密配置，入会后看不到媒体。
- 应用栈：`/opt/jitsi-app`，`.env` 关键值：
  - `WEB_HTTP_PORT=127.0.0.1:9000`（只绑定本地，统一走 443 入口）
  - `VITE_JITSI_SERVER=https://115.190.243.21`
  - `JITSI_TOKEN_DOMAIN=meet.jitsi`（对接 docker-jitsi-meet 时固定此值）

### 6.2 云服务器部署步骤（新机复刻）

```bash
# 1. 安装 Docker（Ubuntu，国内用阿里云源）
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 2. Docker Hub 加速（基础镜像用；Jitsi 镜像走 ghcr 高校镜像站，见下）
cat > /etc/docker/daemon.json <<'EOF'
{"registry-mirrors":["https://docker.1ms.run","https://docker.m.daocloud.io","https://docker.1panel.live"]}
EOF
systemctl restart docker

# 3. 小内存机器加 swap
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 4. 上传本仓库源码到 /opt/jitsi-app（不含 electron/node_modules/target/dist）

# 5. 下载 docker-jitsi-meet 并拉镜像（ghcr 直连慢时用 NJU 镜像站 retag）
mkdir -p /opt/docker-jitsi-meet && cd /opt/docker-jitsi-meet
curl -sL https://api.github.com/repos/jitsi/docker-jitsi-meet/tarball/stable-11146-2 | tar -xz --strip-components=1
for img in web prosody jicofo jvb; do
  docker pull ghcr.nju.edu.cn/jitsi/$img:stable-11146-2
  docker tag ghcr.nju.edu.cn/jitsi/$img:stable-11146-2 ghcr.io/jitsi/$img:stable-11146-2
done
cp env.example .env && bash gen-passwords.sh
# 按 6.1 修改 .env
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}
mkdir -p ~/.jitsi-meet-cfg/storage/{web,prosody}
chown -R 1000:1000 ~/.jitsi-meet-cfg/storage/prosody   # 关键：否则 prosody 起不来
# 去 Jitsi 水印/品牌覆盖（白名单拦截前端覆盖，必须服务端下发，见 6.4 第 5 条）
cp deploy/docker-jitsi-meet/web/custom-interface_config.js ~/.jitsi-meet-cfg/web/
# Jitsi 会议界面主题样式（浅色主题/无视频白底等，见 6.4 第 6 条）
mkdir -p ~/.jitsi-meet-cfg/web/nginx-custom
cp jitsi-meet-web/src/assets/custom.css ~/.jitsi-meet-cfg/web/custom.css
cp deploy/docker-jitsi-meet/web/custom-head.html ~/.jitsi-meet-cfg/web/
cp deploy/docker-jitsi-meet/web/nginx-custom/custom-css.conf ~/.jitsi-meet-cfg/web/nginx-custom/
bash /opt/jitsi-app/deploy/docker-jitsi-meet/start-official-jitsi.sh

# 6. 应用栈：按 6.1 写 /opt/jitsi-app/.env 后
cd /opt/jitsi-app && docker compose up -d --build

# 7. 宿主 Nginx 自签 HTTPS 入口（参照 6.1，证书用 openssl 自签）
```

### 6.3 云安全组必须放行

| 端口 | 协议 | 用途 |
|---|---|---|
| 443 | TCP | HTTPS 统一入口 |
| 80 | TCP | 跳转 HTTPS（可选） |
| 10000 | UDP | JVB 音视频流（不放行则进会黑屏） |

### 6.4 踩过的坑

1. **prosody 崩溃重启**：`storage/prosody` 目录属主必须是容器 uid 1000（见上 `chown`）。
2. **JITSI_TOKEN_DOMAIN 填 IP 导致 token 无效**：对接 docker-jitsi-meet 时必须填 `meet.jitsi`。
3. **DaoCloud 镜像站对白名单外镜像返回 denied**：Jitsi 镜像用 `ghcr.nju.edu.cn` 或 ghcr 直连。
4. **sshd 对频繁连接限速**：批量操作写脚本一次执行，避免高频 SSH 往返。
5. **会议中仍显示 Jitsi 水印/默认 APP_NAME**：stable-11146 起 `interfaceConfigOverwrite` 有白名单，`SHOW_JITSI_WATERMARK`、`APP_NAME`、`MOBILE_APP_PROMO` 等被静默丢弃，前端覆盖无效。必须放 `custom-interface_config.js` 到 `~/.jitsi-meet-cfg/web/`（见 6.2 步骤），web 容器启动时自动追加进 `interface_config.js`。
6. **会议中浅色主题/无视频黑底不生效（custom.css 404）**：web 容器镜像只读，旧文档"改 /usr/share/jitsi-meet 里 index.html"的做法在容器重建后丢失。正确做法：`custom.css` + `custom-head.html` + `nginx-custom/custom-css.conf` 三个文件放进 `~/.jitsi-meet-cfg/web/`（见 6.2 步骤），启动时经 `cp -r /config/. /run/web/config` 和 nginx 别名生效。

## 7. 数据持久化和备份

SQLite 数据库保存在宿主机：

```text
./data/api/jitsi-meet-api.sqlite.db          # 本仓库相对路径
/opt/jitsi-app/data/api/jitsi-meet-api.sqlite.db   # 云服务器实际路径
```

备份示例：

```bash
mkdir -p backup
cp data/api/jitsi-meet-api.sqlite.db backup/jitsi-meet-api.sqlite.db.$(date +%Y%m%d%H%M%S)
```

升级镜像前建议先备份该文件。

## 8. 更新发布

```bash
git pull
docker compose build --no-cache
docker compose up -d
docker compose logs -f api web
```

云服务器无 git 仓库时，本地打包上传后重建（详见《云服务器使用指南.md》第五章）。

验证：

```bash
curl -f http://127.0.0.1:8080/healthz
curl -f http://127.0.0.1:8080/mapi/actuator/health
# 云服务器（统一 443 入口）
curl -kf https://115.190.243.21/cm/
curl -kf https://115.190.243.21/mapi/actuator/health
curl -kf https://115.190.243.21/external_api.js
```

## 9. 常见问题

- 页面空白或资源 404：确认访问路径是 `/cm/`，不是根路径；本方案已将根路径重定向到 `/cm/`。
- API 网络异常：确认 `web` 容器日志里没有 Nginx 反代错误，并检查 `api` 容器是否正常启动。
- 无法加载会议：确认 `VITE_JITSI_SERVER` 能从用户浏览器直接访问，并且能打开 `/external_api.js`。
- 主持人无法获得权限：确认 `JITSI_TOKEN_APP_ID`、`JITSI_TOKEN_APP_SECRET`、`JITSI_TOKEN_DOMAIN` 与 Jitsi 服务端完全一致（docker-jitsi-meet 的 domain 固定为 `meet.jitsi`）。
- 能进会但黑屏/无声音：云安全组 UDP 10000 未放行，或浏览器未授权摄像头/麦克风。
- 纯 HTTP 下摄像头不可用：改用 HTTPS（自签证书亦可）。
- 修改 `.env` 中 `VITE_*` 后不生效：重新执行 `docker compose up -d --build`，因为前端配置在构建时固化进静态文件。
