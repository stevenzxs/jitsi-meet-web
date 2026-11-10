/**
 * 前端运行时配置集中出口。
 * 地址、协议和开关都先在这里归一化，业务模块只消费已经清洗过的值。
 */
function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** Official FRP, legacy public and internal entries proxy the same service. */
export function resolveJitsiServerUrl(configuredUrl: string, pageOrigin: string): string {
  const configured = trimTrailingSlash(configuredUrl)
  if (configured === 'same-origin') return trimTrailingSlash(pageOrigin)
  if (configured === 'https://118.193.36.35:8443'
    && [configured, 'https://104.244.90.25:8443', 'https://192.168.199.202'].includes(pageOrigin)) {
    return pageOrigin
  }
  return configured
}

/**
 * 规范化 API 前缀，确保前端、Vite 代理和后端 context-path 使用同一种 /xxx 形式。
 */
function normalizePathPrefix(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

/**
 * 规范化 Electron 自定义协议，避免配置里写成 cloudmeet:// 后重复拼接。
 */
function normalizeProtocol(value: string): string {
  return value.trim().replace(/:\/?\/?$/, '')
}

export const appConfig = {
  apiBaseUrl: trimTrailingSlash((import.meta.env.VITE_API_BASE_URL as string) || ''),
  apiPrefix: normalizePathPrefix((import.meta.env.VITE_API_PREFIX as string) || '/mapi'),
  desktopProtocol: normalizeProtocol((import.meta.env.VITE_DESKTOP_PROTOCOL as string) || 'cloudmeet'),
  jitsiServerUrl: resolveJitsiServerUrl(
    (import.meta.env.VITE_JITSI_SERVER as string) || '',
    typeof window === 'undefined' ? '' : window.location.origin,
  ),
  prejoinEnabled: (import.meta.env.VITE_PREJOIN_ENABLED as string) === 'true',
}

/** Jitsi External API 需要裸域名，不能传带协议的 URL。 */
export function getJitsiHost(): string {
  return appConfig.jitsiServerUrl.replace(/^https?:\/\//, '')
}
export function getWebAppBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).href
}
