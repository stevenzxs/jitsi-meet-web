import type { JitsiMeetExternalAPI } from '../types/jitsi'

/**
 * 轮询布局的轨道/角色/名单工具。
 * 全部通过同源读取 Jitsi iframe 内 redux store 实现（与 meetingPermissions 同一适配通道），
 * 跨域或版本不符时静默降级为空结果，由调用方走占位/兜底。
 */

/** JitsiTrack 上本功能用到的最小接口（lib-jitsi-meet JitsiTrack 的子集）。 */
export interface PollingJitsiTrack {
  attach: (container: HTMLVideoElement) => unknown
  detach: (container: HTMLVideoElement) => unknown
  isMuted?: () => boolean
}

/** 与严格 grid-2 使用相同的 16:9、4px 单格间距、14px 外边距计算。 */
export function getPollingCardSize(viewportWidth: number, viewportHeight: number): { width: number; height: number } {
  const ratio = 16 / 9
  const availableWidth = Math.max(1, (viewportWidth - 2 * 4 - 14) / 2)
  const availableHeight = Math.max(1, Math.min(viewportHeight, viewportWidth / (2 * ratio)) - 14 - 4)
  if (availableWidth / availableHeight > ratio) {
    const height = Math.max(1, Math.floor(availableHeight))
    return { width: Math.max(1, Math.floor(height * ratio)), height }
  }
  const width = Math.max(1, Math.floor(availableWidth))
  return { width, height: Math.max(1, Math.floor(width / ratio)) }
}

interface JitsiTrackEntry {
  jitsiTrack?: PollingJitsiTrack
  mediaType?: string
  videoType?: string
  participantId?: string
  local?: boolean
  muted?: boolean
}

interface PollingParticipantState {
  id?: unknown
  name?: unknown
  role?: unknown
}

interface JitsiParticipantsState {
  local?: PollingParticipantState
  remote?: { forEach?: (callback: (participant: PollingParticipantState) => void) => void }
}

export interface PollingParticipantInfo {
  displayName: string
  local: boolean
  moderator: boolean
  audioMuted: boolean | null
  showModerator: boolean
  avatar: { initials: string; color: string }
}

/** 与 Jitsi Avatar 相同的首字符和按成员 ID 选色规则。 */
export function getTileAvatar(name: string, id: string): { initials: string; color: string } {
  const colors = ['#6A50D3', '#FF9B42', '#DF486F', '#73348C', '#B23683', '#F96E57', '#4380E2', '#238561', '#00A8B3']
  const base = name.split('@')[0] ?? ''
  let text = base
  const suffix = /\s*[([{][^)\]}]*[)\]}]$/
  while (suffix.test(text)) text = text.replace(suffix, '')
  const words = (text.trim() || base).split(/[\s._;,|/\\"'()#&-]+/).filter(Boolean)
  const first = (word = '') => Array.from(word)[0]?.toUpperCase() ?? ''
  const initials = first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')
  const sum = Array.from(id).reduce((value, char) => value + (char.codePointAt(0) ?? 0), 0)
  return { initials, color: colors[sum % colors.length]! }
}

/** 信息独立于摄像头轨道：关视频后仍显示姓名和音频状态，未知状态不冒充未静音。 */
export function getPollingParticipantInfo(api: JitsiMeetExternalAPI | null, id: string): PollingParticipantInfo | null {
  if (!id) return null
  const state = getIframeState(api)
  const participants = state?.['features/base/participants'] as JitsiParticipantsState | undefined
  const local = String(participants?.local?.id ?? '') === id
  let participant = local ? participants?.local : undefined
  if (!local) participants?.remote?.forEach?.((value) => {
    if (String(value.id ?? '') === id) participant = value
  })
  if (!participant) return null
  const tracks = state?.['features/base/tracks']
  const audio = Array.isArray(tracks) ? (tracks as JitsiTrackEntry[]).find((track) =>
    track.mediaType === 'audio' && (local ? track.local : !track.local && track.participantId === id),
  ) : undefined
  let defaults: { DEFAULT_LOCAL_DISPLAY_NAME?: string; DEFAULT_REMOTE_DISPLAY_NAME?: string } | undefined
  try {
    defaults = (api?.getIFrame()?.contentWindow as Window & { interfaceConfig?: typeof defaults })?.interfaceConfig
  } catch { /* 状态已读取，默认配置不可达时沿用 Jitsi 默认名称 */ }
  const displayName = typeof participant.name === 'string' && participant.name.trim() ? participant.name.trim()
    : local ? defaults?.DEFAULT_LOCAL_DISPLAY_NAME || 'me' : defaults?.DEFAULT_REMOTE_DISPLAY_NAME || 'Fellow Jitster'
  const config = state?.['features/base/config'] as { disableModeratorIndicator?: boolean } | undefined
  return {
    displayName,
    local,
    moderator: participant.role === 'moderator',
    audioMuted: typeof audio?.muted === 'boolean' ? audio.muted : audio?.jitsiTrack?.isMuted?.() ?? null,
    showModerator: participant.role === 'moderator' && !config?.disableModeratorIndicator,
    avatar: getTileAvatar(displayName, id),
  }
}

function getIframeState(api: JitsiMeetExternalAPI | null): Record<string, unknown> | null {
  if (!api) return null
  try {
    const frame = api.getIFrame()?.contentWindow as Window & {
      APP?: { store?: { getState?: () => Record<string, unknown> } }
    }
    return frame?.APP?.store?.getState?.() ?? null
  } catch {
    return null
  }
}

/** 当前会议主持人（实时角色）：本地是 moderator 则取本地，否则任一角色的远端 moderator；没有则空串。 */
export function getMeetingModeratorId(api: JitsiMeetExternalAPI | null): string {
  const participants = getIframeState(api)?.['features/base/participants'] as JitsiParticipantsState | undefined
  if (!participants) return ''
  if (participants.local?.role === 'moderator' && participants.local.id) {
    return String(participants.local.id)
  }
  let moderatorId = ''
  participants.remote?.forEach?.((participant) => {
    if (!moderatorId && participant?.role === 'moderator' && participant.id) {
      moderatorId = String(participant.id)
    }
  })
  return moderatorId
}

/** 指定参与者当前的摄像头轨道；本地用户按 local 标记匹配（其 participantId 固定为 'local'）。 */
export function getParticipantCameraTrack(
  api: JitsiMeetExternalAPI | null,
  participantId: string,
  localParticipantId: string,
): PollingJitsiTrack | null {
  if (!api || !participantId) return null
  const tracks = getIframeState(api)?.['features/base/tracks']
  if (!Array.isArray(tracks)) return null
  const entry = (tracks as JitsiTrackEntry[]).find((track) => {
    if (track?.mediaType !== 'video' || track?.videoType !== 'camera') return false
    if (participantId === localParticipantId) return Boolean(track.local)
    return !track.local && String(track.participantId ?? '') === participantId
  })
  return entry?.jitsiTrack ?? null
}

/**
 * 轮询组下一个成员（纯函数）：
 * 当前人仍在名单内 → 顺延一位（循环）；当前人已离开/为空 → 从游标处取，保证离会后不重复跳人。
 * 单人名单返回同一人，配合槽位幂等刷新不会反复重建视频。
 */
export function getNextPollingMemberId(
  ids: string[],
  currentId: string,
  cursor: number,
): { id: string; cursor: number } {
  if (!ids.length) return { id: '', cursor: 0 }
  const currentIndex = currentId ? ids.indexOf(currentId) : -1
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % ids.length : cursor % ids.length
  const nextCursor = (nextIndex + 1) % ids.length
  return { id: ids[nextIndex] ?? '', cursor: nextCursor }
}

export interface PollingCandidate {
  id: string
  displayName: string
  videoMuted: boolean
}

interface ParticipantInfoLike {
  id?: unknown
  participantId?: unknown
  displayName?: unknown
  isHidden?: unknown
  isJigasi?: unknown
  videoMuted?: unknown
}

/**
 * 轮询组勾选候选人：在线的非主持人真实参会者（主持人由调用方先算好传进来）。
 * 优先 getRoomsInfo（带 isHidden/isJigasi 过滤），低版本 Jitsi 降级 getParticipantsInfo。
 */
export async function getPollingCandidates(
  api: JitsiMeetExternalAPI | null,
  moderatorId: string,
): Promise<PollingCandidate[]> {
  if (!api) return []

  if (typeof api.getRoomsInfo === 'function') {
    try {
      const response = await api.getRoomsInfo(false)
      const rooms = Array.isArray(response) ? response : (response as { rooms?: unknown[] })?.rooms ?? []
      const mainRoom = rooms.find((room) => (room as { isMainRoom?: boolean })?.isMainRoom) ?? rooms[0]
      const participants = Array.isArray((mainRoom as { participants?: unknown[] })?.participants)
        ? (mainRoom as { participants: unknown[] }).participants
        : []
      const result: PollingCandidate[] = []
      const seen = new Set<string>()
      for (const raw of participants as ParticipantInfoLike[]) {
        const id = String(raw?.id || raw?.participantId || '')
        if (!id || id === moderatorId || Boolean(raw?.isHidden || raw?.isJigasi) || seen.has(id)) continue
        seen.add(id)
        const name = typeof raw?.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : '未命名成员'
        result.push({
          id,
          displayName: name,
          videoMuted: typeof raw?.videoMuted === 'boolean' ? raw.videoMuted : false,
        })
      }
      if (result.length) return result
    } catch {
      /* 低版本 Jitsi 无该方法或结构不符，降级走 getParticipantsInfo */
    }
  }

  try {
    const participants = api.getParticipantsInfo() as ParticipantInfoLike[]
    const result: PollingCandidate[] = []
    const seen = new Set<string>()
    for (const raw of participants) {
      const id = String(raw?.participantId || raw?.id || '')
      if (!id || id === moderatorId || seen.has(id)) continue
      seen.add(id)
      const name = typeof raw?.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : '未命名成员'
      result.push({ id, displayName: name, videoMuted: typeof raw?.videoMuted === 'boolean' ? raw.videoMuted : false })
    }
    return result
  } catch {
    return []
  }
}
