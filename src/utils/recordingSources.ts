/**
 * 定向录制的源选择器（纯函数）+ 同源 iframe store 适配器。
 * 契约以 Task 1 实测为准（docs/plans/2026-10-21-recording-modes-design.md）：
 * - 麦克风 = mediaType 'audio' 且 videoType !== 'desktop'（共享电脑声音永不入选，也不做混音降级）；
 * - 桌面视频 = videoType 'desktop'（条目 mediaType 是 'screenshare'，勿按 mediaType 判）；
 * - 共享停止 = 桌面条目驻留但 muted:true；"活跃共享" = 存在未静音桌面轨道；
 * - 静音/关摄像头 = 目标轨道 muted:true；ended 轨道视为缺席。
 */

export type RecordingMode = 'host-camera' | 'shared-screen' | 'composite'

export function normalizeRecordingMode(mode: unknown): RecordingMode {
  return mode === 'shared-screen' || mode === 'composite' ? mode : 'host-camera'
}

/** store 轨道条目的最小结构（features/base/tracks 条目）。 */
export interface RecordingTrackEntry {
  participantId?: string
  local?: boolean
  mediaType?: string
  videoType?: string
  muted?: boolean
  jitsiTrack?: {
    getId?: () => string
    getType?: () => string
    getVideoType?: () => string
    isMuted?: () => boolean
    getTrack?: () => { readyState?: string } | null
  } | null
}

export interface RecordingParticipantSnapshot {
  id?: unknown
  role?: unknown
  name?: unknown
}

export interface RecordingStateSnapshot {
  participants?: {
    local?: RecordingParticipantSnapshot
    remote?: RecordingParticipantSnapshot[] | Map<unknown, RecordingParticipantSnapshot>
  }
  tracks?: RecordingTrackEntry[]
}

export interface RecordingSourceSelection {
  overlay?: RecordingSourceSelection['video']
  microphones?: RecordingSourceSelection['microphone'][]
  mode: RecordingMode
  /** 目标参与者 id；无目标（no-host / no-active-share）为空串。 */
  targetId: string
  reason: string
  video: { present: boolean; muted: boolean; track: RecordingTrackEntry | null }
  microphone: { present: boolean; muted: boolean; track: RecordingTrackEntry | null }
  /** 共享身份（participantId:trackId），用于绑定具体共享源、识别接替。 */
  share: { active: boolean; ended: boolean; identity: string }
}

function entryTrackId(entry: RecordingTrackEntry): string {
  try {
    return String(entry.jitsiTrack?.getId?.() ?? '')
  } catch {
    return ''
  }
}

function entryUnderlyingEnded(entry: RecordingTrackEntry | null): boolean {
  if (!entry) return false
  try {
    return entry.jitsiTrack?.getTrack?.()?.readyState === 'ended'
  } catch {
    return false
  }
}

function entryMuted(entry: RecordingTrackEntry | null): boolean {
  if (!entry) return true
  if (typeof entry.muted === 'boolean') return entry.muted
  try {
    return Boolean(entry.jitsiTrack?.isMuted?.())
  } catch {
    return true
  }
}

function remoteList(participants: RecordingStateSnapshot['participants']): RecordingParticipantSnapshot[] {
  const remote = participants?.remote
  if (!remote) return []
  if (Array.isArray(remote)) return remote
  if (typeof (remote as Map<unknown, RecordingParticipantSnapshot>).forEach === 'function') {
    const list: RecordingParticipantSnapshot[] = []
    ;(remote as Map<unknown, RecordingParticipantSnapshot>).forEach((value) => list.push(value))
    return list
  }
  return []
}

/** 与 pollingLayout.getMeetingModeratorId 同一权威源：本地 moderator 优先，否则第一个远端 moderator。 */
export function getModeratorParticipantId(participants: RecordingStateSnapshot['participants']): string {
  if (!participants) return ''
  if (participants.local?.role === 'moderator' && participants.local.id) {
    return String(participants.local.id)
  }
  for (const participant of remoteList(participants)) {
    if (participant?.role === 'moderator' && participant.id) return String(participant.id)
  }
  return ''
}

function entriesForParticipant(
  tracks: RecordingTrackEntry[],
  participantId: string,
  isLocalTarget: boolean,
): RecordingTrackEntry[] {
  if (!participantId) return []
  // 本地参与者的 store 轨道条目 participantId 固定为 'local'，必须按 local 标记匹配。
  return tracks.filter((track) => {
    if (isLocalTarget) return Boolean(track.local)
    if (track.local) return false
    return String(track.participantId ?? '') === participantId
  })
}

/** 目标参与者的麦克风候选：audio 且非 desktop。0 条=无声（合法），≥2 条=混合音频风险（拒绝）。 */
function selectMicrophone(
  candidates: RecordingTrackEntry[],
): { present: boolean; muted: boolean; track: RecordingTrackEntry | null; ambiguous: boolean } {
  const mics = candidates.filter((track) => track.mediaType === 'audio' && track.videoType !== 'desktop')
  if (mics.length === 0) return { present: false, muted: true, track: null, ambiguous: false }
  if (mics.length > 1) return { present: false, muted: true, track: null, ambiguous: true }
  const track = mics[0]!
  return { present: !entryUnderlyingEnded(track), muted: entryMuted(track), track, ambiguous: false }
}

function emptySelection(mode: RecordingMode): RecordingSourceSelection {
  return {
    mode, targetId: '', reason: '',
    video: { present: false, muted: true, track: null },
    microphone: { present: false, muted: true, track: null },
    share: { active: false, ended: false, identity: '' },
  }
}

function sharerIsLocal(snapshot: RecordingStateSnapshot, sharerId: string): boolean {
  return Boolean(sharerId) && String(snapshot.participants?.local?.id ?? '') === sharerId
}

function selectHostCamera(snapshot: RecordingStateSnapshot): RecordingSourceSelection {
  const selection = emptySelection('host-camera')
  const hostId = getModeratorParticipantId(snapshot.participants)
  if (!hostId) {
    selection.reason = 'no-host'
    return selection
  }
  selection.targetId = hostId
  const hostIsLocal = String(snapshot.participants?.local?.id ?? '') === hostId
  const candidates = entriesForParticipant(snapshot.tracks ?? [], hostId, hostIsLocal)
  const mic = selectMicrophone(candidates)
  if (mic.ambiguous) {
    selection.reason = 'ambiguous-mic'
    return selection
  }
  const cameras = candidates.filter((track) => track.mediaType === 'video' && track.videoType === 'camera')
  const camera = cameras[0] ?? null
  selection.microphone = { present: mic.present, muted: mic.muted, track: mic.track }
  selection.video = {
    present: Boolean(camera) && !entryUnderlyingEnded(camera),
    muted: !camera || entryUnderlyingEnded(camera) || entryMuted(camera),
    track: camera,
  }
  return selection
}

function selectSharedScreen(snapshot: RecordingStateSnapshot): RecordingSourceSelection {
  const selection = emptySelection('shared-screen')
  const tracks = snapshot.tracks ?? []
   const desktopEntries = tracks.filter((track) => track.videoType === 'desktop'
    && track.mediaType !== 'audio')
  const active = desktopEntries.filter((track) => !entryMuted(track) && !entryUnderlyingEnded(track))
  const latest = active[active.length - 1] ?? null
  if (active.length > 1) {
    // 多活跃共享：身份不唯一，拒绝随机选取。
    selection.reason = 'ambiguous-share'
    selection.share = { active: false, ended: false, identity: '' }
    return selection
  }
  if (!latest) {
    // 无活跃共享：可能从未开始（no-active-share），也可能刚停止（驻留 muted 条目）。
    const lingering = desktopEntries[desktopEntries.length - 1] ?? null
    selection.reason = 'no-active-share'
    if (lingering) {
      const sharerId = String(lingering.local ? snapshot.participants?.local?.id ?? '' : lingering.participantId ?? '')
      selection.targetId = sharerId
      selection.share = {
        active: false,
        ended: entryUnderlyingEnded(lingering),
        identity: sharerId ? `${sharerId}:${entryTrackId(lingering)}` : '',
      }
      const mic = selectMicrophone(entriesForParticipant(tracks, sharerId, sharerIsLocal(snapshot, sharerId)))
      if (mic.ambiguous) {
        selection.reason = 'ambiguous-mic'
        return selection
      }
      selection.microphone = { present: mic.present, muted: mic.muted, track: mic.track }
    }
    return selection
  }
  const sharerId = String(latest.local ? snapshot.participants?.local?.id ?? '' : latest.participantId ?? '')
  selection.targetId = sharerId
  selection.share = { active: true, ended: false, identity: `${sharerId}:${entryTrackId(latest)}` }
  selection.video = { present: true, muted: false, track: latest }
  const mic = selectMicrophone(entriesForParticipant(tracks, sharerId, sharerIsLocal(snapshot, sharerId)))
  if (mic.ambiguous) {
    selection.reason = 'ambiguous-mic'
    selection.share.active = false
    return selection
  }
  selection.microphone = { present: mic.present, muted: mic.muted, track: mic.track }
  return selection
}

/** 纯选择入口：给定 store 快照与模式，返回目标/轨道/静音/共享身份。 */
export function selectRecordingSource(
  snapshot: RecordingStateSnapshot,
  mode: RecordingMode,
): RecordingSourceSelection {
  if (mode === 'composite') {
    const host = selectHostCamera(snapshot)
    const share = selectSharedScreen(snapshot)
    return { ...share, mode, reason: share.reason || host.reason, overlay: host.video,
      microphones: host.targetId === share.targetId ? [host.microphone] : [host.microphone, share.microphone] }
  }
  return mode === 'shared-screen' ? selectSharedScreen(snapshot) : selectHostCamera(snapshot)
}

// ---------- 同源 iframe store 适配器（与 pollingLayout 同一通道） ----------

interface IframeStoreLike {
  getState?: () => Record<string, unknown>
  subscribe?: (listener: () => void) => () => void
}

function snapshotFromState(state: Record<string, unknown> | null | undefined): RecordingStateSnapshot {
  if (!state) return {}
  const participants = state['features/base/participants'] as RecordingStateSnapshot['participants']
  let remote = participants?.remote
  if (remote && !Array.isArray(remote) && typeof (remote as { values?: () => Iterable<RecordingParticipantSnapshot> }).values === 'function') {
    remote = Array.from((remote as Map<unknown, RecordingParticipantSnapshot>).values())
  }
  return {
    participants: participants ? { local: participants.local, remote } : undefined,
    tracks: Array.isArray(state['features/base/tracks']) ? state['features/base/tracks'] as RecordingTrackEntry[] : [],
  }
}

export interface RecordingSourcesAdapter {
  /** store 不可达时返回 null（跨域/未入会），调用方走兜底。 */
  snapshot: () => RecordingStateSnapshot | null
  select: (mode: RecordingMode) => RecordingSourceSelection | null
  subscribe: (listener: () => void) => () => void
}

export function createRecordingSourcesAdapter(api: { getIFrame?: () => HTMLIFrameElement | null | undefined } | null): RecordingSourcesAdapter {
  const store = (): IframeStoreLike | null => {
    try {
      const frame = api?.getIFrame?.()?.contentWindow as (Window & { APP?: { store?: IframeStoreLike } }) | null
      return frame?.APP?.store ?? null
    } catch {
      return null
    }
  }
  return {
    snapshot: () => {
      const current = store()
      try {
        return current?.getState ? snapshotFromState(current.getState()) : null
      } catch {
        return null
      }
    },
    select: (mode) => {
      const snapshot = (() => {
        const current = store()
        try {
          return current?.getState ? snapshotFromState(current.getState()) : null
        } catch {
          return null
        }
      })()
      return snapshot ? selectRecordingSource(snapshot, mode) : null
    },
    subscribe: (listener) => {
      const current = store()
      if (typeof current?.subscribe !== 'function') return () => {}
      try {
        return current.subscribe(listener) ?? (() => {})
      } catch {
        return () => {}
      }
    },
  }
}
