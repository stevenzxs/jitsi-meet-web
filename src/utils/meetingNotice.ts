export interface MeetingEndedNotice {
  roomName: string
  durationSeconds: number
  createdAt: number
}

const MEETING_ENDED_NOTICE_KEY = 'cloudmeet:meeting-ended-notice'

/** 把参会端收到的主持人结束信号转成首页可识别的一次性通知。 */
export function publishMeetingEndedNotice(roomName: string, durationSeconds: number): void {
  const notice: MeetingEndedNotice = {
    roomName,
    durationSeconds: Math.max(0, Math.round(durationSeconds)),
    createdAt: Date.now(),
  }
  try {
    window.localStorage.setItem(MEETING_ENDED_NOTICE_KEY, JSON.stringify(notice))
  } catch {
    /* 本地存储不可用时，会议关闭仍应继续，不阻断主流程。 */
  }
}

/** 读取并校验桌面首页收到的会议结束通知。 */
export function parseMeetingEndedNotice(raw: string | null): MeetingEndedNotice | null {
  if (!raw) return null
  try {
    const notice = JSON.parse(raw) as Partial<MeetingEndedNotice>
    if (typeof notice.roomName !== 'string' || typeof notice.createdAt !== 'number') return null
    return {
      roomName: notice.roomName,
      durationSeconds: Math.max(0, Math.round(Number(notice.durationSeconds) || 0)),
      createdAt: notice.createdAt,
    }
  } catch {
    return null
  }
}

/** 返回通知存储键，供桌面首页监听跨窗口 storage 事件。 */
export function getMeetingEndedNoticeKey(): string {
  return MEETING_ENDED_NOTICE_KEY
}
