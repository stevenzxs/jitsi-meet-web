import { getCurrentTheme } from './theme'

const OPEN_MEETING_MSG = 'cloudmeet-open-meeting'

export interface DesktopMeetingWindowParams {
  roomName: string
  subject?: string
  displayName?: string
  password?: string
  hostKey?: string
  endTime?: number
}

/**
 * 在桌面壳中把会议放到独立的新窗口打开。
 * 会议页通过 desktopJoin query 在新窗口重建会话（昵称/密码/主持人密钥/结束时间）。
 */
export function openMeetingInDesktopWindow(href: string, params: DesktopMeetingWindowParams): void {
  const target = new URL(href, window.location.href)
  target.searchParams.set('desktopJoin', '1')
  // 独立会议窗口与主窗口不是同一个文档，URL 携带主题能确保首屏就使用一致主题。
  target.searchParams.set('theme', getCurrentTheme())
  if (params.subject) target.searchParams.set('subject', params.subject)
  if (params.displayName) target.searchParams.set('displayName', params.displayName)
  if (params.password) target.searchParams.set('password', params.password)
  if (params.hostKey) target.searchParams.set('hostKey', params.hostKey)
  if (params.endTime) target.searchParams.set('endTime', String(params.endTime))
  console.info('[meeting-perf] desktop open-window postMessage')
  window.parent.postMessage({ type: OPEN_MEETING_MSG, url: target.href }, '*')
}
