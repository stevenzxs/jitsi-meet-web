import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // 开发代理目标只从配置读取，避免前端代码里散落服务端地址。
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:9000'
  // API 前缀与后端 API_CONTEXT_PATH 保持一致，开发环境不 rewrite，直接透传 /mapi。
  const apiPrefix = `/${(env.VITE_API_PREFIX || '/mapi').trim().replace(/^\/+|\/+$/g, '')}`

  return {
    // 部署在服务器 nginx 的 /cm/ 子路径下（location /cm/ { root /data/web/; ... }）
    base: '/cm/',
    plugins: [vue()],
    // The supported Android device uses Chromium WebView 83. Vite's default
    // baseline allows logical assignment, which prevents the app from parsing.
    build: {
      target: 'chrome83',
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        // 开发环境使用同源 API 前缀访问 jitsi-meet-api，后端无需开启 CORS。
        [apiPrefix]: apiProxyTarget,
      },
    },
  }
})
