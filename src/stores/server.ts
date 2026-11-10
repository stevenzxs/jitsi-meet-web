import { inDesktopShell } from './user'

const DESKTOP_SERVER_MSG = 'cloudmeet-server'
const DESKTOP_SERVER_GET_MSG = 'cloudmeet-server-get'
const DESKTOP_SERVER_SAVE_MSG = 'cloudmeet-server-save'

export interface CloudMeetServer {
  /** 当前生效的服务器地址（桌面工作台 URL） */
  url: string
  /** 桌面客户端编译期内置的默认地址 */
  defaultUrl: string
}

/** 桌面端保存服务器配置的确认回调：桌面端先写入存储，再推回 Web 端。 */
let pendingResolve: ((server: CloudMeetServer) => void) | null = null

/** 向桌面壳请求当前服务器配置；桌面端会以 cloudmeet-server 消息回推。 */
export function requestDesktopServer(): void {
  if (inDesktopShell()) {
    window.parent.postMessage({ type: DESKTOP_SERVER_GET_MSG }, '*')
  }
}

/**
 * 保存服务器地址到桌面壳（唯一权威存储）。
 * 保存成功或地址非法被回退时，桌面端都会回推生效配置；浏览器环境直接返回 null。
 */
export function saveServerToDesktop(url: string): Promise<CloudMeetServer | null> {
  if (!inDesktopShell()) {
    return Promise.resolve(null)
  }
  window.parent.postMessage({ type: DESKTOP_SERVER_SAVE_MSG, url: url.trim() }, '*')
  return new Promise<CloudMeetServer | null>((resolve) => {
    pendingResolve = resolve
    // 桌面端异常时兜底结束等待，避免设置页卡在保存中
    window.setTimeout(() => {
      if (!pendingResolve) return
      pendingResolve = null
      resolve(null)
    }, 2000)
  })
}

/** 监听桌面壳推送的服务器配置；收到后先结束挂起的保存回调，再交给页面更新状态。 */
export function onDesktopServer(handler: (server: CloudMeetServer) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string; server?: CloudMeetServer } | null
    if (!data || data.type !== DESKTOP_SERVER_MSG || !data.server?.url) return
    if (pendingResolve) {
      pendingResolve(data.server)
      pendingResolve = null
    }
    handler(data.server)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
