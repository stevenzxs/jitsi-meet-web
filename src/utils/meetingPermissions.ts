import type { JitsiMeetExternalAPI } from '../types/jitsi'

/** Snapshot the real joined moderator conference; unknown/transition states fail closed.
 * Callers must recheck identity after asynchronous business requests.
 */
export function getJoinedModeratorConference(api: JitsiMeetExternalAPI | null): object | null {
  if (!api) return null
  try {
    const frame = api.getIFrame()?.contentWindow as Window & {
      APP?: {
        store?: { getState(): Record<string, any> }
        conference?: { _room?: {
          isJoined?(): boolean
          getConnection?(): { xmpp?: { connection?: { connected?: boolean } } }
        } }
      }
    }
    const app = frame?.APP
    const state = app?.store?.getState()
    const conference = state?.['features/base/conference']
    const room = app?.conference?._room
    if (!room || !conference?.conference || conference.joining || conference.leaving) return null
    if (conference.conference !== room || room.isJoined?.() !== true) return null
    // A disconnected XMPP transport can leave both Redux and isJoined stale.
    // Version-specific adapter: unsupported builds must not end a business record.
    if (room.getConnection?.()?.xmpp?.connection?.connected !== true) return null
    if (state?.['features/base/participants']?.local?.role !== 'moderator') return null
    return room
  } catch {
    return null
  }
}

/** Unknown is not the same as a confirmed non-moderator role. */
export function getMeetingRoleLabel(role: string, requestedHost: boolean): string {
  if (role === 'moderator') return '主持人'
  if (role === 'participant' || role === 'none') {
    return requestedHost ? '普通参会者（未获得主持权限）' : '普通参会者'
  }
  return '角色验证中'
}

/** Read Jitsi's own participant state, never application session flags or message claims.
 * Cross-origin/unsupported builds fail closed; deployment must verify this adapter.
 */
export function getParticipantRole(api: JitsiMeetExternalAPI | null, id: string): string {
  if (!api || !id) return ''
  try {
    const frame = api.getIFrame()?.contentWindow as Window & {
      APP?: { store?: { getState(): Record<string, any> } }
    }
    const participants = frame?.APP?.store?.getState()?.['features/base/participants']
    if (!participants) return ''
    const participant = participants.local?.id === id
      ? participants.local
      : participants.remote?.get?.(id)
    return typeof participant?.role === 'string' ? participant.role : ''
  } catch {
    return ''
  }
}

/** Only transport-generated senderInfo is authoritative; eventData is sender-controlled. */
export function getEndpointSenderParticipantId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const event = payload as { senderInfo?: { id?: unknown }; data?: { senderInfo?: { id?: unknown } } }
  const id = event.senderInfo?.id ?? event.data?.senderInfo?.id
  return typeof id === 'string' ? id.trim() : ''
}
