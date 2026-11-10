import type { JitsiMeetExternalAPI } from '../types/jitsi'
import { appConfig, getJitsiHost, getWebAppBaseUrl } from '../config/appConfig'

/** Jitsi 服务器地址 */
export const JITSI_SERVER = appConfig.jitsiServerUrl

/** 桌面客户端自定义协议；分享页会用它尝试唤起 Electron 应用 */
export const DESKTOP_PROTOCOL = appConfig.desktopProtocol

/** Jitsi 主机名（不带协议）—— JitsiMeetExternalAPI 构造参数必须是裸域名，否则会拼出 https://https://xxx 的错误链接 */
export const JITSI_HOST = getJitsiHost()

/** 主持人全员结束会议前发送给所有远端 iframe 的应用内信号，用于绕过 Jitsi 默认结束弹窗。 */
export const END_CONFERENCE_SIGNAL = 'cloudmeet:end-conference'

/** 主持人同步会议电子屏状态的应用内信号。 */
export const MEETING_BANNER_SIGNAL = 'cloudmeet:meeting-banner'
export const MEETING_BANNER_REQUEST_SIGNAL = 'cloudmeet:meeting-banner-request'

/**
 * 是否启用 Jitsi 自带 prejoin 预加入界面。
 * true  = 保留 prejoin，昵称由 Jitsi 的"用户名 + 加入"页收集；
 * false = 关闭 prejoin 直接入会，昵称必须由本系统在前端收集。
 */
export const PREJOIN_ENABLED = appConfig.prejoinEnabled

let externalApiCache: Promise<void> | null = null

function warmupJitsiConnection(server: string): void {
  try {
    const origin = new URL(server).origin
    if (!document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
      const preconnect = document.createElement('link')
      preconnect.rel = 'preconnect'
      preconnect.href = origin
      preconnect.crossOrigin = 'anonymous'
      document.head.appendChild(preconnect)
    }
    if (!document.head.querySelector(`link[rel="dns-prefetch"][href="${origin}"]`)) {
      const dnsPrefetch = document.createElement('link')
      dnsPrefetch.rel = 'dns-prefetch'
      dnsPrefetch.href = origin
      document.head.appendChild(dnsPrefetch)
    }
  } catch {
    // The actual script request below reports an invalid server URL.
  }
}

/** 动态加载 Jitsi 的 external_api.js（从自己的服务器加载，缓存避免重复注入） */
export function loadExternalApi(server: string = JITSI_SERVER): Promise<void> {
  if (!server) {
    return Promise.reject(new Error('未配置 VITE_JITSI_SERVER'))
  }
  if (window.JitsiMeetExternalAPI) {
    return Promise.resolve()
  }
  warmupJitsiConnection(server)
  if (externalApiCache) {
    return externalApiCache
  }
  externalApiCache = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `${server}/external_api.js`
    script.async = true
    script.onload = () => {
      if (window.JitsiMeetExternalAPI) {
        resolve()
      } else {
        reject(new Error('external_api.js 加载后未找到 JitsiMeetExternalAPI'))
      }
    }
    script.onerror = () => reject(new Error('external_api.js 加载失败，请检查 Jitsi 服务器地址'))
    document.head.appendChild(script)
  }).catch((error) => {
    // 加载失败时释放缓存，允许用户修正配置后重新加载。
    externalApiCache = null
    throw error
  })
  return externalApiCache
}

let apiInstance: JitsiMeetExternalAPI | null = null

export function getApi(): JitsiMeetExternalAPI | null {
  return apiInstance
}

export function setApi(api: JitsiMeetExternalAPI | null): void {
  apiInstance = api
}

/**
 * 解析 Jitsi endpointTextMessageReceived 的文本内容。
 * External API 的事件结构在不同版本里可能落在 eventData、data 或第二参数中。
 */
export function getEndpointMessage(payload: unknown, fallback?: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload === 'object') {
    const event = payload as {
      message?: unknown
      eventData?: { text?: unknown; message?: unknown }
      data?: {
        text?: unknown
        message?: unknown
        eventData?: { text?: unknown; message?: unknown }
      }
    }
    if (typeof event.eventData?.text === 'string') return event.eventData.text
    if (typeof event.eventData?.message === 'string') return event.eventData.message
    if (typeof event.data?.eventData?.text === 'string') return event.data.eventData.text
    if (typeof event.data?.eventData?.message === 'string') return event.data.eventData.message
    if (typeof event.data?.text === 'string') return event.data.text
    if (typeof event.data?.message === 'string') return event.data.message
    if (typeof event.message === 'string') return event.message
  }
  return typeof fallback === 'string' ? fallback : ''
}

/** 生成 9 位数字会议号（首位不为 0） */
export function generateMeetingId(): string {
  const first = Math.floor(Math.random() * 9) + 1
  let rest = ''
  for (let i = 0; i < 8; i++) {
    rest += Math.floor(Math.random() * 10)
  }
  return `${first}${rest}`
}

/** 会议号展示格式化：123456789 -> 123 456 789 */
export function formatMeetingId(id: string | undefined | null): string {
  const digits = (id ?? '').replace(/\D/g, '')
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ').trim()
}

/** 仅保留数字并限制长度 */
export function sanitizeMeetingId(input: string, max = 9): string {
  return input.replace(/\D/g, '').slice(0, max)
}

/** 生成随机密码（可读性较好的字母数字组合，默认 6 位） */
export function generatePassword(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let result = ''
  const array = new Uint32Array(length)
  crypto.getRandomValues(array)
  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length]
  }
  return result
}

/** 生成随机数字密码（默认 6 位，用于预定会议） */
export function generateNumericPassword(length = 6): string {
  let result = ''
  const array = new Uint32Array(length)
  crypto.getRandomValues(array)
  for (let i = 0; i < length; i++) {
    result += array[i] % 10
  }
  return result
}

/** 组装腾讯会议风格的邀请文案 */
export function buildInviteText(opts: { subject: string; roomName: string; password: string }): string {
  const { subject, roomName, password } = opts
  const lines = [
    `【邀请您参加会议】`,
    `主题：${subject || '我的会议'}`,
    `会议号：${roomName}`,
    password ? `密码：${password}` : '',
    // 链接指向【邀请中转页】而非 Jitsi 直链；中转页会按平台尝试唤起桌面端，并保留 Web 兜底。
    `会议链接：${buildMeetingLink(roomName, subject)}`,
    password ? `打开链接输入密码，即可直接进入会议。` : `打开链接即可直接进入会议。`,
  ]
  return lines.filter(Boolean).join('\n')
}

/** 桌面客户端唤起链接（只放会议上下文，不把密码写入 URL，避免泄露到聊天记录/剪贴板） */
export function buildDesktopMeetingLink(roomName: string, subject = ''): string {
  const url = new URL(`${DESKTOP_PROTOCOL}://join`)
  url.searchParams.set('room', roomName)
  // 桌面端必须回到当前 Web 项目承载会议页，包含 /cm/ 这类部署前缀。
  url.searchParams.set('web', getWebAppBaseUrl())
  if (subject.trim()) {
    url.searchParams.set('subject', subject.trim())
  }
  return url.href
}

/** Web 会议页链接（协议唤起失败、移动端或纯浏览器场景的兜底入口） */
export function buildWebMeetingLink(roomName: string): string {
  return new URL(`meeting/${roomName}`, getWebAppBaseUrl()).href
}

/** 通用邀请链接（分享给参会人，打开后由 /invite 按平台决定桌面端或 Web 兜底） */
export function buildMeetingLink(roomName: string, subject = ''): string {
  const url = new URL('invite', getWebAppBaseUrl())
  url.searchParams.set('room', roomName)
  if (subject.trim()) {
    url.searchParams.set('subject', subject.trim())
  }
  return url.href
}
