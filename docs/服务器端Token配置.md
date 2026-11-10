# 服务端 Token（JWT）配置

> 当前实现：前端不再生成 JWT，主持人令牌统一由 `jitsi-meet-api` 服务端签发。

## 1. 调用链路

```text
Web/Electron
  └─ POST /open/desktop/meetings/{roomName}/host-token
       ├─ jitsi-meet-api 校验 roomName + hostKey
       ├─ 使用服务端 JITSI_TOKEN_APP_SECRET 签发 HS256 JWT
       └─ Jitsi external_api.js 带 jwt 入会
```

前端只保存主持人密钥，不保存 Jitsi `app_secret`。

## 2. jitsi-meet-api 配置

`C:\Users\92999\Desktop\workspace\Java\jitsi-meet-api\src\main\resources\application.yml`

```yaml
server:
  port: ${SERVER_PORT:9000}

jitsi-token:
  app-id: ${JITSI_TOKEN_APP_ID:zhsz}
  app-secret: ${JITSI_TOKEN_APP_SECRET:change-me}
  domain: ${JITSI_TOKEN_DOMAIN:192.168.199.203}
  ttl-hours: ${JITSI_TOKEN_TTL_HOURS:168}
```

生产环境必须通过环境变量提供真实 `JITSI_TOKEN_APP_SECRET`。

## 3. 前端配置

前端默认同源调用 `/open/...`，开发环境由 Vite 代理到 API 服务：

```env
VITE_API_BASE_URL=
VITE_API_PROXY_TARGET=http://localhost:9000
```

生产环境建议 Nginx 同源转发：

```nginx
location /open/ {
  proxy_pass http://127.0.0.1:9000/open/;
}
```

## 4. Jitsi 服务端要求

Prosody 的 `app_id`、`app_secret`、VirtualHost 域名必须与 `jitsi-meet-api` 的 `jitsi-token` 配置一致。

```lua
VirtualHost "192.168.199.203"
    modules_enabled = {
        "token_verification";
    }
    app_id = "zhsz"
    app_secret = "<与 JITSI_TOKEN_APP_SECRET 一致>"
    allow_empty_token = true
```

Jitsi Meet 配置需要启用基于 token 的角色：

```js
enableUserRolesBasedOnToken: true
```

Jicofo 需要关闭先进者自动成为主持人：

```hocon
jicofo {
  conference {
    enable-auto-owner = false
  }
}
```
