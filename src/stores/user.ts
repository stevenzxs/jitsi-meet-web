const USER_KEY = 'cloudmeet-user-v1'
const DESKTOP_USER_MSG = 'cloudmeet-user'
const DESKTOP_USER_GET_MSG = 'cloudmeet-user-get'
const DESKTOP_USER_SAVE_MSG = 'cloudmeet-user-save'
const DESKTOP_USER_SYNC_MSG = 'cloudmeet-user-sync'

export interface CloudMeetUser {
  name: string
  userId: string
  legacyUserIds?: string[]
}

/** 桌面端保存用户的确认回调：桌面端先写入存储，再推回 Web 端 store。 */
let pendingResolve: ((user: CloudMeetUser) => void) | null = null

/** 读取当前用户（本地缓存）；未设置用户名时返回 null。 */
export function getUser(): CloudMeetUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    if (!raw) return null
    const user = normalizeUser(JSON.parse(raw) as CloudMeetUser)
    if (user) persistUser(user)
    return user
  } catch {
    return null
  }
}

/** 写入本地缓存（Web 端 store），桌面端同步来的用户也走这里。 */
export function persistUser(user: CloudMeetUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  } catch {
    /* 存储不可用时忽略，桌面端仍持有用户 */
  }
}

/** 仅浏览器兜底：首次生成 UUID 用户 ID；后续改昵称时沿用旧 ID。 */
export async function saveUser(name: string): Promise<CloudMeetUser> {
  const trimmed = name.trim()
  const existing = getUser()
  const user: CloudMeetUser = {
    name: trimmed,
    userId: existing?.userId || createUserId(),
    ...(existing?.legacyUserIds?.length ? { legacyUserIds: existing.legacyUserIds } : {}),
  }
  persistUser(user)
  return user
}

/** 查询用户创建的会议时同时携带旧 ID，保证历史预定会议仍能显示和取消。 */
export function getCreatorIds(user?: CloudMeetUser | null): string[] {
  if (!user?.userId) return []
  return [user.userId, ...(user.legacyUserIds ?? [])].filter((id, index, ids) => !!id && ids.indexOf(id) === index)
}

/** 是否运行在桌面壳的 iframe 内（同步走桌面存储）。 */
export function inDesktopShell(): boolean {
  return typeof window !== 'undefined' && window.parent !== window
}

/** 向桌面壳请求当前用户；桌面端会以 cloudmeet-user 消息回推。 */
export function requestDesktopUser(): void {
  if (inDesktopShell()) {
    window.parent.postMessage({ type: DESKTOP_USER_GET_MSG }, '*')
  }
}

/** 桌面端还没有用户时，把本地缓存的用户补存到桌面端，避免双向丢失。 */
export function syncLocalUserToDesktop(user: CloudMeetUser): void {
  if (inDesktopShell() && user?.name) {
    // ref 包裹的用户对象是响应式代理，postMessage 结构化克隆会失败，这里只发纯对象
    window.parent.postMessage(
      { type: DESKTOP_USER_SYNC_MSG, user: { name: user.name, userId: user.userId, legacyUserIds: user.legacyUserIds ?? [] } },
      '*',
    )
  }
}

/** 保存用户名：桌面端存储为唯一权威来源，保存成功后再同步回 Web 端 store。 */
export function saveUserToDesktop(name: string): Promise<CloudMeetUser> {
  if (!inDesktopShell()) {
    return saveUser(name)
  }
  window.parent.postMessage({ type: DESKTOP_USER_SAVE_MSG, name: name.trim() }, '*')
  return new Promise<CloudMeetUser>((resolve) => {
    pendingResolve = resolve
    // 桌面端异常时回退本地计算，避免用户被卡在弹窗里
    window.setTimeout(() => {
      if (!pendingResolve) return
      pendingResolve = null
      resolve(saveUser(name))
    }, 2000)
  })
}

/** 监听桌面壳推送的用户；收到后先写入本地 store，再交给页面更新状态。 */
export function onDesktopUser(handler: (user: CloudMeetUser) => void): () => void {
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string; user?: CloudMeetUser } | null
    if (!data || data.type !== DESKTOP_USER_MSG || !data.user?.name || !data.user.userId) return
    persistUser(data.user)
    if (pendingResolve) {
      pendingResolve(data.user)
      pendingResolve = null
    }
    handler(data.user)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

function createUserId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  } catch {
    const bytes = new Uint8Array(8)
    crypto.getRandomValues(bytes)
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
}

/** 旧版本使用 32 位 ID；新版本展示和创建都使用 16 位短 ID，并把旧值作为查询兼容 ID。 */
function normalizeUser(user: CloudMeetUser | null): CloudMeetUser | null {
  if (!user || typeof user.name !== 'string' || !user.name.trim()) return null
  const normalized = normalizeUserId(user.userId)
  const legacyUserIds = mergeLegacyUserIds(normalized.legacyUserIds, user.legacyUserIds)
  return {
    name: user.name.trim(),
    userId: normalized.userId,
    ...(legacyUserIds.length ? { legacyUserIds } : {}),
  }
}

function normalizeUserId(userId: string): { userId: string; legacyUserIds: string[] } {
  if (typeof userId !== 'string') return { userId: createUserId(), legacyUserIds: [] }
  const trimmed = userId.trim().toLowerCase()
  if (/^[a-f0-9]{16}$/.test(trimmed)) return { userId: trimmed, legacyUserIds: [] }
  if (/^[a-f0-9]{32}$/.test(trimmed)) return { userId: trimmed.slice(0, 16), legacyUserIds: [trimmed] }
  return { userId: createUserId(), legacyUserIds: [] }
}

function mergeLegacyUserIds(...groups: Array<string[] | undefined>): string[] {
  return groups
    .flatMap((group) => group ?? [])
    .map((id) => (typeof id === 'string' ? id.trim().toLowerCase() : ''))
    .filter((id, index, ids) => /^[a-f0-9]{32}$/.test(id) && ids.indexOf(id) === index)
}
