export interface MeetingSession {
  roomName: string;
  subject: string;
  password: string;
  createdAt: number;
  /**
   * 参会人昵称（prejoin 关闭时由创建/加入窗口、密码门收集）。
   * 为空时回退：主持人用会议主题，参会人用"参会者"。存 sessionStorage，刷新后沿用。
   */
  displayName: string;
  /**
   * 是否会议创建者（主持人）。
   * - 通过"创建会议"进入 → true：顶栏显示"邀请"按钮，可分享链接/复制邀请信息
   * - 通过"加入会议"/密码门进入 → false：不显示邀请按钮（只有主持人能邀请和分享）
   * 记录在 sessionStorage（当前标签页内有效），刷新页面后依然保留
   */
  host: boolean;
  /**
   * 主持人密钥（预创建/以主持人身份加入时写入）。
   * 进场前用它向 jitsi-meet-api 换取主持人 JWT；刷新后依然保留主持人身份。
   */
  hostKey?: string;
  /**
   * 会议结束时间（时间戳 ms，来自预定记录）。
   * 到点后不可进入；主持人令牌 exp = min(7 天, endTime)。
   */
  endTime?: number;
}

/** 预创建的会议（我的预定列表，localStorage 持久化） */
export interface ScheduledMeeting {
  roomName: string;
  subject: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  /** 会议时长（分钟） */
  durationMin: number;
  /** 结束时间戳（ms）= date+time+durationMin */
  endTime: number;
  password: string;
  displayName: string;
  hostKey: string;
  /** 创建人用户 ID（用户名哈希），右侧议程只显示自己创建的会议 */
  creatorId?: string;
  createdAt: number;
}

const STORAGE_KEY = 'jitsi-meet-session-v1';
const SCHEDULED_KEY = 'jitsi-meet-scheduled-v1';
const CREDENTIALS_KEY = 'jitsi-meet-credentials-v1';
const CREATOR_RECOVERY_KEY = 'jitsi-meet-creator-recovery-v1';
const PENDING_HOST_TRANSFER_KEY = 'jitsi-meet-pending-host-transfer-v1';

type MeetingCredentials = { hostKey: string; password: string };
export type PendingHostTransfer = { operationId: string; hostKey: string; expiresAt: number };

export function getPendingHostTransfer(roomName: string): PendingHostTransfer | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_HOST_TRANSFER_KEY) || '{}') as Record<string, PendingHostTransfer>;
    const pending = saved[roomName];
    return pending && /^[A-Za-z0-9_-]{1,64}$/.test(pending.operationId)
      && typeof pending.hostKey === 'string' && pending.hostKey.length > 0 && pending.hostKey.length <= 128
      && Number.isFinite(pending.expiresAt) ? pending : null;
  } catch { return null; }
}

export function savePendingHostTransfer(roomName: string, pending: PendingHostTransfer): void {
  if (!/^\d{9}$/.test(roomName) || !/^[A-Za-z0-9_-]{1,64}$/.test(pending.operationId)
      || !pending.hostKey || pending.hostKey.length > 128 || !Number.isFinite(pending.expiresAt)) {
    throw new Error('Invalid host transfer receipt');
  }
  let saved: Record<string, PendingHostTransfer> = {};
  try { saved = JSON.parse(localStorage.getItem(PENDING_HOST_TRANSFER_KEY) || '{}'); } catch { /* reset damaged cache */ }
  saved[roomName] = pending;
  localStorage.setItem(PENDING_HOST_TRANSFER_KEY, JSON.stringify(saved));
}

export function clearPendingHostTransfer(roomName: string, operationId: string): void {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_HOST_TRANSFER_KEY) || '{}') as Record<string, PendingHostTransfer>;
    if (saved[roomName]?.operationId !== operationId) return;
    delete saved[roomName];
    localStorage.setItem(PENDING_HOST_TRANSFER_KEY, JSON.stringify(saved));
  } catch { /* damaged cache has no usable receipt */ }
}

/** Creator capability stays separate from the transferable host key and invitations. */
export function getCreatorRecoveryKey(roomName: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CREATOR_RECOVERY_KEY) || '{}') as Record<string, string>;
    const key = saved[roomName];
    return typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

export function saveCreatorRecoveryKey(roomName: string, key: string): void {
  if (!/^\d{9}$/.test(roomName) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return;
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(localStorage.getItem(CREATOR_RECOVERY_KEY) || '{}'); } catch { /* reset damaged cache */ }
  saved[roomName] = key;
  localStorage.setItem(CREATOR_RECOVERY_KEY, JSON.stringify(saved));
}

export function removeCreatorRecoveryKey(roomName: string): void {
  try {
    const saved = JSON.parse(localStorage.getItem(CREATOR_RECOVERY_KEY) || '{}') as Record<string, string>;
    delete saved[roomName];
    localStorage.setItem(CREATOR_RECOVERY_KEY, JSON.stringify(saved));
  } catch { /* damaged cache has no usable creator capability */ }
}

export function getMeetingCredentials(roomName: string): MeetingCredentials | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || '{}');
    return saved[roomName] ?? readScheduled().find(m => m.roomName === roomName) ?? null;
  } catch {
    return null;
  }
}

export function saveMeetingCredentials(roomName: string, credentials: MeetingCredentials): void {
  if (!credentials.hostKey) return;
  let saved: Record<string, MeetingCredentials> = {};
  try { saved = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || '{}'); } catch { /* 损坏缓存不阻断新建 */ }
  saved[roomName] = { hostKey: credentials.hostKey, password: credentials.password };
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(saved));
}

/** Revoke only the key actually used for a completed handoff. A newer key
 * received in another tab must never be erased by a late source response. */
export function clearTransferredHostKey(roomName: string, previousKey: string): void {
  if (!/^\d{9}$/.test(roomName) || !previousKey) return;
  const credentials = getMeetingCredentials(roomName);
  if (credentials?.hostKey === previousKey) {
    let saved: Record<string, MeetingCredentials> = {};
    try { saved = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || '{}'); } catch { /* reset damaged cache */ }
    saved[roomName] = { hostKey: '', password: credentials.password ?? '' };
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(saved));
  }
  const scheduled = readScheduled();
  const item = scheduled.find(meeting => meeting.roomName === roomName);
  if (item?.hostKey === previousKey) {
    item.hostKey = '';
    writeScheduled(scheduled);
  }
  const session = getSession(roomName);
  if (session?.hostKey === previousKey) saveSession({ ...session, hostKey: undefined });
}

function readAll(): Record<string, MeetingSession> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, MeetingSession>) : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, MeetingSession>): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** 保存会议会话（密码等），仅在当前标签页内有效 */
export function saveSession(session: MeetingSession): void {
  const map = readAll();
  map[session.roomName] = session;
  writeAll(map);
}

/** 读取指定会议号的会话（含密码） */
export function getSession(roomName: string): MeetingSession | null {
  return readAll()[roomName] ?? null;
}

/** 清理会话（会议结束后调用） */
export function clearSession(roomName: string): void {
  const map = readAll();
  delete map[roomName];
  writeAll(map);
}

function readScheduled(): ScheduledMeeting[] {
  try {
    const raw = localStorage.getItem(SCHEDULED_KEY);
    return raw ? (JSON.parse(raw) as ScheduledMeeting[]) : [];
  } catch {
    return [];
  }
}

function writeScheduled(list: ScheduledMeeting[]): void {
  localStorage.setItem(SCHEDULED_KEY, JSON.stringify(list));
}

/** 我的预定列表（按预定时时间排序） */
export function listScheduled(): ScheduledMeeting[] {
  return readScheduled().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

/** 新增一个预创建会议 */
export function addScheduled(meeting: ScheduledMeeting): void {
  saveMeetingCredentials(meeting.roomName, meeting);
  const list = readScheduled().filter((m) => m.roomName !== meeting.roomName);
  list.push(meeting);
  writeScheduled(list);
}

/** 取消预定 */
export function removeScheduled(roomName: string): void {
  writeScheduled(readScheduled().filter((m) => m.roomName !== roomName));
}

/** 用服务端返回的数据整体替换浏览器缓存，保持离线兜底和主持人入口一致 */
export function replaceScheduled(list: ScheduledMeeting[]): void {
  readScheduled().forEach(m => saveMeetingCredentials(m.roomName, m));
  writeScheduled(list);
}
