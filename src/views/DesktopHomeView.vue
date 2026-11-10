<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import CreateDialog from '../components/CreateDialog.vue'
import JoinDialog from '../components/JoinDialog.vue'
import PreCreateDialog from '../components/PreCreateDialog.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import MeetingEndedDialog from '../components/MeetingEndedDialog.vue'
import { listScheduled, saveSession } from '../stores/meeting'
import type { ScheduledMeeting } from '../stores/meeting'
import { cancelScheduledMeeting, checkJoinMeeting, createInstantMeeting, deleteHistoryMeeting, fetchMeetingHistory, fetchScheduledMeetings, saveScheduledMeeting } from '../api/meetingApi'
import type { JoinMeetingCheckResult, MeetingHistoryItem } from '../api/meetingApi'
import { generateHostKey } from '../utils/hostKey'
import { PREJOIN_ENABLED, buildInviteText, formatMeetingId, sanitizeMeetingId } from '../utils/jitsi'
import { getCreatorIds, getUser, inDesktopShell, onDesktopUser, requestDesktopUser, saveUserToDesktop, syncLocalUserToDesktop } from '../stores/user'
import type { CloudMeetUser } from '../stores/user'
import { onDesktopServer, requestDesktopServer } from '../stores/server'
import type { CloudMeetServer } from '../stores/server'
import {
  chooseDesktopRecordingDirectory,
  normalizeDesktopSettings,
  onDesktopSettingsChanged,
  openDesktopRecordingDirectory,
  openDesktopVpnSettings,
  saveDesktopSettings,
} from '../stores/desktopSettings'
import type { DesktopSettings } from '../stores/desktopSettings'
import { openMeetingInDesktopWindow } from '../utils/desktopWindow'
import { getCurrentTheme, onThemeChange } from '../utils/theme'
import { getMeetingEndedNoticeKey, parseMeetingEndedNotice, type MeetingEndedNotice } from '../utils/meetingNotice'

const router = useRouter()

const currentUser = ref<CloudMeetUser | null>(getUser())
const showUserDialog = ref(false)
const userNameInput = ref('')
const userNameError = ref('')
const savingUser = ref(false)
const showSettings = ref(false)
const settingsNameInput = ref('')
const settingsNameError = ref('')
const savingSettings = ref(false)
// 桌面能力入口仅在 Electron 嵌入环境展示；服务器地址只读。
const settingsTab = ref<'profile' | 'server' | 'recording' | 'video' | 'vpn'>('profile')
const openingVpn = ref(false)
const vpnEntryError = ref('')
async function openVpnSettings(): Promise<void> {
  if (openingVpn.value) return
  openingVpn.value = true
  vpnEntryError.value = ''
  try { await openDesktopVpnSettings() }
  catch (error) { vpnEntryError.value = error instanceof Error ? error.message : '打开 VPN 配置失败' }
  finally { openingVpn.value = false }
}
const desktopSettings = ref<DesktopSettings>(normalizeDesktopSettings(null))
const recordingActive = ref(false)
const savingDesktopSettings = ref(false)
const settingsDesktopError = ref('')
const desktopServer = ref<CloudMeetServer | null>(null)
const isDesktopShellView = inDesktopShell()
// 当前主题：与 main.ts 的全局主题入口保持一致，切换即整窗生效。
const theme = ref(getCurrentTheme())
const stopThemeChange = onThemeChange((next) => {
  theme.value = next
})

const showCreate = ref(false)
const showJoin = ref(false)
const showSchedule = ref(false)
const quickId = ref('')
const joinInitRoom = ref('')
const joinChecking = ref(false)
const joinPromptMessage = ref('')
const scheduled = ref<ScheduledMeeting[]>(
  currentUser.value ? listScheduled().filter((m) => getCreatorIds(currentUser.value).includes(m.creatorId ?? '')) : [],
)
const historyMeetings = ref<MeetingHistoryItem[]>([])
const agendaView = ref<'scheduled' | 'history'>('scheduled')
const copiedRoom = ref('')
const confirmTarget = ref<ScheduledMeeting | null>(null)
const historyDeleteTarget = ref<MeetingHistoryItem | null>(null)
const meetingEndedNotice = ref<MeetingEndedNotice | null>(null)
const quickInput = ref<HTMLInputElement | null>(null)
let copyTimer: number | undefined
let stopDesktopServer: () => void = () => {}
let stopDesktopSettings: () => void = () => {}
const meetingEndedNoticeMaxAge = 5 * 60 * 1000

const activeMeetings = computed(() =>
  scheduled.value.filter((m) => {
    if (isExpired(m)) return false
    if (!currentUser.value) return true
    return getCreatorIds(currentUser.value).includes(m.creatorId ?? '')
  }),
)
const todayText = computed(() => {
  const now = new Date()
  return `${now.getMonth() + 1}月${now.getDate()}日`
})
const weekdayText = computed(() => new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(new Date()))

/** 进入会议：桌面壳内打开独立的新桌面窗口进行视频会议；浏览器环境回退当前页跳转 */
function enterMeeting(params: {
  roomName: string
  subject?: string
  displayName?: string
  password?: string
  hostKey?: string
  endTime?: number
}): void {
  // 桌面壳专用会议页（/desktop/meeting/:roomName），与 Web 会议页分离
  const routeName = inDesktopShell() ? 'desktop-meeting' : 'meeting'
  const href = router.resolve({ name: routeName, params: { roomName: params.roomName } }).href
  if (inDesktopShell()) {
    openMeetingInDesktopWindow(href, params)
  } else {
    router.push({ name: routeName, params: { roomName: params.roomName } })
  }
}

/** 从校验接口返回的 ISO 时间转换为桌面会议页使用的毫秒时间戳。 */
function getJoinEndTime(meeting: JoinMeetingCheckResult): number | undefined {
  if (!meeting.scheduledEndTime) return undefined
  const time = new Date(meeting.scheduledEndTime).getTime()
  return Number.isNaN(time) ? undefined : time
}

/** 桌面端创建会议沿用 Web 端会话模型，确保进入会议后仍能拿到主持人权限 */
async function onCreate(payload: { roomName: string; subject: string; password: string; displayName: string }): Promise<void> {
  const perfStart = performance.now()
  const perfMark = (label: string): void => {
    console.info(`[meeting-perf] quick-create ${label}`, `${Math.round(performance.now() - perfStart)}ms`)
  }
  perfMark('clicked')
  const hostKey = generateHostKey()
  await createInstantMeeting({
    roomName: payload.roomName,
    subject: payload.subject,
    password: payload.password,
    displayName: payload.displayName,
    hostKey,
    creatorId: currentUser.value?.userId ?? '',
  })
  perfMark('create-api-complete')
  void refreshMeetingHistory()
  saveSession({
    roomName: payload.roomName,
    subject: payload.subject,
    password: payload.password,
    displayName: payload.displayName,
    createdAt: Date.now(),
    host: true,
    hostKey,
  })
  showCreate.value = false
  perfMark('open-window-request')
  enterMeeting({
    roomName: payload.roomName,
    subject: payload.subject,
    displayName: payload.displayName,
    password: payload.password,
    hostKey,
  })
}

/** 桌面首页启动时优先从服务端读取当前用户预定数据，失败时使用浏览器缓存兜底 */
async function refreshScheduled(): Promise<void> {
  scheduled.value = await fetchScheduledMeetings(getCreatorIds(currentUser.value))
}

/** 历史会议复用服务端 meeting 表，展示当前用户创建过的快速会议和预定会议。 */
async function refreshMeetingHistory(): Promise<void> {
  historyMeetings.value = await fetchMeetingHistory(getCreatorIds(currentUser.value))
}

/** 用户信息变更后同时刷新右侧两个列表，避免短 ID 迁移后列表不同步。 */
async function refreshDesktopMeetings(): Promise<void> {
  await Promise.all([refreshScheduled(), refreshMeetingHistory()])
}

/** 切换右侧列表时主动请求当前视图数据，避免结束会议后列表仍停留在旧缓存。 */
async function switchAgendaView(view: 'scheduled' | 'history'): Promise<void> {
  agendaView.value = view
  if (view === 'scheduled') {
    await refreshScheduled()
    return
  }
  await refreshMeetingHistory()
}

/** 用户名在首次设置和设置面板中共用同一套校验，避免入口规则漂移。 */
function validateUserName(name: string): string {
  if (!name) return '请输入用户名'
  if (name.length > 20) return '用户名最多 20 个字符'
  return ''
}

/** 首次打开桌面端必须设置用户名；先写入桌面端存储，再由桌面端同步回 Web 端 store */
async function submitUserName(): Promise<void> {
  const name = userNameInput.value.trim()
  const error = validateUserName(name)
  if (error) {
    userNameError.value = error
    return
  }
  savingUser.value = true
  try {
    currentUser.value = await saveUserToDesktop(name)
    showUserDialog.value = false
    await refreshDesktopMeetings()
  } finally {
    savingUser.value = false
  }
}

/** 保存过程中禁止关闭，防止桌面端存储回写还未完成就丢失状态。 */
function closeSettings(): void {
  if (savingSettings.value) return
  showSettings.value = false
  settingsNameError.value = ''
}

/** 服务器地址只读展示：桌面壳取桌面端推送的当前服务器；浏览器环境显示当前页面来源。 */
const serverAddressText = computed(() => {
  if (desktopServer.value?.url) return desktopServer.value.url
  if (!isDesktopShellView) return `${window.location.origin}/cm/desktop`
  return '未连接'
})

/** 设置面板按当前分类分发保存动作。 */
function submitSettingsPanel(): void {
  if (settingsTab.value === 'profile') {
    void submitSettings()
    return
  }
  void submitDesktopSettings()
}

const settingsPanelSaving = computed(() => {
  if (settingsTab.value === 'profile') return savingSettings.value
  return savingDesktopSettings.value
})
const settingsPanelSaveDisabled = computed(() => {
  if (settingsTab.value === 'profile') {
    return savingSettings.value || !settingsNameInput.value.trim()
  }
  return savingDesktopSettings.value || !isDesktopShellView
})

async function submitDesktopSettings(): Promise<void> {
  if (!isDesktopShellView) return
  savingDesktopSettings.value = true
  settingsDesktopError.value = ''
  try {
    desktopSettings.value = await saveDesktopSettings(desktopSettings.value)
  } catch (error) {
    settingsDesktopError.value = error instanceof Error ? error.message : '保存设置失败'
  } finally {
    savingDesktopSettings.value = false
  }
}

async function changeDesktopRecordingDirectory(): Promise<void> {
  if (!isDesktopShellView) return
  settingsDesktopError.value = ''
  try {
    desktopSettings.value = await chooseDesktopRecordingDirectory()
  } catch (error) {
    settingsDesktopError.value = error instanceof Error ? error.message : '选择录制目录失败'
  }
}

async function openDesktopRecordingDirectoryFromSettings(): Promise<void> {
  if (!isDesktopShellView) return
  settingsDesktopError.value = ''
  const result = await openDesktopRecordingDirectory(desktopSettings.value.recording.directory)
  if (!result.ok) settingsDesktopError.value = result.error || '打开录制目录失败'
}

/** 修改昵称只更新 name，桌面端和 Web 兜底存储都会沿用首次生成的稳定 userId。 */
async function submitSettings(): Promise<void> {
  const name = settingsNameInput.value.trim()
  const error = validateUserName(name)
  if (error) {
    settingsNameError.value = error
    return
  }
  savingSettings.value = true
  try {
    currentUser.value = await saveUserToDesktop(name)
    showSettings.value = false
    await refreshDesktopMeetings()
  } finally {
    savingSettings.value = false
  }
}

/** 切换全局主题：调用 main.ts 暴露的 window.setTheme，浅色/深色即时生效。 */
function toggleTheme(): void {
  const next = theme.value === 'light' ? 'dark' : 'light'
  theme.value = next
  window.setTheme?.(next)
}

/** 关闭会后通知；通知只在当前首页展示一次。 */
function closeMeetingEndedNotice(): void {
  meetingEndedNotice.value = null
  try {
    // 清理已消费的通知，避免首页刷新后再次显示同一条会后提示。
    window.localStorage.removeItem(getMeetingEndedNoticeKey())
  } catch {
    // 本地存储不可用时仅关闭当前弹窗，不影响首页其它功能。
  }
}

/** 解析并展示通知；限制缓存有效期，避免旧会议结束信息干扰新会话。 */
function showMeetingEndedNotice(raw: string | null): void {
  const notice = parseMeetingEndedNotice(raw)
  if (!notice || Date.now() - notice.createdAt > meetingEndedNoticeMaxAge) return
  meetingEndedNotice.value = notice
}

/** 跨桌面会议窗口接收主持人结束事件，首页弹出会后通知。 */
function handleMeetingEndedNotice(event: StorageEvent): void {
  if (event.key !== getMeetingEndedNoticeKey()) return
  showMeetingEndedNotice(event.newValue)
}

onMounted(() => {
  window.addEventListener('storage', handleMeetingEndedNotice)
  try {
    // 首页可能在会议窗口关闭后才完成挂载，因此还要主动读取一次共享通知。
    showMeetingEndedNotice(window.localStorage.getItem(getMeetingEndedNoticeKey()))
  } catch {
    // 本地存储不可用时继续执行正常首页初始化。
  }
  // 桌面端是用户信息的唯一权威来源：先请求桌面端回推用户，回推到达前暂不弹输入框
  onDesktopUser((user) => {
    currentUser.value = user
    showUserDialog.value = false
    void refreshDesktopMeetings()
  })
  // 服务器配置同样以桌面壳存储为准，回推后同步到设置面板只读展示。
  stopDesktopServer = onDesktopServer((server) => {
    desktopServer.value = server
  })
  stopDesktopSettings = onDesktopSettingsChanged((settings, active) => {
    recordingActive.value = active
    desktopSettings.value = settings
  })
  if (isDesktopShellView) {
    requestDesktopServer()
  }
  requestDesktopUser()
  if (currentUser.value) {
    // 本地缓存有用户但桌面端为空时补存上去，保证不丢
    syncLocalUserToDesktop(currentUser.value)
  } else if (inDesktopShell()) {
    window.setTimeout(() => {
      if (!currentUser.value) {
        showUserDialog.value = true
      }
    }, 800)
  } else {
    showUserDialog.value = true
  }
  void refreshDesktopMeetings()
})

onBeforeUnmount(() => {
  stopThemeChange()
  stopDesktopServer()
  stopDesktopSettings()
  window.removeEventListener('storage', handleMeetingEndedNotice)
})

/** 预定会议写入本机列表；选择立即加入时同步写入主持人会话后跳转会议页 */
async function onSchedule(payload: {
  roomName: string
  subject: string
  date: string
  time: string
  durationMin: number
  password: string
  displayName: string
  hostKey: string
  join: boolean
}): Promise<void> {
  const endTime = new Date(`${payload.date}T${payload.time}`).getTime() + payload.durationMin * 60000
  const meeting: ScheduledMeeting = {
    roomName: payload.roomName,
    subject: payload.subject,
    date: payload.date,
    time: payload.time,
    durationMin: payload.durationMin,
    endTime,
    password: payload.password,
    displayName: payload.displayName,
    hostKey: payload.hostKey,
    creatorId: currentUser.value?.userId ?? '',
    createdAt: Date.now(),
  }
  await saveScheduledMeeting(meeting)
  scheduled.value = listScheduled()
  showSchedule.value = false
  if (!payload.join) {
    void refreshDesktopMeetings()
    return
  }
  saveSession({
    roomName: payload.roomName,
    subject: payload.subject,
    password: payload.password,
    displayName: payload.displayName,
    createdAt: Date.now(),
    host: true,
    hostKey: payload.hostKey,
    endTime,
  })
  enterMeeting({
    roomName: payload.roomName,
    subject: payload.subject,
    displayName: payload.displayName,
    password: payload.password,
    hostKey: payload.hostKey,
    endTime,
  })
  void refreshDesktopMeetings()
}

/** 手动加入：先由服务端校验会议存在、未过期且密码正确，通过后才打开桌面会议窗口。 */
async function onJoin(payload: { roomName: string; password: string; displayName: string; hostKey: string }): Promise<void> {
  const hostKey = payload.hostKey.trim()
  joinChecking.value = true
  clearJoinPrompt()
  try {
    const meeting = await checkJoinMeeting(payload.roomName, payload.password)
    const endTime = getJoinEndTime(meeting)
    saveSession({
      roomName: payload.roomName,
      subject: meeting.subject,
      password: payload.password,
      displayName: payload.displayName,
      createdAt: Date.now(),
      host: !!hostKey,
      ...(hostKey ? { hostKey } : {}),
      ...(endTime ? { endTime } : {}),
    })
    showJoin.value = false
    enterMeeting({
      roomName: payload.roomName,
      subject: meeting.subject,
      displayName: payload.displayName,
      password: payload.password,
      ...(hostKey ? { hostKey } : {}),
      ...(endTime ? { endTime } : {}),
    })
  } catch (error) {
    showJoinPrompt((error as Error).message || '入会校验失败，请稍后重试')
  } finally {
    joinChecking.value = false
  }
}

/** 关闭加入弹窗时清理本次校验提示，避免下次打开仍显示旧会议状态。 */
function closeJoinDialog(): void {
  showJoin.value = false
  clearJoinPrompt()
}

/** 从桌面端"加入会议"入口打开时不带任何预填会议号，保证每次都是干净输入框。 */
function openJoinDialog(): void {
  joinInitRoom.value = ''
  clearJoinPrompt()
  showJoin.value = true
}

/** 统一显示桌面端入会校验失败弹窗，替代输入窗口底部的行内提示。 */
function showJoinPrompt(message: string): void {
  joinPromptMessage.value = message
}

/** 用户修改输入或关闭提示后清空旧校验信息。 */
function clearJoinPrompt(): void {
  joinPromptMessage.value = ''
}

/** 快速加入只负责清洗输入；提交时再决定是否打开昵称/密码弹窗 */
function onQuickInput(event: Event): void {
  clearJoinPrompt()
  quickId.value = sanitizeMeetingId((event.target as HTMLInputElement).value, 9)
}

async function submitQuickJoin(): Promise<void> {
  if (quickId.value.length !== 9) return
  clearJoinPrompt()
  joinChecking.value = true
  try {
    const meeting = await checkJoinMeeting(quickId.value, '')
    const endTime = getJoinEndTime(meeting)
    if (!PREJOIN_ENABLED) {
      // prejoin 关闭时还需要收集昵称；会议号已校验通过后再打开加入弹窗。
      joinInitRoom.value = quickId.value
      showJoin.value = true
      return
    }
    saveSession({
      roomName: quickId.value,
      subject: meeting.subject,
      password: '',
      displayName: '',
      createdAt: Date.now(),
      host: false,
      ...(endTime ? { endTime } : {}),
    })
    enterMeeting({
      roomName: quickId.value,
      subject: meeting.subject,
      ...(endTime ? { endTime } : {}),
    })
  } catch (error) {
    const message = (error as Error).message || '入会校验失败，请稍后重试'
    if (message.includes('密码')) {
      // 有密码会议不能从快速入口直接进，转到加入弹窗让用户补齐密码。
      joinInitRoom.value = quickId.value
      showJoin.value = true
      showJoinPrompt(message)
    } else {
      showJoinPrompt(message)
    }
  } finally {
    joinChecking.value = false
  }
}

/** 快捷入口聚焦到会议号输入框，保留桌面端一屏内完成加入的轻量体验 */
function focusQuickInput(): void {
  quickInput.value?.focus()
}

/** 从预定列表进入时使用已保存的 hostKey，以主持人身份入会 */
function enterScheduled(m: ScheduledMeeting): void {
  if (isExpired(m)) return
  saveSession({
    roomName: m.roomName,
    subject: m.subject,
    password: m.password,
    displayName: m.displayName,
    createdAt: Date.now(),
    host: true,
    hostKey: m.hostKey,
    endTime: m.endTime,
  })
  enterMeeting({
    roomName: m.roomName,
    subject: m.subject,
    displayName: m.displayName,
    password: m.password,
    hostKey: m.hostKey,
    endTime: m.endTime,
  })
}

async function copyInvite(m: ScheduledMeeting): Promise<void> {
  if (isExpired(m)) return
  await copyMeetingInvite(m)
}

async function copyHistoryInvite(m: MeetingHistoryItem): Promise<void> {
  if (!canEnterHistory(m)) return
  await copyMeetingInvite(m)
}

/** 复制邀请在预定列表和历史列表中共用，避免复制状态和兜底逻辑出现两套行为。 */
async function copyMeetingInvite(m: Pick<ScheduledMeeting, 'subject' | 'roomName' | 'password'>): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildInviteText({ subject: m.subject, roomName: m.roomName, password: m.password }))
    copiedRoom.value = m.roomName
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copiedRoom.value = ''), 1800)
  } catch {
    /* 剪贴板不可用时忽略，避免桌面工作台误报打断用户 */
  }
}

/** 从历史记录进入仍使用创建时保存的 hostKey，未过期记录可以恢复主持人身份。 */
function enterHistoryMeeting(m: MeetingHistoryItem): void {
  if (!canEnterHistory(m)) return
  saveSession({
    roomName: m.roomName,
    subject: m.subject,
    password: m.password,
    displayName: m.displayName,
    createdAt: Date.now(),
    host: true,
    hostKey: m.hostKey,
    endTime: m.endTime,
  })
  enterMeeting({
    roomName: m.roomName,
    subject: m.subject,
    displayName: m.displayName,
    password: m.password,
    hostKey: m.hostKey,
    endTime: m.endTime,
  })
}

function cancelScheduled(m: ScheduledMeeting): void {
  confirmTarget.value = m
}

function deleteHistory(m: MeetingHistoryItem): void {
  historyDeleteTarget.value = m
}

async function doCancelScheduled(): Promise<void> {
  if (!confirmTarget.value) return
  try {
    await cancelScheduledMeeting(confirmTarget.value.roomName, confirmTarget.value.creatorId || currentUser.value?.userId, confirmTarget.value.hostKey)
  } catch (error) {
    showJoinPrompt((error as Error).message || '取消会议失败，请稍后重试')
    return
  }
  confirmTarget.value = null
  await refreshDesktopMeetings()
}

/** 删除历史记录后只刷新历史列表，避免不必要地请求预定列表。 */
async function doDeleteHistory(): Promise<void> {
  if (!historyDeleteTarget.value) return
  const target = historyDeleteTarget.value
  historyDeleteTarget.value = null
  // 先从界面移除，避免确认后弹窗停住看起来没有反馈；失败时再提示并刷新服务端数据。
  historyMeetings.value = historyMeetings.value.filter((meeting) => meeting.roomName !== target.roomName)
  try {
    await deleteHistoryMeeting(target.roomName, target.creatorId || currentUser.value?.userId, target.hostKey)
    await refreshMeetingHistory()
  } catch (error) {
    showJoinPrompt((error as Error).message || '删除历史会议失败，请稍后重试')
    await refreshMeetingHistory()
  }
}

function isExpired(m: ScheduledMeeting): boolean {
  return Date.now() >= m.endTime
}

function isHistoryExpired(m: MeetingHistoryItem): boolean {
  return Date.now() >= m.endTime
}

function canEnterHistory(m: MeetingHistoryItem): boolean {
  return !['CANCELLED', 'ENDED'].includes(m.status) && !isHistoryExpired(m)
}

function formatScheduleTime(m: ScheduledMeeting): string {
  const end = new Date(m.endTime)
  return `${m.date.slice(5).replace('-', '/')} ${m.time} - ${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
}

function formatHistoryTime(m: MeetingHistoryItem): string {
  const start = new Date(m.startTime)
  const end = new Date(m.endTime)
  return `${String(start.getMonth() + 1).padStart(2, '0')}/${String(start.getDate()).padStart(2, '0')} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')} - ${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
}

/** 历史状态同时参考状态字段和结束时间，过期的 RUNNING 记录在页面上归为已结束。 */
function getHistoryStatus(m: MeetingHistoryItem): { label: string; tone: 'live' | 'scheduled' | 'ended' | 'cancelled' } {
  if (m.status === 'CANCELLED') return { label: '已取消', tone: 'cancelled' }
  if (m.status === 'ENDED' || isHistoryExpired(m)) return { label: '已结束', tone: 'ended' }
  if (m.status === 'RUNNING') return { label: '进行中', tone: 'live' }
  return { label: '已预定', tone: 'scheduled' }
}
</script>

<template>
  <div class="desktop-shell">
    <aside class="desktop-side">
      <div class="desktop-avatar" title="云会议">
        <div class="desktop-avatar__mark"><span></span><span></span><span></span><span></span></div>
        <i></i>
      </div>

      <nav class="desktop-nav" aria-label="桌面端导航">
        <button class="desktop-nav__item desktop-nav__item--active" type="button" title="会议">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <rect x="3" y="5" width="18" height="14" rx="3" />
            <path d="M8 9h8M8 13h5" />
          </svg>
          <span>会议</span>
        </button>
      </nav>

      <div class="desktop-side__tools">
        <button
          class="desktop-side__theme"
          type="button"
          :title="theme === 'light' ? '切换到深色主题' : '切换到浅色主题'"
          @click="toggleTheme"
        >
          <svg
            v-if="theme === 'light'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <span>主题</span>
        </button>
        <button type="button" title="服务在线">
          <span class="live-dot"></span>
        </button>
      </div>
    </aside>

    <main class="desktop-main">
      <section class="launcher-panel" aria-label="会议快捷入口">
        <div class="shortcut-grid">
          <button class="shortcut" type="button" @click="openJoinDialog">
            <span class="shortcut__icon">
              <svg class="shortcut__icon-plus" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z" />
                <path d="M10 4h4v6h-4z" opacity="0.78" />
                <path d="M10 14h4v6h-4z" opacity="0.78" />
                <path d="M4 10h6v4H4z" opacity="0.62" />
                <path d="M14 10h6v4h-6z" opacity="0.62" />
              </svg>
            </span>
            <strong>加入会议</strong>
          </button>

          <button class="shortcut" type="button" @click="showCreate = true">
            <span class="shortcut__icon">
              <svg class="shortcut__icon-bolt" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M13.3 2 5 13h6.2L9.9 22 19 10.2h-6.4z" />
              </svg>
            </span>
            <strong>快速会议</strong>
          </button>

          <button class="shortcut" type="button" @click="showSchedule = true">
            <span class="shortcut__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <strong>预定会议</strong>
          </button>

          <button class="shortcut" type="button" @click="focusQuickInput">
            <span class="shortcut__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="4" y="7" width="16" height="10" rx="2" />
                <path d="M9 12h6" />
              </svg>
            </span>
            <strong>会议号</strong>
          </button>
        </div>

        <div class="quick-card">
          <label for="desktop-quick-room">会议号加入</label>
          <div class="quick-card__row">
            <input
              id="desktop-quick-room"
              ref="quickInput"
              :value="formatMeetingId(quickId)"
              type="text"
              inputmode="numeric"
              placeholder="输入 9 位会议号"
              @input="onQuickInput"
              @keyup.enter="submitQuickJoin"
            />
            <button class="btn btn-primary" :disabled="quickId.length !== 9 || joinChecking" @click="submitQuickJoin">
              {{ joinChecking ? '校验中…' : '加入' }}
            </button>
          </div>
          <p>{{ PREJOIN_ENABLED ? '输入会议号后先校验会议状态' : '输入会议号后填写昵称与密码' }}</p>
        </div>
      </section>

      <section class="agenda-panel" aria-label="我的预定会议">
        <header class="agenda-head">
          <div>
            <h1>{{ todayText }}</h1>
            <p>{{ weekdayText }}</p>
          </div>
          <div class="agenda-head__tools">
            <div class="agenda-tabs" role="tablist" aria-label="会议列表切换">
              <button type="button" :class="{ 'agenda-tabs__item--active': agendaView === 'scheduled' }" @click="switchAgendaView('scheduled')">
                预定会议
              </button>
              <button type="button" :class="{ 'agenda-tabs__item--active': agendaView === 'history' }" @click="switchAgendaView('history')">
                历史会议
              </button>
            </div>
          </div>
        </header>

        <div v-if="agendaView === 'scheduled' && activeMeetings.length" class="agenda-list">
          <article v-for="m in activeMeetings" :key="m.roomName" class="agenda-item">
            <div class="agenda-item__time">{{ formatScheduleTime(m) }}</div>
            <div class="agenda-item__body">
              <strong>{{ m.subject }}</strong>
              <span>会议号 {{ formatMeetingId(m.roomName) }}</span>
            </div>
            <div class="agenda-item__actions">
              <button type="button" @click="enterScheduled(m)">进入</button>
              <button type="button" @click="copyInvite(m)">{{ copiedRoom === m.roomName ? '已复制' : '复制邀请' }}</button>
              <button type="button" class="agenda-item__danger" @click="cancelScheduled(m)">取消</button>
            </div>
          </article>
        </div>

        <div v-else-if="agendaView === 'history' && historyMeetings.length" class="agenda-list history-list">
          <article v-for="m in historyMeetings" :key="m.id || m.roomName" class="agenda-item history-item">
            <div class="agenda-item__time">{{ formatHistoryTime(m) }}</div>
            <div class="agenda-item__body">
              <div class="history-item__title">
                <strong>{{ m.subject }}</strong>
                <span class="history-status" :class="`history-status--${getHistoryStatus(m).tone}`">
                  {{ getHistoryStatus(m).label }}
                </span>
              </div>
              <span>会议号 {{ formatMeetingId(m.roomName) }}</span>
            </div>
            <div class="agenda-item__actions">
              <button type="button" :disabled="!canEnterHistory(m)" @click="enterHistoryMeeting(m)">进入</button>
              <button type="button" :disabled="!canEnterHistory(m)" @click="copyHistoryInvite(m)">
                {{ copiedRoom === m.roomName ? '已复制' : '复制邀请' }}
              </button>
              <button type="button" class="agenda-item__danger" @click="deleteHistory(m)">删除</button>
            </div>
          </article>
        </div>

        <div v-else class="agenda-empty">
          <div class="agenda-empty__cup" aria-hidden="true">
            <span></span>
          </div>
          <strong>{{ agendaView === 'history' ? '暂无历史会议' : '暂无会议' }}</strong>
          <p>{{ agendaView === 'history' ? '你创建过的会议会显示在这里' : '预定的会议会显示在这里' }}</p>
        </div>
      </section>
    </main>

    <CreateDialog variant="desktop" :open="showCreate" @close="showCreate = false" @create="onCreate" />
    <JoinDialog
      variant="desktop"
      :open="showJoin"
      :initial-room="joinInitRoom"
      :loading="joinChecking"
      @close="closeJoinDialog"
      @clear-error="clearJoinPrompt"
      @join="onJoin"
    />
    <PreCreateDialog variant="desktop" :open="showSchedule" @close="showSchedule = false" @schedule="onSchedule" />
    <ConfirmDialog
      variant="desktop"
      :open="!!confirmTarget"
      title="取消预定会议"
      :message="confirmTarget ? `确定取消「${confirmTarget.subject}」吗？取消后列表中的主持人入口也会移除。` : ''"
      confirm-text="确认取消"
      @confirm="doCancelScheduled"
      @cancel="confirmTarget = null"
    />
    <ConfirmDialog
      variant="desktop"
      :open="!!historyDeleteTarget"
      title="删除历史会议"
      :message="historyDeleteTarget ? `确定删除「${historyDeleteTarget.subject}」的历史记录吗？删除后列表中将不再显示。` : ''"
      confirm-text="确认删除"
      @confirm="doDeleteHistory"
      @cancel="historyDeleteTarget = null"
    />
    <MeetingEndedDialog
      :open="!!meetingEndedNotice"
      :duration-seconds="meetingEndedNotice?.durationSeconds ?? 0"
      @close="closeMeetingEndedNotice"
    />
    <ConfirmDialog
      alert
      variant="desktop"
      :open="!!joinPromptMessage"
      title="加入会议"
      :message="joinPromptMessage"
      confirm-text="知道了"
      @confirm="clearJoinPrompt"
      @cancel="clearJoinPrompt"
    />

    <Teleport to="body">
      <div v-if="showUserDialog" class="overlay overlay--desktop">
        <div class="modal modal--desktop modal--desktop--sm" role="dialog" aria-modal="true" aria-labelledby="user-name-title">
          <div class="modal-head">
            <h3 class="modal-title" id="user-name-title">设置用户名</h3>
          </div>
          <div class="modal-body">
            <div class="field">
              <label for="desktop-user-name">用户名</label>
              <input
                id="desktop-user-name"
                v-model="userNameInput"
                type="text"
                maxlength="20"
                placeholder="例如：张三"
                autofocus
                @keyup.enter="submitUserName"
                @input="userNameError = ''"
              />
            </div>
            <p class="user-dialog-hint">首次保存会生成稳定用户 ID；用户名会在创建 / 加入会议时自动填入昵称。</p>
            <p v-if="userNameError" class="user-dialog-error">{{ userNameError }}</p>
          </div>
          <div class="modal-foot">
            <button class="btn btn-primary" :disabled="savingUser || !userNameInput.trim()" @click="submitUserName">
              {{ savingUser ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="showSettings" class="settings-overlay">
        <section class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="desktop-settings-title">
          <aside class="settings-panel__side" aria-label="设置分类">
            <h3 id="desktop-settings-title">个人信息</h3>
            <button
              class="settings-panel__nav"
              :class="{ 'settings-panel__nav--active': settingsTab === 'profile' }"
              type="button"
              @click="settingsTab = 'profile'"
            >
              <span>用户名</span>
            </button>
            <button
              v-if="isDesktopShellView"
              class="settings-panel__nav"
              :class="{ 'settings-panel__nav--active': settingsTab === 'server' }"
              type="button"
              @click="settingsTab = 'server'"
            >
              <span>服务器</span>
            </button>
            <template v-if="isDesktopShellView">
              <button
                class="settings-panel__nav"
                :class="{ 'settings-panel__nav--active': settingsTab === 'recording' }"
                type="button"
                @click="settingsTab = 'recording'"
              >
                <span>录制</span>
              </button>
              <button
                class="settings-panel__nav"
                :class="{ 'settings-panel__nav--active': settingsTab === 'video' }"
                type="button"
                @click="settingsTab = 'video'"
              >
              <span>视频</span>
              </button>
              <button
                class="settings-panel__nav"
                :class="{ 'settings-panel__nav--active': settingsTab === 'vpn' }"
                type="button"
                @click="settingsTab = 'vpn'"
              >
                <span>VPN</span>
              </button>
            </template>
          </aside>

          <main class="settings-panel__main">
            <header class="settings-panel__head">
              <div v-if="settingsTab === 'profile'">
                <h4>用户名</h4>
                <p>修改昵称后，新建和加入会议会默认使用新的显示名。</p>
              </div>
              <div v-else-if="settingsTab === 'server'">
                <h4>服务器</h4>
                <p>桌面客户端当前连接的云会议服务器节点，由安装包固定。</p>
              </div>
              <div v-else-if="settingsTab === 'recording'">
                <h4>录制</h4>
                <p>配置本地录制文件保存位置和音频文件录制方式。</p>
              </div>
              <div v-else-if="settingsTab === 'vpn'">
                <h4>VPN</h4>
                <p>打开桌面客户端本地 VPN 配置面板。</p>
              </div>
              <div v-else>
                <h4>视频</h4>
                <p>配置宫格会议中的轮询切换时间。</p>
              </div>
              <button class="settings-panel__close" type="button" title="关闭" @click="closeSettings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </header>

            <div v-if="settingsTab === 'profile'" class="settings-form">
              <div class="settings-field">
                <label>用户 ID</label>
                <div class="settings-readonly-value" aria-label="用户 ID">
                  <code>{{ currentUser?.userId || '保存用户名后自动生成' }}</code>
                  <span>不可修改</span>
                </div>
                <p>用户 ID 用于查询你创建的预定会议，修改昵称不会改变它。</p>
              </div>

              <div class="settings-field">
                <label for="settings-user-name">用户名</label>
                <input
                  id="settings-user-name"
                  v-model="settingsNameInput"
                  type="text"
                  maxlength="20"
                  placeholder="例如：张三"
                  @keyup.enter="submitSettings"
                  @input="settingsNameError = ''"
                />
              </div>

              <p v-if="settingsNameError" class="settings-error">{{ settingsNameError }}</p>
            </div>

            <div v-else-if="settingsTab === 'server'" class="settings-form">
              <div class="settings-field">
                <label>服务器地址</label>
                <div class="settings-readonly-value" aria-label="服务器地址" :title="serverAddressText">
                  <code>{{ serverAddressText }}</code>
                  <span>不可修改</span>
                </div>
                <p>当前客户端连接的服务器节点，由安装包固定；多节点部署时可据此确认所连接的服务器。</p>
              </div>
            </div>

            <div v-else-if="settingsTab === 'recording'" class="settings-form">
              <div class="settings-field">
                <label>录制文件保存至</label>
                <div class="settings-path-line">
                  <span class="settings-readonly-value settings-path" :title="desktopSettings.recording.directory">
                    {{ desktopSettings.recording.directory || '未设置' }}
                  </span>
                  <button class="btn btn-ghost" type="button" :disabled="settingsPanelSaving" @click="changeDesktopRecordingDirectory">更改</button>
                  <button class="btn btn-ghost" type="button" :disabled="settingsPanelSaving" @click="openDesktopRecordingDirectoryFromSettings">打开</button>
                </div>
              </div>
              <label class="settings-check">
                <input v-model="desktopSettings.recording.recordAudioFile" type="checkbox" />
                <span>同时录制音频文件</span>
              </label>
              <div class="settings-field">
                <label>录制模式</label>
                <div class="recording-modes" role="group" aria-label="录制模式（可多选）" aria-describedby="recording-mode-hint">
                  <label class="recording-mode">
                    <input v-model="desktopSettings.recording.modes" name="recordingMode" type="checkbox" value="host-camera" :disabled="recordingActive" />
                    <span class="recording-mode__card">
                      <svg class="recording-mode__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 6-3v10l-6-3z" stroke-linejoin="round"/></svg>
                      <span class="recording-mode__title">录制主持人视频</span>
                      <span class="recording-mode__description">主持人画面与麦克风<br />随主持权自动切换</span>
                      <span class="recording-mode__mark" aria-hidden="true">✓</span>
                    </span>
                  </label>
                  <label class="recording-mode">
                    <input v-model="desktopSettings.recording.modes" name="recordingMode" type="checkbox" value="shared-screen" :disabled="recordingActive" />
                    <span class="recording-mode__card">
                      <svg class="recording-mode__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4m-3-10 3-3 3 3m-3-3v6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                      <span class="recording-mode__title">录制共享屏幕</span>
                      <span class="recording-mode__description">共享画面与共享者麦克风<br />共享结束自动保存</span>
                      <span class="recording-mode__mark" aria-hidden="true">✓</span>
                    </span>
                  </label>
                <label class="recording-mode">
                  <input v-model="desktopSettings.recording.modes" name="recordingMode" type="checkbox" value="composite" :disabled="recordingActive" />
                  <span class="recording-mode__card">
                    <span class="recording-mode__title">主持人视频＋共享屏幕</span>
                    <span class="recording-mode__description">共享为主，主持人右下角小窗<br />两者麦克风，自动去重</span>
                    <span class="recording-mode__mark" aria-hidden="true">✓</span>
                  </span>
                </label>
                </div>
                <p id="recording-mode-hint" aria-live="polite">{{ recordingActive ? '录制中，暂不可切换模式。停止录制后可更改。' : '可多选，每项生成一个视频；请至少选择一项，不含电脑共享声音。' }}</p>
              </div>
              <p v-if="settingsDesktopError" class="settings-error">{{ settingsDesktopError }}</p>
            </div>

            <div v-else-if="settingsTab === 'vpn'" class="settings-form">
              <div class="settings-field">
                <label>VPN</label>
                <button class="btn btn-primary" type="button" :disabled="openingVpn" @click="openVpnSettings">
                  {{ openingVpn ? '正在打开…' : '打开本地 VPN 配置' }}
                </button>
              </div>
              <p v-if="vpnEntryError" class="settings-error" role="alert">{{ vpnEntryError }}</p>
            </div>

            <div v-else class="settings-form">
              <div class="settings-field">
                <label for="settings-tile-polling-seconds">轮询切换时间</label>
                <div class="settings-number-line">
                  <input
                    id="settings-tile-polling-seconds"
                    v-model.number="desktopSettings.video.tilePollingSeconds"
                    type="number"
                    min="0"
                    max="7200"
                    step="1"
                    inputmode="numeric"
                  />
                  <span>秒</span>
                </div>
                <p>0 表示关闭；开启时最小 15 秒。选择宫格布局后，按当前宫格数量分批轮换在线成员。</p>
              </div>
              <p v-if="settingsDesktopError" class="settings-error">{{ settingsDesktopError }}</p>
            </div>

            <footer v-if="settingsTab === 'server' || settingsTab === 'vpn'" class="settings-panel__foot">
              <button class="btn btn-primary" type="button" @click="closeSettings">关闭</button>
            </footer>
            <footer v-else class="settings-panel__foot">
              <button class="btn btn-ghost" type="button" :disabled="settingsPanelSaving" @click="closeSettings">取消</button>
              <button class="btn btn-primary" type="button" :disabled="settingsPanelSaveDisabled" @click="submitSettingsPanel">
                {{ settingsPanelSaving ? '保存中…' : '保存' }}
              </button>
            </footer>
          </main>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.desktop-shell {
  height: 100vh;
  min-height: 0;
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  overflow: hidden;
  background: var(--bg-1);
  color: var(--text-hi);
}

.desktop-side {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 28px 8px 18px;
  background: var(--bg-2);
  border-right: 1px solid var(--line);
}

.desktop-avatar {
  position: relative;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
}

.desktop-avatar__mark {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  padding: 7px;
  background: linear-gradient(145deg, #38bdf8, #1677ff);
}

.desktop-avatar__mark span {
  border-radius: 3px;
  background: var(--panel-solid);
}

.desktop-avatar i,
.live-dot {
  border-radius: 50%;
  background: #22c55e;
}

.desktop-avatar i {
  position: absolute;
  right: 1px;
  top: 2px;
  width: 8px;
  height: 8px;
  box-shadow: 0 0 0 2px var(--bg-2);
}

.desktop-nav {
  display: grid;
  gap: 16px;
}

.desktop-nav__item,
.desktop-side__tools button {
  width: 48px;
  min-height: 54px;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text-mid);
}

.desktop-nav__item {
  display: grid;
  place-items: center;
  gap: 4px;
  font-size: 12px;
}

.desktop-nav__item svg {
  width: 22px;
  height: 22px;
}

.desktop-nav__item--active {
  color: #1677ff;
}

.desktop-side__tools {
  margin-top: auto;
  display: grid;
  gap: 10px;
}

.desktop-side__tools button {
  display: grid;
  place-items: center;
}

.desktop-side__settings {
  gap: 4px;
  font-size: 11px;
  transition:
    color 0.16s ease,
    background 0.16s ease;
}

.desktop-side__settings svg {
  width: 21px;
  height: 21px;
}

.desktop-side__theme {
  gap: 4px;
  font-size: 11px;
  transition:
    color 0.16s ease,
    background 0.16s ease;
}

.desktop-side__theme svg {
  width: 21px;
  height: 21px;
}

.desktop-side__theme:hover {
  background: rgba(22, 119, 255, 0.12);
  color: var(--accent);
}

.desktop-side__settings:hover,
.desktop-side__settings--active {
  background: rgba(22, 119, 255, 0.12);
  color: var(--accent);
}

.live-dot {
  width: 9px;
  height: 9px;
  box-shadow: 0 0 10px rgba(34, 197, 94, 0.7);
}

.desktop-main {
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-columns: minmax(320px, 40%) minmax(420px, 1fr);
  overflow: hidden;
}

.launcher-panel,
.agenda-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 54px 64px;
  overflow: hidden;
}

.launcher-panel {
  border-right: 1px solid var(--line);
}

.shortcut-grid {
  display: grid;
  grid-template-columns: repeat(2, 112px);
  gap: 42px 32px;
  justify-content: center;
}

.shortcut {
  display: grid;
  justify-items: center;
  gap: 14px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-hi);
  font-size: 15px;
}

.shortcut__icon {
  width: 80px;
  height: 80px;
  border-radius: 22px;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, #178bff, #0566f2);
  box-shadow: 0 16px 34px -20px rgba(22, 119, 255, 0.9);
  transition:
    transform 0.16s ease,
    filter 0.16s ease;
}

.shortcut:hover .shortcut__icon {
  transform: translateY(-2px);
  filter: brightness(1.08);
}

.shortcut__icon svg {
  width: 38px;
  height: 38px;
  color: #fff;
}

.shortcut__icon-plus,
.shortcut__icon-bolt {
  fill: currentColor;
  stroke: none;
}

.shortcut__icon-plus {
  width: 42px !important;
  height: 42px !important;
}

.shortcut__icon-bolt {
  width: 40px !important;
  height: 40px !important;
}

.quick-card {
  width: min(360px, 100%);
  margin: 46px auto 0;
  padding-top: 24px;
  border-top: 1px solid var(--line);
}

.quick-card label {
  display: block;
  margin-bottom: 10px;
  color: var(--text-mid);
  font-size: 13px;
}

.quick-card__row {
  display: flex;
  gap: 10px;
}

.quick-card input {
  flex: 1;
  min-width: 0;
  height: 42px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-hi);
  text-align: center;
  font-family: var(--font-mono);
  letter-spacing: 0.08em;
  outline: none;
}

.quick-card input:focus {
  border-color: #1677ff;
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.16);
}

.quick-card .btn {
  height: 42px;
  padding: 0 22px;
  border-radius: 8px;
}

.quick-card p {
  margin: 10px 0 0;
  color: var(--text-low);
  font-size: 12px;
}

.agenda-panel {
  height: 100%;
  justify-content: flex-start;
  padding-top: 176px;
}

.agenda-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 18px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.agenda-head__tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.agenda-tabs {
  display: flex;
  padding: 3px;
  border-radius: 8px;
  background: var(--bg-2);
}

.agenda-tabs button {
  min-height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-mid);
  font-size: 12px;
}

.agenda-tabs__item--active {
  background: rgba(22, 119, 255, 0.22) !important;
  color: var(--text-hi) !important;
}

.agenda-head h1 {
  margin: 0 0 12px;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 0;
}

.agenda-head p {
  margin: 0;
  color: var(--text-mid);
  font-size: 14px;
}

.agenda-list {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 10px;
  margin-top: 22px;
  padding-right: 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.agenda-item {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border-radius: 12px;
  background: var(--panel);
}

.agenda-item__time,
.agenda-item__body span {
  color: var(--text-mid);
  font-size: 12px;
}

.agenda-item__body {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.agenda-item__body strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agenda-item__actions {
  display: flex;
  gap: 8px;
}

.agenda-item__actions button {
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-hi);
  font-size: 12px;
}

.agenda-item__actions button:hover {
  border-color: rgba(22, 119, 255, 0.45);
  color: var(--text-hi);
}

.agenda-item__actions button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.agenda-item__danger {
  color: var(--danger) !important;
}

.history-list {
  gap: 9px;
}

.history-item__title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-item__title strong {
  min-width: 0;
}

.history-status {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
}

.history-status--live {
  background: rgba(34, 197, 94, 0.14);
  color: var(--ok);
}

.history-status--scheduled {
  background: rgba(59, 130, 246, 0.16);
  color: var(--accent);
}

.history-status--ended {
  background: rgba(148, 163, 184, 0.12);
  color: var(--text-mid);
}

.history-status--cancelled {
  background: rgba(248, 113, 113, 0.12);
  color: var(--danger);
}

.agenda-empty {
  min-height: 360px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: var(--text-mid);
}

.agenda-empty__cup {
  width: 112px;
  height: 86px;
  position: relative;
  opacity: 0.28;
}

.agenda-empty__cup::before {
  content: '';
  position: absolute;
  left: 20px;
  bottom: 10px;
  width: 70px;
  height: 38px;
  border-radius: 0 0 28px 28px;
  background: #6b7280;
}

.agenda-empty__cup::after {
  content: '';
  position: absolute;
  right: 8px;
  bottom: 23px;
  width: 30px;
  height: 28px;
  border: 8px solid #6b7280;
  border-left: none;
  border-radius: 0 18px 18px 0;
}

.agenda-empty strong {
  color: var(--text-hi);
  font-weight: 500;
}

.agenda-empty p {
  margin: 0;
  color: var(--text-low);
  font-size: 13px;
}

@media (max-width: 980px) {
  .desktop-main {
    grid-template-columns: 1fr;
  }

  .launcher-panel,
  .agenda-panel {
    padding: 38px 36px;
  }

  .launcher-panel {
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .agenda-panel {
    padding-top: 38px;
  }
}

.user-dialog-hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-mid);
}

.user-dialog-error {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--danger);
}

.settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 28px;
  background: var(--overlay-bg);
  backdrop-filter: blur(4px);
}

.settings-panel {
  width: min(640px, 100%);
  min-height: 378px;
  display: grid;
  grid-template-columns: 154px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel-solid);
  color: var(--text-hi);
  box-shadow: var(--shadow-card);
}

.settings-panel__side {
  padding: 24px 12px;
  background: var(--bg-2);
  border-right: 1px solid var(--line);
}

.settings-panel__side h3 {
  margin: 0 12px 18px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0;
}

.settings-panel__nav {
  width: 100%;
  min-height: 42px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-mid);
  text-align: left;
  font-size: 14px;
}

.settings-panel__nav--active {
  background: rgba(22, 119, 255, 0.2);
  color: var(--text-hi);
}

.settings-panel__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 26px 28px;
}

.settings-panel__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
}

.settings-panel__head h4 {
  margin: 0 0 7px;
  font-size: 23px;
  line-height: 1.2;
  letter-spacing: 0;
}

.settings-panel__head p,
.settings-field p {
  margin: 0;
  color: var(--text-mid);
  font-size: 13px;
  line-height: 1.7;
}

.settings-panel__close {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-hi);
}

.settings-panel__close svg {
  width: 18px;
  height: 18px;
}

.settings-form {
  display: grid;
  gap: 20px;
  padding-top: 22px;
}

.settings-field {
  display: grid;
  gap: 9px;
}

.settings-field label {
  color: var(--text-hi);
  font-size: 13px;
}

.settings-field input,
.settings-readonly-value {
  width: 100%;
  height: 44px;
  min-width: 0;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-hi);
  outline: none;
}

.settings-readonly-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  user-select: text;
}

.settings-readonly-value code {
  min-width: 0;
  overflow: hidden;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 14px;
  text-overflow: ellipsis;
}

.settings-readonly-value span {
  flex: 0 0 auto;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.12);
  color: var(--text-mid);
  font-size: 12px;
}

.settings-field input:focus {
  border-color: #1677ff;
  box-shadow: 0 0 0 3px rgba(22, 119, 255, 0.16);
}

.settings-path-line,
.settings-number-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-path {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-path-line .btn {
  flex: 0 0 auto;
  padding: 8px 12px;
}

.settings-number-line input {
  width: 140px;
}

.settings-number-line span {
  color: var(--text-mid);
}

.settings-check {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 18px;
  color: var(--text-hi);
}

.recording-modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.recording-mode { position: relative; min-width: 0; cursor: pointer; }
.settings-field .recording-mode > input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; padding: 0; }
.recording-mode__card { position: relative; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; padding: 18px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-2); transition: border-color 140ms, background-color 140ms; }
.recording-mode__icon { width: 26px; height: 26px; margin-bottom: 14px; color: var(--text-mid); }
.recording-mode__title { padding-right: 16px; color: var(--text-hi); font-size: 14px; font-weight: 600; line-height: 1.5; }
.recording-mode__description { margin-top: 7px; color: var(--text-mid); font-size: 12px; line-height: 1.8; }
.recording-mode__mark { position: absolute; top: 16px; right: 14px; display: grid; place-items: center; width: 17px; height: 17px; border: 1px solid var(--line); border-radius: 4px; color: transparent; font-size: 11px; }
.recording-mode > input:checked + .recording-mode__card { border-color: #1677ff; background: rgba(22,119,255,.07); box-shadow: inset 0 0 0 1px #1677ff; }
.recording-mode > input:checked + .recording-mode__card .recording-mode__icon { color: #1677ff; }
.recording-mode > input:checked + .recording-mode__card .recording-mode__mark { border-color: #1677ff; background: #1677ff; color: #fff; }
.recording-mode > input:not(:disabled) + .recording-mode__card:hover { border-color: #1677ff; }
.recording-mode > input:focus-visible + .recording-mode__card { outline: 3px solid rgba(22,119,255,.35); outline-offset: 3px; }
.recording-mode > input:disabled + .recording-mode__card { opacity: .58; cursor: not-allowed; }
@media (max-width: 640px) { .recording-modes { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .recording-mode__card { transition: none; } }

.settings-error {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}

.settings-panel__foot {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 26px;
}

.settings-panel__foot .btn {
  min-width: 84px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 18px;
  border-radius: 8px;
  line-height: 1;
}

@media (max-width: 720px) {
  .settings-panel {
    min-height: 0;
    grid-template-columns: 1fr;
  }

  .settings-panel__side {
    display: flex;
    align-items: center;
    gap: 14px;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .settings-panel__side h3 {
    margin: 0;
  }

  .settings-panel__nav {
    width: auto;
    padding: 0 16px;
  }
}
</style>
