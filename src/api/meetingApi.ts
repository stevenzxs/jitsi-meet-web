import { addScheduled, getCreatorRecoveryKey, getMeetingCredentials, removeCreatorRecoveryKey, saveCreatorRecoveryKey, saveMeetingCredentials, listScheduled, removeScheduled, replaceScheduled, type ScheduledMeeting } from '../stores/meeting'
import { del, get, post, put } from './request'

type MeetingStatus = 'SCHEDULED' | 'RUNNING' | 'ENDED' | 'CANCELLED'

interface DesktopMeetingRecord {
  id: string
  roomName: string
  subject: string
  status: MeetingStatus
  scheduledStartTime: string
  scheduledEndTime: string
  startedAt?: string | null
  endedAt?: string | null
  password?: string | null
  displayName?: string | null
  hostKey?: string | null
  creatorId?: string | null
}

interface InstantMeetingPayload {
  roomName: string
  subject: string
  password: string
  displayName: string
  hostKey: string
  creatorId: string
}

function creatorRecoveryKey(roomName: string): string {
  const existing = getCreatorRecoveryKey(roomName)
  if (existing) return existing
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  saveCreatorRecoveryKey(roomName, key)
  return key
}

export interface JoinMeetingCheckResult {
  roomName: string
  subject: string
  status: MeetingStatus
  scheduledEndTime?: string | null
  passwordRequired: boolean
}

export interface MeetingHistoryItem {
  id: string
  roomName: string
  subject: string
  status: MeetingStatus
  startTime: number
  endTime: number
  password: string
  displayName: string
  hostKey: string
  creatorId: string
}

/** 把服务端会议响应转换成现有首页/桌面页可直接使用的预定会议模型。 */
function toScheduledMeeting(record: DesktopMeetingRecord): ScheduledMeeting {
  const start = new Date(record.scheduledStartTime)
  const end = new Date(record.scheduledEndTime)
  const durationMin = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000))
  return {
    roomName: record.roomName,
    subject: record.subject,
    date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    time: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`,
    durationMin,
    endTime: end.getTime(),
    password: getMeetingCredentials(record.roomName)?.password ?? '',
    displayName: record.displayName ?? '',
    hostKey: getMeetingCredentials(record.roomName)?.hostKey ?? '',
    creatorId: record.creatorId ?? '',
    createdAt: record.startedAt ? new Date(record.startedAt).getTime() : start.getTime(),
  }
}

/** 历史会议保留服务端状态，用于桌面端区分快速会议、预定会议和已取消记录。 */
function toMeetingHistoryItem(record: DesktopMeetingRecord): MeetingHistoryItem {
  return {
    id: record.id,
    roomName: record.roomName,
    subject: record.subject,
    status: record.status,
    startTime: new Date(record.scheduledStartTime).getTime(),
    endTime: new Date(record.scheduledEndTime).getTime(),
    password: getMeetingCredentials(record.roomName)?.password ?? '',
    displayName: record.displayName ?? '',
    hostKey: getMeetingCredentials(record.roomName)?.hostKey ?? '',
    creatorId: record.creatorId ?? '',
  }
}

/** 前端兜底过滤历史记录，避免旧后端返回进行中或未开始的会议。 */
function isHistoricalMeeting(item: MeetingHistoryItem): boolean {
  return ['CANCELLED', 'ENDED'].includes(item.status) || Date.now() >= item.endTime
}

/** 从服务端读取当前用户创建的可见会议；支持短 ID 和旧 ID 同查，便于无损迁移用户 ID。 */
export async function fetchScheduledMeetings(creatorId?: string | string[]): Promise<ScheduledMeeting[]> {
  const creatorIds = Array.isArray(creatorId) ? creatorId.filter(Boolean) : creatorId ? [creatorId] : []
  try {
    const recordGroups = creatorIds.length
      ? await Promise.all(creatorIds.map((id) => get<DesktopMeetingRecord[]>('/open/desktop/meetings', { creatorId: id })))
      : [await get<DesktopMeetingRecord[]>('/open/desktop/meetings')]
    const records = recordGroups.flat()
    const meetings = Array.from(new Map(records.map((record) => [record.roomName, toScheduledMeeting(record)])).values())
    replaceScheduled(meetings)
    return meetings
  } catch (error) {
    console.warn('读取服务端会议失败，使用浏览器缓存兜底', error)
    const cached = listScheduled()
    return creatorIds.length ? cached.filter((meeting) => creatorIds.includes(meeting.creatorId ?? '')) : cached
  }
}

/** 查询当前用户创建过的历史会议；短 ID 和旧 ID 并查后按会议号去重。 */
export async function fetchMeetingHistory(creatorId?: string | string[]): Promise<MeetingHistoryItem[]> {
  const creatorIds = Array.isArray(creatorId) ? creatorId.filter(Boolean) : creatorId ? [creatorId] : []
  try {
    const recordGroups = creatorIds.length
      ? await Promise.all(creatorIds.map((id) => get<DesktopMeetingRecord[]>('/open/desktop/meetings/history', { creatorId: id })))
      : [await get<DesktopMeetingRecord[]>('/open/desktop/meetings/history')]
    const records = recordGroups.flat()
    return Array.from(new Map(records.map((record) => [record.roomName, toMeetingHistoryItem(record)])).values())
      .filter(isHistoricalMeeting)
      .sort((a, b) => b.startTime - a.startTime)
  } catch (error) {
    console.warn('读取服务端历史会议失败', error)
    return []
  }
}

/** 保存预定会议到服务端，同时写入浏览器缓存以保留当前页面的主持人快捷入口。 */
export async function saveScheduledMeeting(meeting: ScheduledMeeting): Promise<void> {
  addScheduled(meeting)
  const recoveryKey = creatorRecoveryKey(meeting.roomName)
  try {
    const record = await post<DesktopMeetingRecord>('/open/desktop/meetings/schedule', {
      roomName: meeting.roomName,
      subject: meeting.subject,
      password: meeting.password,
      displayName: meeting.displayName,
      hostKey: meeting.hostKey,
      creatorId: meeting.creatorId,
      creatorRecoveryKey: recoveryKey,
      scheduledStartTime: new Date(`${meeting.date}T${meeting.time}`).toISOString(),
      durationMinutes: meeting.durationMin,
    })
    addScheduled(toScheduledMeeting(record))
  } catch (error) {
    console.warn('保存服务端预定会议失败，已保留浏览器缓存', error)
  }
}

/** 创建即时会议也写入 SQLite，后续后台和首页都能看到真实创建记录。 */
export async function createInstantMeeting(payload: InstantMeetingPayload): Promise<void> {
  saveMeetingCredentials(payload.roomName, payload)
  const recoveryKey = creatorRecoveryKey(payload.roomName)
  try {
    await post<DesktopMeetingRecord>('/open/desktop/meetings', {
      ...payload,
      creatorRecoveryKey: recoveryKey,
      subject: payload.subject || '我的会议',
      durationMinutes: 60 * 24, // 1 天，避免服务端过期
    })
  } catch (error) {
    console.warn('保存服务端即时会议失败，继续使用当前会话入会', error)
  }
}

/** 加入会议前由服务端统一校验存在性、结束时间和会议密码，校验通过后才允许打开会议窗口。 */
export async function checkJoinMeeting(roomName: string, password: string): Promise<JoinMeetingCheckResult> {
  return post<JoinMeetingCheckResult>(`/open/desktop/meetings/${roomName}/join-check`, {
    password,
  })
}

/** 主持人结束会议时同步服务端状态，确保快速会议立即出现在历史会议中。 */
export async function endMeeting(roomName: string, hostKey: string): Promise<void> {
  await post<void>(
    `/open/desktop/meetings/${roomName}/end`,
    { hostKey },
    {
      headers: {
        repeatSubmit: false,
      },
    },
  )
}

/** 参会人真实进入 Jitsi 后上报入会事件，用于把预定会议切换为进行中。 */
export async function reportParticipantJoined(roomName: string, participantId: string): Promise<void> {
  await post<void>(
    `/open/desktop/meetings/${roomName}/participants/join`,
    { participantId },
    {
      headers: {
        repeatSubmit: false,
      },
    },
  )
}

/** 取消预定须携带本地管理凭据；服务端成功后才移除缓存，失败向页面反馈。 */
export async function cancelScheduledMeeting(roomName: string, _creatorId?: string, hostKey?: string): Promise<void> {
  const key = hostKey || getMeetingCredentials(roomName)?.hostKey
  if (!key) throw new Error('本机未保存主持人密钥，无法取消会议')
  await del<void>(`/open/desktop/meetings/${roomName}`, { headers: { 'X-Host-Key': key } })
  removeScheduled(roomName)
}

/** 删除历史会议记录；只删除服务端历史数据，不影响仍在进行或未开始的会议。 */
export async function deleteHistoryMeeting(roomName: string, _creatorId?: string, hostKey?: string): Promise<void> {
  const key = hostKey || getMeetingCredentials(roomName)?.hostKey
  if (!key) throw new Error('本机未保存主持人密钥，无法删除会议')
  await del<void>(`/open/desktop/meetings/${roomName}/history`, { headers: { 'X-Host-Key': key } })
  removeCreatorRecoveryKey(roomName)
}

/** 会议电子屏状态，与 MeetingStage 端侧同步结构保持一致（position 固定 top，无需传输）。 */
export interface MeetingBannerPayload {
  visible: boolean
  text: string
  fontSize: number
  color: string
  fontFamily: string
  bgColor: string
  /** 会标图片相对地址（/cm/banner-logos/...），空串表示无会标。 */
  logoUrl: string
  updatedAt: number
}

/** 读取唯一服务端主题；失败保留已有显示，由后续刷新恢复。 */
export async function fetchMeetingBanner(roomName: string): Promise<MeetingBannerPayload | null> {
  try {
    const data = await get<MeetingBannerPayload | null>(`/open/desktop/meetings/${roomName}/banner`)
    return data ?? null
  } catch (error) {
    console.warn('读取服务端会议主题失败，等待重试', error)
    return null
  }
}

/** 主持人保存电子屏时持久化到服务端，保证迟到入会者也能拿到最新状态。 */
export async function saveMeetingBanner(roomName: string, hostKey: string, banner: MeetingBannerPayload): Promise<MeetingBannerPayload> {
  return post<MeetingBannerPayload>(
    `/open/desktop/meetings/${roomName}/banner`,
    { hostKey, ...banner },
    {
      headers: {
        repeatSubmit: false,
      },
    },
  )
}

/** 会标图片限制：类型与大小需与 nginx client_max_body_size 及下载路径白名单保持一致。 */
export const BANNER_LOGO_MAX_BYTES = 2 * 1024 * 1024
export const BANNER_LOGO_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp'

const BANNER_LOGO_EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
}

/** 会标下载地址（所有参会人可读），与 web 容器 nginx 的下载 location 对应。 */
export function bannerLogoUrl(roomName: string, fileName: string): string {
  return `/cm/banner-logos/${roomName}/${fileName}`
}

/** 会标库目录名：跨会议共享，所有已上传会标都存这里，便于下次开会直接复用。 */
const BANNER_LOGO_LIBRARY = 'library'

/** 原始文件名清洗为 nginx 白名单允许的 ASCII 形态，保留辨识度；清洗后为空则回退 logo。 */
function sanitizeLogoFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const cleaned = base
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return cleaned || 'logo'
}

/**
 * 上传会标图片到共享会标库：API 持有写栅栏并直接落盘。
 * 返回所有参会人可访问的相对下载地址。
 */
export async function uploadBannerLogo(roomName: string, hostKey: string, file: File): Promise<string> {
  const ext = BANNER_LOGO_EXT_BY_TYPE[file.type]
  if (!ext) {
    throw new Error('会标仅支持 PNG / JPG / SVG / WebP 图片')
  }
  if (file.size > BANNER_LOGO_MAX_BYTES) {
    throw new Error('会标图片不能超过 2MB')
  }
  const fileName = `${Date.now()}-${sanitizeLogoFileName(file.name)}.${ext}`
  await put<void, File>(
    `/open/desktop/meetings/${encodeURIComponent(roomName)}/banner/logos/${BANNER_LOGO_LIBRARY}/${fileName}`,
    file,
    { headers: { 'Content-Type': file.type, 'X-Host-Key': hostKey, repeatSubmit: false } },
  )
  return bannerLogoUrl(BANNER_LOGO_LIBRARY, fileName)
}

/** 删除已上传的会标图片（替换/移除时清理旧文件）；失败仅记录日志，不影响主流程。 */
export async function deleteBannerLogo(logoUrl: string, hostKey: string, roomName?: string): Promise<void> {
  const match = /^\/cm\/banner-logos\/(\d+|library)\/([A-Za-z0-9._-]+)$/.exec(logoUrl)
  if (!match) return
  if (!roomName) return
  try {
    await del<void>(`/open/desktop/meetings/${encodeURIComponent(roomName)}/banner/logos/${match[1]}/${match[2]}`,
      { headers: { 'X-Host-Key': hostKey } })
  } catch (error) {
    console.warn('删除旧会标图片失败', error)
  }
}

/** 会标库条目，对应 nginx autoindex JSON 的单个文件项。 */
export interface BannerLogoItem {
  name: string
  url: string
  size: number
  mtime: string
}

/** 浏览会标库：读取 nginx autoindex JSON 列表，按修改时间倒序返回；库不存在或读取失败时返回空数组。 */
export async function listBannerLogos(): Promise<BannerLogoItem[]> {
  try {
    const response = await fetch(`/cm/banner-logos/${BANNER_LOGO_LIBRARY}/`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return []
    const items = (await response.json()) as Array<{ name?: string; type?: string; size?: number; mtime?: string }>
    return items
      .filter((item) => item.type === 'file' && !!item.name && /\.(png|jpe?g|svg|webp)$/i.test(item.name))
      .map((item) => ({
        name: item.name as string,
        url: bannerLogoUrl(BANNER_LOGO_LIBRARY, item.name as string),
        size: Number(item.size) || 0,
        mtime: String(item.mtime ?? ''),
      }))
      .sort((a, b) => b.mtime.localeCompare(a.mtime))
  } catch (error) {
    console.warn('读取会标库列表失败', error)
    return []
  }
}
