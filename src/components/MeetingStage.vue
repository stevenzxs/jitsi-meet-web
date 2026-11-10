<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import JitsiFrame from './JitsiFrame.vue'
import AndroidVideoStrip from './AndroidVideoStrip.vue'
import CustomToolbar from './CustomToolbar.vue'
import PollingGroupDialog from './PollingGroupDialog.vue'
import DesktopInviteDialog from './DesktopInviteDialog.vue'
import { attachHostParticipantMenu, getHostParticipantAction, HOST_RECLAIM_MENU_ID } from '../utils/hostParticipantMenu'
import PollingParticipantInfo from './PollingParticipantInfo.vue'
import { clearPendingHostTransfer, clearTransferredHostKey, getPendingHostTransfer, getSession, listScheduled, saveSession } from '../stores/meeting'
import { MEETING_BANNER_REQUEST_SIGNAL, MEETING_BANNER_SIGNAL, PREJOIN_ENABLED, formatMeetingId, getEndpointMessage, loadExternalApi } from '../utils/jitsi'
import { publishMeetingEndedNotice } from '../utils/meetingNotice'
import { RecordingTranscodeTracker } from '../utils/recordingFeedback'
import { createRecordingSourcesAdapter, type RecordingMode } from '../utils/recordingSources'
import { createDirectedRecordingEngine, getRecordingStartBlockReason, type DirectedRecordingEngine } from '../utils/directedRecording'
import { createRecordingGroup } from '../utils/scheduledRecordingGroup'
import { getParticipantRole, getEndpointSenderParticipantId, getMeetingRoleLabel, getJoinedModeratorConference } from '../utils/meetingPermissions'
import { getMeetingModeratorId, getParticipantCameraTrack, getNextPollingMemberId, getPollingCardSize, type PollingJitsiTrack } from '../utils/pollingLayout'
import { attachHostTransferClient, canReclaimHost, HOST_TRANSFER_MENU_ID, requestHostReclaim, requestHostTransfer } from '../utils/hostTransferClient'
import {
  BANNER_LOGO_ACCEPT,
  BANNER_LOGO_MAX_BYTES,
  checkJoinMeeting,
  deleteBannerLogo,
  endMeeting,
  fetchMeetingBanner,
  saveMeetingBanner,
  listBannerLogos,
  reportParticipantJoined,
  uploadBannerLogo,
  type BannerLogoItem,
} from '../api/meetingApi'
import { fetchHostToken } from '../api/hostTokenApi'
import { getUser, onDesktopUser } from '../stores/user'
import { getCurrentTheme, onThemeChange } from '../utils/theme'
import type { JitsiMeetExternalAPI } from '../types/jitsi'
import type { ThemeMode } from '../utils/theme'

/**
 * MeetingView / DesktopMeetingView 的公共会议核心：
 * 加入门、JitsiFrame 挂载、自定义工具栏、踢出/错误/结束面板与邀请复制反馈。
 */
const props = withDefaults(
  defineProps<{
    roomName: string
    subject?: string
    /** web: 顶栏/分享弹窗由父级负责; desktop: 关闭即关窗、邀请复制反馈在页内 */
    mode?: 'web' | 'desktop'
  }>(),
  { subject: '', mode: 'web' },
)

const emit = defineEmits<{
  'status-changed': [status: string]
  kicked: []
  invite: []
  'go-home': []
  'close-window': []
  'subject-changed': [subject: string]
}>()

interface ShellCloseMenuAnchor {
  top?: number
  right?: number
}

interface DesktopSettings {
  recording?: {
    directory?: string
    recordAudioFile?: boolean
    /** 历史单选配置。新配置使用 modes 数组。 */
    mode?: 'host-camera' | 'shared-screen'
    modes?: RecordingMode[]
  }
  video?: {
    /** 轮询切换间隔（秒）；0 表示关闭。 */
    tilePollingSeconds?: number
    /** 旧版字段（分钟），读取时按 ×60 兼容换算为秒。 */
    tilePollingMinutes?: number
  }
}

interface DesktopRecordingSession {
  sessionId: string
  videoFilePath: string
  audioFilePath?: string
}

interface DesktopRecordingResult {
  ok?: boolean
  videoFilePath?: string
  videoFormat?: 'mp4' | 'webm'
  converting?: boolean
  audioFilePath?: string
  conversionError?: string
  error?: string
}

interface DesktopRecordingResponse {
  type?: string
  requestId?: string
  settings?: DesktopSettings
  session?: DesktopRecordingSession
  result?: DesktopRecordingResult
  error?: string
}

interface DesktopRecordingPendingRequest<T> {
  responseType: string
  resolve: (value: T) => void
  reject: (error: Error) => void
  timer: number
}

type RecordingChunkKind = 'video' | 'audio'
// 固定分屏（grid-N）：每页固定 N 宫格，超过的参会人走严格网格分页； Electron 顶部"布局"弹窗提供 2/4/9/16/25/36/49 分屏选项。
const FIXED_GRID_LAYOUT_MODES = ['grid-2', 'grid-4', 'grid-9', 'grid-16', 'grid-25', 'grid-36', 'grid-49'] as const
type FixedGridLayoutMode = (typeof FIXED_GRID_LAYOUT_MODES)[number]
// polling：轮询布局（左槽固定主持人 + 右槽轮播勾选组员），无页码/网格，画面由外层槽位渲染。
type MeetingLayoutMode = 'default' | 'auto' | 'polling' | FixedGridLayoutMode

interface MeetingParticipantSnapshot {
  id: string
  displayName?: string
  videoMuted?: boolean
}

interface NativeChatParticipant {
  id: string
  name: string
}

interface MeetingBannerState {
  visible: boolean
  text: string
  fontSize: number
  color: string
  fontFamily: string
  /** 背景色，空串表示无色（透明）。 */
  bgColor: string
  /** 会标图片相对地址（/cm/banner-logos/...），空串表示无会标。 */
  logoUrl: string
  position: 'top'
  updatedAt: number
}

interface MeetingBannerMessage {
  type: typeof MEETING_BANNER_SIGNAL
  participantId?: string
  ownerParticipantId?: string
  banner: MeetingBannerState
}

interface MeetingBannerEnvelope {
  participantId: string
  state: MeetingBannerState
}

type JitsiReduxState = Record<string, unknown>

/** iframe 内 redux store 的 dispatch 入参：SET_TILE_VIEW_DIMENSIONS（尺寸）与 SET_REMOTE_PARTICIPANTS（固定分屏顺序）。 */
interface JitsiReduxAction {
  type: string
  dimensions?: {
    gridDimensions: { columns: number; rows: number }
    thumbnailSize: { height: number; width: number }
    filmstripHeight: number
    filmstripWidth: number
    hasScroll: boolean
  }
  participants?: string[]
}

interface JitsiIframeWindow extends Window {
  APP?: {
    store?: {
      getState?: () => JitsiReduxState
      dispatch?: (action: JitsiReduxAction) => unknown
    }
  }
}

const jitsiFrame = ref<InstanceType<typeof JitsiFrame> | null>(null)
const customToolbar = ref<InstanceType<typeof CustomToolbar> | null>(null)
const meetingStageRoot = ref<HTMLElement | null>(null)
const androidEmbed =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).get('android') === '1' || document.documentElement.classList.contains('android-embed'))
let participantJoinedReported = false
// 首次入会时间：主题切换重建 iframe 会再次触发 joined，保留首次值使会议时长不清零。
let meetingJoinedAt = 0
// 桌面端会议时长推送计时器：入会后每秒把时长发给 Electron 壳标题栏。
let elapsedTicker: number | undefined
let closeFallbackTimer: number | undefined
let toastTimer: number | undefined
let nativeChatStateSyncTimer: number | undefined
// 会议结束状态是否已同步过服务端（主持人结束全员会议 / 最后一人离开只发一次）。
let endReported = false
// 本地维护的参会人数（含自己）：用于判断自己离开时是否已是最后一人。
const participantCount = ref(0)
const nativeChatOpen = ref(false)
const shellCloseMenuOpen = ref(false)
const shellCloseMenuCanEndForAll = ref(false)
const shellCloseMenuTop = ref(12)
const shellCloseMenuRight = ref(12)
const fullscreen = ref(false)
const fullscreenToolbarVisible = ref(false)
const androidToolbarHeight = ref(0)
// 旧版 Electron 未发送标题栏高度时，兼容其 40px 自绘标题栏。
let fullscreenTitlebarHeight = 40
const BANNER_FONT_SIZE_MIN = 18
const BANNER_FONT_SIZE_MAX = 160
const BANNER_FONT_SIZE_DEFAULT = 32
const BANNER_TEXT_MAX_LENGTH = 80
const BANNER_COLOR_DEFAULT = '#FFFFFF'
// 背景色默认无色（透明），不再默认深色底。
const BANNER_BG_DEFAULT = ''
const BANNER_FONT_FAMILY_DEFAULT = ''
const BANNER_COLOR_PRESETS = ['#FFFFFF', '#FFD400', '#F27C24', '#D94A3A', '#2EA872', '#2E6BE8', '#9B59D0', '#000000']
const BANNER_BG_PRESETS = ['#070C14', '#000000', '#1B2A4A', '#D94A3A', '#2E6BE8', '#FFFFFF']
const BANNER_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '默认字体', value: '' },
  { label: '微软雅黑', value: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { label: '黑体', value: 'SimHei, "黑体", sans-serif' },
  { label: '宋体', value: 'SimSun, "宋体", serif' },
  { label: '楷体', value: 'KaiTi, "楷体", serif' },
  { label: '仿宋', value: 'FangSong, "仿宋", serif' },
]
const BANNER_OVERLAY_CLASS = 'cloudmeet-participant-banner'
const BANNER_OVERLAY_HOST_CLASS = 'cloudmeet-participant-banner-host'

function createDefaultMeetingBannerState(): MeetingBannerState {
  return {
    visible: false,
    text: '',
    fontSize: BANNER_FONT_SIZE_DEFAULT,
    color: BANNER_COLOR_DEFAULT,
    fontFamily: BANNER_FONT_FAMILY_DEFAULT,
    bgColor: BANNER_BG_DEFAULT,
    logoUrl: '',
    position: 'top',
    updatedAt: 0,
  }
}

const session = getSession(props.roomName)

/**
 * 会议密码（传给 JitsiFrame 用于自动解锁锁定房间）。
 * 必须用 ref 而不是 computed：sessionStorage 不是响应式的，
 * computed 读 sessionStorage 只会在 setup 时求值一次并缓存结果——
 * 参会人从分享链接进来时 session 为 null，密码被缓存为空串，
 * 之后即使密码门提交了密码也不会更新，导致 Jitsi 再次弹出密码框。
 */
const password = ref(session?.password ?? '')
const displaySubject = computed(() => meetingBanner.value.text || props.subject || session?.subject || '我的会议')

// 昵称：创建/加入窗口或密码门填写，存 sessionStorage 刷新后沿用；空则回退由 Jitsi 自己处理。
const displayName = ref(session?.displayName ?? '')

// 加入门：本标签页没有该会议的会话（如参会人直接打开分享链接）时，先收集昵称/可选密码再加入
const needsJoin = ref(!session)
const joinPassword = ref('')
const joinVisible = ref(false)
// 密码门"以主持人身份加入"：任何人填对主持人密钥即可换 JWT 成为主持人。
const showHostJoin = ref(false)
const gateHostKey = ref('')
const status = ref<'connecting' | 'joined' | 'kicked' | 'left'>('connecting')
const errorMsg = ref('')
const joinChecking = ref(false)
// 桌面端直接打开会议页时，先向业务接口确认会议仍可加入，再加载 Jitsi iframe。
// Web 端不依赖该检查（validateExistingSession 仅桌面端运行），必须始终为 true，
// 否则普通参会人（有会话无 hostKey）会被停留在等待面板无法进入会议。
const joinCheckReady = ref(props.mode !== 'desktop' || !session || !!session.hostKey)
// Web 端只有本地预定记录存在时才显示主持人入口（分享链接的参会人不暴露主持人入口）。
const canHostJoin = computed(() => props.mode === 'web' && listScheduled().some((m) => m.roomName === props.roomName))
// Web 端按结束时间拦截进入；主持人/桌面端没有结束时间时由服务端与 Jitsi 房间策略处理。
const expired = computed(() => props.mode === 'web' && !!session?.endTime && Date.now() >= session.endTime)
const endTimeText = computed(() => {
  if (!session?.endTime) return ''
  const d = new Date(session.endTime)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

// 加入门昵称：预填已设置的用户名（可修改），没有则留空由用户输入；
// 桌面端推回用户（深链直接进会议页时 store 可能还没同步）则补填
const gateName = ref(props.mode === 'desktop' ? (getUser()?.name ?? '') : '')
if (props.mode === 'desktop') {
  onDesktopUser((user) => {
    if (!gateName.value.trim()) {
      gateName.value = user.name
    }
  })
}

/**
 * 主持人令牌（JWT）：session 里有 hostKey 时（预创建/以主持人身份加入），
 * 进场前向签发服务换取 moderator 令牌传给 Jitsi——主持人身份由令牌决定，与进场顺序无关。
 * 签发失败时直接拦截，避免主持人变成普通参会人后触发锁定失败。
 */
const hostKey = ref(session?.hostKey ?? '')
const hostToken = ref<string | null>(null)
// 无 hostKey 时不需要令牌，直接就绪；有 hostKey 时等令牌获取完成（成功或失败）再挂载 JitsiFrame
const tokenReady = ref(!session?.hostKey)
const localModerator = ref(false)
const localRole = ref('')
const meetingRoleLabel = computed(() => getMeetingRoleLabel(localRole.value, Boolean(hostKey.value)))
const meetingBanner = ref<MeetingBannerState>(createDefaultMeetingBannerState())
const transferTarget = ref<{ id: string; name: string } | null>(null)
const transferBusy = ref(false)
const reclaimDialogOpen = ref(false)
const reclaimBusy = ref(false)
const reclaimTargetId = ref('')
const canShowHostReclaim = computed(() => status.value === 'joined' && Boolean(jitsiApi.value)
  && canReclaimHost(jitsiApi.value!, props.roomName,
    localModerator.value && Boolean(hostKey.value) && Boolean(hostToken.value)))
const participantMeetingBanners = ref<Record<string, MeetingBannerState>>({})
const bannerPanelOpen = ref(false)
const bannerDraftVisible = ref(true)
const bannerDraftText = ref('')
const bannerDraftFontSize = ref(BANNER_FONT_SIZE_DEFAULT)
const bannerDraftColor = ref(BANNER_COLOR_DEFAULT)
const bannerDraftFontFamily = ref(BANNER_FONT_FAMILY_DEFAULT)
const bannerDraftBgColor = ref(BANNER_BG_DEFAULT)
// 会标草稿：已保存的地址 + 本次新选的本地文件（保存时才上传）。
const bannerDraftLogoUrl = ref('')
const bannerLogoFile = ref<File | null>(null)
const bannerLogoError = ref('')
const bannerLogoSaving = ref(false)
let bannerLogoObjectUrl = ''
const bannerVisible = computed(
  () =>
    status.value === 'joined' &&
    meetingBannerHasContent(meetingBanner.value),
)

// 标题栏读取与电子屏、录制和邀请相同的当前主题；服务端同步或主持人保存后即时更新。
watch(displaySubject, (subject) => {
  if (props.mode === 'desktop') emit('subject-changed', subject)
}, { immediate: true })

// 桌面端标题栏可见时由标题栏显示主题；全屏标题栏隐藏后由电子屏接续显示。
const showMeetingSubjectBanner = computed(() =>
  status.value === 'joined'
  && meetingBannerHasContent(meetingBanner.value)
  && (props.mode !== 'desktop' || (fullscreen.value && !fullscreenToolbarVisible.value)),
)

const localRecording = ref(false)
const localRecordingBusy = ref(false)
const localRecordingError = ref('')
let recordingBridgeSequence = 0
let recordingGroup: ReturnType<typeof createRecordingGroup> | null = null
const desktopRecordingRequests = new Map<string, DesktopRecordingPendingRequest<DesktopRecordingResponse>>()
const recordingTranscodes = new RecordingTranscodeTracker()

/** 编辑面板中会标的预览地址：新选的本地文件优先，其次已保存的线上地址。 */
const bannerLogoPreview = computed(() => (bannerLogoFile.value ? bannerLogoObjectUrl : bannerDraftLogoUrl.value))
const activeMeetingLayout = ref<MeetingLayoutMode>(
  !androidEmbed && new URLSearchParams(window.location.search).get('desktop') === '1' ? 'auto' : 'default',
)
const autoLayoutTileCount = ref(9)
const tilePollingSeconds = ref(0)
const tilePollingEnabled = ref(false)
let tilePollingTimer: number | undefined
let tilePollingCursor = 0
let tilePollingSequence = 0
let defaultLayoutPollingCurrentParticipantId = ''
// 轮询组（仅当前观看者的界面状态，不同步给其他参会者）：已确认名单、对话框、右槽当前组员与槽位挂载状态。
const pollingGroupIds = ref<string[]>([])
const pollingDialogOpen = ref(false)
const pollingHostId = ref('')
const pollingRightParticipantId = ref('')
const pollingLeftHasVideo = ref(false)
const pollingRightHasVideo = ref(false)
const pollingLeftSlot = ref<HTMLElement | null>(null)
const pollingLayoutRoot = ref<HTMLElement | null>(null)
const pollingCardStyle = ref<Record<string, string>>({})
watch(pollingLayoutRoot, (root, _, onCleanup) => {
  if (!root) return
  const update = () => {
    const size = getPollingCardSize(root.clientWidth, root.clientHeight)
    pollingCardStyle.value = { '--polling-card-width': `${size.width}px`, '--polling-card-height': `${size.height}px` }
  }
  const observer = new ResizeObserver(update)
  observer.observe(root)
  update()
  onCleanup(() => observer.disconnect())
}, { flush: 'post' })
const pollingRightSlot = ref<HTMLElement | null>(null)
let pollingCursor = 0
let pollingGroupConfigured = false
let pollingLeftAttachedId = ''
let pollingRightAttachedId = ''
let pollingLeftTrack: PollingJitsiTrack | null = null
let pollingRightTrack: PollingJitsiTrack | null = null
const pollingRightPlaceholder = computed(() =>
  pollingGroupIds.value.length ? '成员未开启视频' : '未选择轮询成员',
)
// 严格等分网格：最近一次下发的尺寸与当前页码（供分页器与滚动位置恢复使用）。
let strictGridMetrics: StrictGridMetrics | null = null
const strictGridPage = ref(0)
const strictGridPageCount = ref(1)
let strictGridPageRestoreTimer: number | undefined
let tileLayoutRefreshTimers: number[] = []
let autoLayoutRefreshTimers: number[] = []
let autoLayoutRefreshSequence = 0
let jitsiWindowResizeRefreshTimer: number | undefined
let meetingStageResizeObserver: ResizeObserver | null = null
let lastMeetingStageSizeKey = ''
let meetingBannerOverlayTimer: number | undefined
let meetingBannerOverlayFrame: number | undefined
let meetingBannerStateSyncTimers: number[] = []
let meetingSubjectRefreshTimer: number | undefined
let largeVideoParticipantId = ''
const androidMainParticipantId = ref('')
const videoMutedParticipantIds = new Set<string>()
const tilePollingControlAvailable = computed(
  () =>
    hostMediaControlsVisible.value &&
    tilePollingSeconds.value > 0 &&
    Boolean(jitsiApi.value),
)
const hostMediaControlsVisible = computed(
  () => props.mode === 'desktop' && status.value === 'joined' && localModerator.value && Boolean(jitsiApi.value),
)
let recordingPermissionGeneration = 0

function canUseHostMediaControls(): boolean {
  return props.mode === 'desktop' && status.value === 'joined' && localModerator.value
    && Boolean(getJoinedModeratorConference(jitsiApi.value))
}

function revokeHostMediaControls(): void {
  // Also invalidate a start that is still awaiting settings, tracks or disk session.
  recordingPermissionGeneration += 1
  pollingDialogOpen.value = false
  stopTilePolling({ disable: true })
  if (localRecording.value) void stopLocalRecording()
}

/** 等分网格分页器：仅在会中、处于等分布局且严格网格出现多页时显示。 */
const strictGridPagerVisible = computed(
  () => status.value === 'joined' && activeMeetingLayout.value !== 'default' && strictGridPageCount.value > 1,
)

// 桌面端快速会议同时下载 Jitsi API 和请求主持人令牌，避免令牌返回后才开始下载脚本。
if (props.mode === 'desktop') {
  void loadExternalApi()
}

/** 会标地址白名单：仅允许本服务 nginx 提供的会标路径（会议目录或共享会标库），防止外部 URL 注入到所有参会端。 */
function normalizeBannerLogoUrl(value: unknown): string {
  if (typeof value !== 'string') return ''
  const url = value.trim()
  return /^\/cm\/banner-logos\/(?:\d+|library)\/[A-Za-z0-9_-]+\.(?:png|jpe?g|svg|webp)$/i.test(url) ? url : ''
}

/** 切换会标本地文件，同时维护预览用的 ObjectURL，避免内存泄漏。 */
function setBannerLogoFile(file: File | null): void {
  if (bannerLogoObjectUrl) {
    URL.revokeObjectURL(bannerLogoObjectUrl)
    bannerLogoObjectUrl = ''
  }
  // 先备好 ObjectURL 再改响应式 file，保证 bannerLogoPreview 重算时地址已就绪。
  bannerLogoObjectUrl = file ? URL.createObjectURL(file) : ''
  bannerLogoFile.value = file
}

function handleBannerLogoInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  // 清空 value，保证重复选择同一张图片也能触发 change。
  input.value = ''
  bannerLogoError.value = ''
  if (!file) return
  if (!BANNER_LOGO_ACCEPT.split(',').includes(file.type)) {
    bannerLogoError.value = '会标仅支持 PNG / JPG / SVG / WebP 图片'
    return
  }
  if (file.size > BANNER_LOGO_MAX_BYTES) {
    bannerLogoError.value = '会标图片不能超过 2MB'
    return
  }
  setBannerLogoFile(file)
}

function removeBannerLogo(): void {
  setBannerLogoFile(null)
  bannerDraftLogoUrl.value = ''
  bannerLogoError.value = ''
}

// 会标库浏览：从已上传的会标中直接选用，避免每次开会重复上传同一张图片。
const bannerLogoLibraryOpen = ref(false)
const bannerLogoLibraryList = ref<BannerLogoItem[]>([])
const bannerLogoLibraryLoading = ref(false)

async function toggleBannerLogoLibrary(): Promise<void> {
  bannerLogoLibraryOpen.value = !bannerLogoLibraryOpen.value
  if (!bannerLogoLibraryOpen.value) return
  // 每次展开都重新拉取，保证能看到其它会议刚上传的会标。
  bannerLogoLibraryLoading.value = true
  try {
    bannerLogoLibraryList.value = await listBannerLogos()
  } finally {
    bannerLogoLibraryLoading.value = false
  }
}

function pickBannerLogoFromLibrary(url: string): void {
  setBannerLogoFile(null)
  bannerDraftLogoUrl.value = url
  bannerLogoError.value = ''
}

async function deleteBannerLogoFromLibrary(item: BannerLogoItem): Promise<void> {
  const api = jitsiApi.value
  const conference = getJoinedModeratorConference(api)
  if (!localModerator.value || !hostKey.value || !conference) {
    bannerLogoError.value = '仅已验证且持有会议密钥的主持人可以删除会标库图片'
    return
  }
  await deleteBannerLogo(item.url, hostKey.value, props.roomName)
  if (api !== jitsiApi.value || !localModerator.value || getJoinedModeratorConference(api) !== conference) return
  bannerLogoLibraryList.value = bannerLogoLibraryList.value.filter((logo) => logo.url !== item.url)
  // 删掉的正是当前选中的会标时，草稿同步清空，避免保存出一个 404 图片。
  if (bannerDraftLogoUrl.value === item.url && !bannerLogoFile.value) {
    bannerDraftLogoUrl.value = ''
  }
}

async function acquireHostToken(): Promise<void> {
  if (!hostKey.value) {
    tokenReady.value = true
    return
  }
  const perfStart = performance.now()
  console.info('[meeting-perf] host-token request-start')
  const token = await fetchHostToken(props.roomName, hostKey.value, displayName.value || '主持人', session?.endTime)
  console.info('[meeting-perf] host-token request-complete', `${Math.round(performance.now() - perfStart)}ms`)
  if (!token) {
    // A newly transferred host has the rotated key while the API fence is
    // still closed. Join as a participant so its live XMPP session can prove
    // the key and finish the pending receipt.
    const pending = getPendingHostTransfer(props.roomName)
    if (pending?.hostKey === hostKey.value && pending.expiresAt > Date.now()) {
      hostToken.value = null
      tokenReady.value = true
      return
    }
    // 主持人身份不可降级，否则会以普通参会人进房并在设置密码时失败。
    errorMsg.value = pending?.hostKey === hostKey.value && pending.expiresAt <= Date.now()
      ? '本机保存的待确认转让已过期，当前主持权限未获验证。请联系会议创建者收回主持人；凭据暂予保留，网络恢复后可重新加载核验。'
      : '主持人身份验证失败，请检查令牌配置、主持人密钥或会议有效期'
    localModerator.value = false
    if (props.mode === 'desktop') {
      tokenReady.value = true
    } else {
      setStatus('left')
      tokenReady.value = true
    }
    return
  }
  hostToken.value = token
  const pending = getPendingHostTransfer(props.roomName)
  if (pending?.hostKey === hostKey.value) clearPendingHostTransfer(props.roomName, pending.operationId)
  tokenReady.value = true
}

// 等待面板文案按实际等待的动作区分：只有真正在换主持人令牌时才提示"验证主持人身份"。
const waitingText = computed(() => {
  if (joinChecking.value) return '正在校验会议状态…'
  if (hostKey.value && !tokenReady.value) return '正在验证主持人身份…'
  return '正在进入会议…'
})

if (session?.hostKey) {
  void acquireHostToken()
}

/** 从业务接口返回的结束时间转换为本地毫秒时间戳，避免无效时间污染会话缓存。 */
function parseMeetingEndTime(value?: string | null): number | undefined {
  if (!value) return undefined
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? undefined : time
}

/**
 * 旧会话或分享链接可能绕过首页按钮直接进入会议页（桌面端）。
 * 用后端 join-check 兜底拦截已结束、已过期或密码不正确的会议。
 */
async function validateExistingSession(): Promise<void> {
  if (!session || session.hostKey) {
    joinCheckReady.value = true
    return
  }
  joinChecking.value = true
  try {
    const meeting = await checkJoinMeeting(props.roomName, session.password ?? '')
    const endTime = parseMeetingEndTime(meeting.scheduledEndTime)
    if (endTime && !session.endTime) {
      // 服务端返回的有效期补写到本地，窗口关闭、标题栏退出等逻辑都能沿用统一判断。
      saveSession({
        ...session,
        subject: session.subject || meeting.subject,
        endTime,
      })
    }
  } catch (error) {
    errorMsg.value = (error as Error).message || '会议已结束或已过期，无法进入'
  } finally {
    joinChecking.value = false
    joinCheckReady.value = true
  }
}

if (props.mode === 'desktop') {
  void validateExistingSession()
}

function setStatus(value: 'connecting' | 'joined' | 'kicked' | 'left'): void {
  status.value = value
  emit('status-changed', value)
}

/** 主持人密钥输入清洗：只保留合法字符并按 XXXX-XXXX-XXXX-XXXX 分组 */
function onGateHostKeyInput(event: Event): void {
  const raw = (event.target as HTMLInputElement).value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 16)
  gateHostKey.value = raw.match(/.{4}/g)?.join('-') ?? ''
}

// 加入门提交：密码可留空以支持无密码会议；prejoin 关闭时昵称仍然必填。
// 保存会话（非主持人）并把密码/昵称同步到 ref，随后挂载 JitsiFrame 入会；
// 填了主持人密钥则以主持人身份进入（host: true + hostKey）
function submitJoin(): void {
  if (joinChecking.value) return
  const pwd = joinPassword.value.trim()
  if (!PREJOIN_ENABLED && !gateName.value.trim()) {
    return
  }
  const applySession = (extra: { subject?: string; endTime?: number }): void => {
    password.value = pwd
    displayName.value = gateName.value.trim()
    const key = gateHostKey.value.trim()
    hostKey.value = key
    saveSession({
      roomName: props.roomName,
      subject: extra.subject ?? '',
      password: pwd,
      displayName: displayName.value,
      createdAt: Date.now(),
      host: key ? true : false,
      ...(key ? { hostKey: key } : {}),
      ...(extra.endTime ? { endTime: extra.endTime } : {}),
    })
    needsJoin.value = false
    setStatus('connecting')
    tokenReady.value = !key
    localModerator.value = false
    void acquireHostToken()
  }

  if (props.mode === 'desktop') {
    // 桌面端先在服务端校验会议存在、未过期且密码正确，再保存会话入会。
    void (async () => {
      joinChecking.value = true
      errorMsg.value = ''
      try {
        const meeting = await checkJoinMeeting(props.roomName, pwd)
        applySession({ subject: meeting.subject || '', endTime: parseMeetingEndTime(meeting.scheduledEndTime) })
      } catch (error) {
        errorMsg.value = (error as Error).message || '会议已结束或已过期，无法进入'
      } finally {
        joinChecking.value = false
      }
    })()
    return
  }
  applySession({})
}

const localParticipantId = ref('')
const jitsiApi = ref<JitsiMeetExternalAPI | null>(null)
watch([localModerator, status, jitsiApi], () => {
  if (!canUseHostMediaControls()) revokeHostMediaControls()
}, { flush: 'sync' })
// Jitsi customTheme 只在 iframe 初始化时读取；主题变化时更新该值并主动重建 iframe。
const meetingTheme = ref<ThemeMode>(androidEmbed ? 'light' : getCurrentTheme())
// 分组讨论室会触发 Jitsi 内部房间切换；父页面必须保留 iframe，避免误判为离会后关闭桌面窗口。
const preserveJitsiRoomSwitch = true
let meetingApiListenerCleanups: Array<() => void> = []
let removeGridVideoClickHandlers: (() => void) | null = null

async function reloadMeetingIframe(): Promise<void> {
  if (!jitsiFrame.value || status.value !== 'joined') return
  const frame = jitsiFrame.value
  cleanupMeetingApiListeners()
  stopMeetingBannerOverlaySync()
  participantMeetingBanners.value = {}
  largeVideoParticipantId = ''
  jitsiApi.value = null
  setLocalModerator(false)
  localParticipantId.value = ''
  status.value = 'connecting'
  // Let reactive jwt/theme props reach JitsiFrame before it constructs a new API.
  await nextTick()
  if (jitsiFrame.value === frame) frame.reloadWithTheme()
}

const stopThemeChange = onThemeChange((theme) => {
  const nextTheme = androidEmbed ? 'light' : theme
  if (meetingTheme.value === nextTheme) return
  meetingTheme.value = nextTheme
  // 重建期间先移除旧 API，避免自定义工具栏继续操作已销毁的 iframe。
  void reloadMeetingIframe()
})

async function reportJoined(info: { participantId: string }): Promise<void> {
  if (props.mode !== 'desktop' || !info.participantId || participantJoinedReported) return
  participantJoinedReported = true
  try {
    await reportParticipantJoined(props.roomName, info.participantId)
  } catch (error) {
    // 在线人数只影响历史状态落库；失败时保留日志，不打断已经成功进入的会议。
    console.warn('同步参会人入会状态失败', error)
  }
}

function clampBannerFontSize(value: unknown): number {
  const size = Math.round(Number(value))
  if (!Number.isFinite(size)) return BANNER_FONT_SIZE_DEFAULT
  return Math.max(BANNER_FONT_SIZE_MIN, Math.min(BANNER_FONT_SIZE_MAX, size))
}

/** 校验 #RRGGBB 颜色值，非法时回退默认值。 */
function normalizeBannerColor(value: unknown, fallback: string): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value.toUpperCase()
  return fallback
}

/** 背景色允许空串（无色）。 */
function normalizeBannerBgColor(value: unknown): string {
  if (value === '') return ''
  return normalizeBannerColor(value, BANNER_BG_DEFAULT)
}

function normalizeBannerFontFamily(value: unknown): string {
  if (typeof value !== 'string') return BANNER_FONT_FAMILY_DEFAULT
  return BANNER_FONT_OPTIONS.some((option) => option.value === value) ? value : BANNER_FONT_FAMILY_DEFAULT
}

function normalizeParticipantId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value || '').trim()
}

function meetingBannerHasContent(state: MeetingBannerState): boolean {
  return state.visible && (state.text.trim().length > 0 || state.logoUrl.length > 0)
}

function onAndroidMainParticipantChanged(participantId: string): void {
  androidMainParticipantId.value = participantId
  scheduleMeetingBannerOverlaySync()
}

function normalizeMeetingBannerState(value: unknown): MeetingBannerState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<MeetingBannerState>
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const logoUrl = normalizeBannerLogoUrl(raw.logoUrl)
  const updatedAt = Number(raw.updatedAt)
  return {
    visible: Boolean(raw.visible) && (text.length > 0 || logoUrl.length > 0),
    text,
    fontSize: clampBannerFontSize(raw.fontSize),
    color: normalizeBannerColor(raw.color, BANNER_COLOR_DEFAULT),
    fontFamily: normalizeBannerFontFamily(raw.fontFamily),
    bgColor: normalizeBannerBgColor(raw.bgColor),
    logoUrl,
    position: 'top',
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  }
}

async function refreshMeetingSubject(): Promise<void> {
  if (status.value !== 'joined') return
  const api = jitsiApi.value
  const data = await fetchMeetingBanner(props.roomName)
  if (api !== jitsiApi.value || status.value !== 'joined') return
  const state = normalizeMeetingBannerState(data)
  if (state && (state.updatedAt >= (meetingBanner.value.updatedAt || 0)
      || meetingBanner.value.updatedAt > Date.now() + 60_000)) meetingBanner.value = state
}

function getUniqueNormalizedValues(values: unknown[]): string[] {
  const seen = new Set<string>()
  const normalizedValues: string[] = []
  values.forEach((value) => {
    const normalized = normalizeParticipantId(value)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    normalizedValues.push(normalized)
  })
  return normalizedValues
}

function encodeMeetingBannerMessage(participantId: string, state: MeetingBannerState): string {
  const message: MeetingBannerMessage = {
    type: MEETING_BANNER_SIGNAL,
    participantId,
    banner: state,
  }
  return JSON.stringify(message)
}

function parseMeetingBannerMessage(payload: unknown, fallback?: unknown): MeetingBannerEnvelope | null {
  const text = getEndpointMessage(payload, fallback)
  if (!text) return null
  try {
    const data = JSON.parse(text) as Partial<MeetingBannerMessage>
    if (data.type !== MEETING_BANNER_SIGNAL) return null
    const participantId = getEndpointSenderParticipantId(payload)
    const state = normalizeMeetingBannerState(data.banner)
    if (!participantId || getParticipantRole(jitsiApi.value, participantId) !== 'moderator') return null
    return participantId && state ? { participantId, state } : null
  } catch {
    return null
  }
}

function applyParticipantMeetingBannerState(participantId: string, state: MeetingBannerState): void {
  const normalizedParticipantId = normalizeParticipantId(participantId)
  if (!normalizedParticipantId) return
  const current = participantMeetingBanners.value[normalizedParticipantId]
  if (current && state.updatedAt < current.updatedAt) return
  participantMeetingBanners.value = {
    ...participantMeetingBanners.value,
    [normalizedParticipantId]: state,
  }
  scheduleMeetingBannerOverlaySync()
}

function removeParticipantMeetingBannerState(participantId: string): void {
  const normalizedParticipantId = normalizeParticipantId(participantId)
  if (!normalizedParticipantId || !(normalizedParticipantId in participantMeetingBanners.value)) return
  const next = { ...participantMeetingBanners.value }
  delete next[normalizedParticipantId]
  participantMeetingBanners.value = next
  removeMeetingBannerOverlay(normalizedParticipantId)
}

function applyLocalMeetingBannerState(state: MeetingBannerState): void {
  if (androidEmbed) return
  meetingBanner.value = state
  if (localParticipantId.value) {
    applyParticipantMeetingBannerState(localParticipantId.value, state)
  }
}

function getParticipantId(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const event = value as { id?: unknown; participantId?: unknown }
    return String(event.participantId || event.id || '')
  }
  return ''
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function normalizeParticipantIdFromRecord(value: unknown): string {
  const record = getRecord(value)
  if (!record) return normalizeParticipantId(value)
  const directId =
    normalizeParticipantId(record.participantId)
    || normalizeParticipantId(record.id)
    || normalizeParticipantId(record.largeVideoParticipantId)
    || normalizeParticipantId(record.ownerParticipantId)
  if (directId) return directId

  const nestedKeys = ['participant', 'remoteParticipant', 'largeVideoParticipant', 'data']
  for (const key of nestedKeys) {
    const nestedId = normalizeParticipantIdFromRecord(record[key])
    if (nestedId) return nestedId
  }
  return ''
}

function normalizeLargeVideoChange(value: unknown): string {
  return normalizeParticipantIdFromRecord(value)
}

function normalizeRoleChange(participantId: unknown, role: unknown): { participantId: string; role: string } {
  if (participantId && typeof participantId === 'object') {
    const event = participantId as { id?: unknown; participantId?: unknown; role?: unknown }
    return {
      participantId: String(event.participantId || event.id || ''),
      role: String(event.role ?? role ?? ''),
    }
  }
  return {
    participantId: String(participantId || ''),
    role: String(role || ''),
  }
}

function getRemoteParticipantIds(api: JitsiMeetExternalAPI): string[] {
  try {
    return api
      .getParticipantsInfo()
      .map((participant) => String(participant.participantId ?? ''))
      .filter((id) => id && id !== localParticipantId.value)
  } catch {
    return []
  }
}

function normalizeNativeChatParticipant(value: unknown): NativeChatParticipant | null {
  const record = getRecord(value)
  if (!record) return null
  const id = normalizeParticipantId(record.participantId) || normalizeParticipantId(record.id)
  if (!id || id === localParticipantId.value || record.isHidden === true || record.isJigasi === true) return null
  const rawName = record.displayName ?? record.name ?? record.nick ?? ''
  const name = typeof rawName === 'string' ? rawName.trim() : String(rawName || '').trim()
  return { id, name: name || id }
}

function collectNativeChatParticipants(source: unknown, target: NativeChatParticipant[]): void {
  if (!source) return
  const items = Array.isArray(source)
    ? source
    : typeof source === 'object'
      ? Object.values(source as Record<string, unknown>)
      : []
  items.forEach((item) => {
    const participant = normalizeNativeChatParticipant(item)
    if (participant) target.push(participant)
  })
}

function dedupeNativeChatParticipants(participants: NativeChatParticipant[]): NativeChatParticipant[] {
  const seen = new Set<string>()
  return participants.filter((participant) => {
    if (!participant.id || seen.has(participant.id)) return false
    seen.add(participant.id)
    return true
  })
}

async function getNativeChatParticipants(api: JitsiMeetExternalAPI): Promise<NativeChatParticipant[]> {
  const participants: NativeChatParticipant[] = []
  if (api.getRoomsInfo) {
    try {
      const info = await api.getRoomsInfo(true)
      let rooms: unknown[] = []
      if (Array.isArray(info)) {
        rooms = info
      } else if (info && typeof info === 'object' && Array.isArray((info as { rooms?: unknown[] }).rooms)) {
        rooms = (info as { rooms?: unknown[] }).rooms ?? []
      }
      const mainRoom = rooms.find((room) => getRecord(room)?.isMainRoom === true) ?? rooms[0]
      collectNativeChatParticipants(getRecord(mainRoom)?.participants, participants)
    } catch (error) {
      console.warn('同步原生聊天成员列表失败', error)
    }
  }
  try {
    collectNativeChatParticipants(api.getParticipantsInfo(), participants)
  } catch {
    /* Older Jitsi builds may not expose getParticipantsInfo. */
  }
  return dedupeNativeChatParticipants(participants)
}

/**
 * 判断 Jitsi iframe 内当前聚焦的是否为"非聊天"文本输入框。
 * 投票表单、成员搜索等输入框聚焦弹键盘时不应带出原生聊天输入条；
 * 聊天消息输入框（#chat-input-messagebox 位于 #chat-input 内）聚焦则正常显示。
 * 焦点不在 iframe 文本框上（比如落在原生输入条上）时不拦截。
 */
function isNonChatTextInputFocused(): boolean {
  const active = getJitsiFrameDocument()?.activeElement as HTMLElement | null
  if (!active || typeof active.matches !== 'function') return false
  const isTextInput = active.matches(
    'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"]',
  )
  return isTextInput && !active.closest('#chat-input')
}

function postNativeChatState(participants: NativeChatParticipant[] = []): void {
  if (!androidEmbed) return
  window.parent.postMessage(
    {
      type: 'cloudmeet-native-chat-state',
      available: Boolean(status.value === 'joined' && jitsiApi.value),
      open: nativeChatOpen.value && !isNonChatTextInputFocused(),
      participants,
    },
    '*',
  )
}

let nativeChatFocusListenDoc: Document | null = null

/**
 * 在 Jitsi iframe 文档上挂焦点监听：键盘已打开时，在投票表单/成员搜索/聊天输入框
 * 之间切换焦点不会触发 inset 变化，原生层不会重新询问状态，需要靠焦点事件补同步。
 */
function ensureNativeChatFocusListener(): void {
  const doc = getJitsiFrameDocument()
  if (!doc || doc === nativeChatFocusListenDoc) return
  nativeChatFocusListenDoc?.removeEventListener('focusin', scheduleNativeChatStateSync)
  nativeChatFocusListenDoc?.removeEventListener('focusout', scheduleNativeChatStateSync)
  nativeChatFocusListenDoc = doc
  doc.addEventListener('focusin', scheduleNativeChatStateSync)
  doc.addEventListener('focusout', scheduleNativeChatStateSync)
}

async function syncNativeChatState(): Promise<void> {
  if (!androidEmbed) return
  const api = jitsiApi.value
  const participants = api ? await getNativeChatParticipants(api) : []
  if (api !== jitsiApi.value) return
  ensureNativeChatFocusListener()
  postNativeChatState(participants)
}

function scheduleNativeChatStateSync(): void {
  if (!androidEmbed) return
  if (nativeChatStateSyncTimer !== undefined) {
    window.clearTimeout(nativeChatStateSyncTimer)
  }
  nativeChatStateSyncTimer = window.setTimeout(() => {
    nativeChatStateSyncTimer = undefined
    void syncNativeChatState()
  }, 120)
}

function clearNativeChatState(): void {
  if (!androidEmbed) return
  if (nativeChatStateSyncTimer !== undefined) {
    window.clearTimeout(nativeChatStateSyncTimer)
    nativeChatStateSyncTimer = undefined
  }
  nativeChatFocusListenDoc?.removeEventListener('focusin', scheduleNativeChatStateSync)
  nativeChatFocusListenDoc?.removeEventListener('focusout', scheduleNativeChatStateSync)
  nativeChatFocusListenDoc = null
  nativeChatOpen.value = false
  window.parent.postMessage({ type: 'cloudmeet-native-chat-state', available: false, open: false, participants: [] }, '*')
}

function postNativeChatSendResult(ok: boolean, error = ''): void {
  if (!androidEmbed) return
  window.parent.postMessage({ type: 'cloudmeet-native-chat-send-result', ok, error }, '*')
}

function sendNativeChatMessageFromShell(data: { message?: unknown; to?: unknown }): void {
  const api = jitsiApi.value
  const message = typeof data.message === 'string' ? data.message.trim() : String(data.message || '').trim()
  if (!api || status.value !== 'joined') {
    postNativeChatSendResult(false, '聊天尚未准备好')
    return
  }
  if (!message) {
    postNativeChatSendResult(false, '请输入消息')
    return
  }
  const recipientId = normalizeParticipantId(data.to)
  try {
    api.executeCommand('sendChatMessage', message, recipientId || undefined, true)
    postNativeChatSendResult(true)
    scheduleNativeChatStateSync()
  } catch (error) {
    console.error('原生聊天发送失败', error)
    postNativeChatSendResult(false, '消息发送失败')
  }
}

/** 轮询间隔（秒）：0=关闭；开启时钳制 15–7200 秒，下限 15 秒防止误设过小值导致频繁轮询。 */
const TILE_POLLING_SECONDS_DEFAULT = 60
const TILE_POLLING_SECONDS_MIN_ON = 15
const TILE_POLLING_SECONDS_MAX = 7200

function normalizeTilePollingSeconds(value: unknown): number {
  if (value === undefined || value === null || value === '') return TILE_POLLING_SECONDS_DEFAULT
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return TILE_POLLING_SECONDS_DEFAULT
  const rounded = Math.round(seconds)
  if (rounded <= 0) return 0
  return Math.min(TILE_POLLING_SECONDS_MAX, Math.max(TILE_POLLING_SECONDS_MIN_ON, rounded))
}

function normalizeDesktopSettings(settings: unknown): DesktopSettings {
  if (!settings || typeof settings !== 'object') {
    return { video: { tilePollingSeconds: TILE_POLLING_SECONDS_DEFAULT } }
  }
  const raw = settings as DesktopSettings
  // 旧版桌面端/Android 存量配置是分钟字段，读取时换算为秒。
  const legacyMinutes = Number(raw.video?.tilePollingMinutes)
  const seconds = raw.video?.tilePollingSeconds
    ?? (Number.isFinite(legacyMinutes) ? legacyMinutes * 60 : undefined)
  return {
    recording: raw.recording,
    video: {
      tilePollingSeconds: normalizeTilePollingSeconds(seconds),
    },
  }
}

function applyDesktopSettings(settings: unknown): void {
  const normalized = normalizeDesktopSettings(settings)
  tilePollingSeconds.value = normalized.video?.tilePollingSeconds ?? 0
  if (tilePollingSeconds.value <= 0) {
    stopTilePolling({ disable: true })
    return
  }
  if (tilePollingEnabled.value) {
    restartTilePolling({ reset: true })
  }
}

function requestDesktopSettings(): void {
  if (props.mode === 'desktop' && window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-desktop-settings-get' }, '*')
  }
}

function normalizeParticipantMute(value: unknown): { participantId: string; isMuted: boolean; mediaType: string } {
  if (!value || typeof value !== 'object') {
    return { participantId: '', isMuted: false, mediaType: '' }
  }
  const event = value as { id?: unknown; participantId?: unknown; isMuted?: unknown; muted?: unknown; mediaType?: unknown }
  return {
    participantId: String(event.participantId || event.id || ''),
    isMuted: Boolean(event.isMuted ?? event.muted),
    mediaType: String(event.mediaType || ''),
  }
}

async function getMeetingParticipantSnapshots(api: JitsiMeetExternalAPI): Promise<MeetingParticipantSnapshot[]> {
  if (typeof api.getRoomsInfo === 'function') {
    try {
      const response = await api.getRoomsInfo(false)
      const rooms = Array.isArray(response) ? response : response?.rooms ?? []
      const mainRoom = rooms.find((room) => room?.isMainRoom) ?? rooms[0]
      const participants = Array.isArray(mainRoom?.participants) ? mainRoom.participants : []
      return participants
        .filter((participant) => !participant.isHidden && !participant.isJigasi)
        .map((participant) => {
          const id = String(participant.id || participant.participantId || '')
          return {
            id,
            displayName: participant.displayName,
            videoMuted: typeof participant.videoMuted === 'boolean' ? participant.videoMuted : videoMutedParticipantIds.has(id),
          }
        })
        .filter((participant) => participant.id)
    } catch (error) {
      console.warn('读取 Jitsi 房间成员信息失败，降级使用基础成员列表', error)
    }
  }

  try {
    return api
      .getParticipantsInfo()
      .map((participant) => {
        const id = String(participant.participantId || participant.id || '')
        return {
          id,
          displayName: participant.displayName,
          videoMuted: videoMutedParticipantIds.has(id),
        }
      })
      .filter((participant) => participant.id)
  } catch {
    return []
  }
}

async function getDefaultLayoutPollingParticipantIds(api: JitsiMeetExternalAPI): Promise<string[]> {
  const participants = await getMeetingParticipantSnapshots(api)
  return getUniqueNormalizedValues([
    ...participants.map((participant) => participant.id),
    localParticipantId.value,
  ])
}

function getJitsiFrameDocument(): Document | null {
  try {
    return jitsiApi.value?.getIFrame()?.contentDocument ?? null
  } catch {
    return null
  }
}

function getJitsiFrameWindow(): JitsiIframeWindow | null {
  try {
    return (jitsiApi.value?.getIFrame()?.contentWindow as JitsiIframeWindow | null) ?? null
  } catch {
    return null
  }
}

function removeMeetingBannerOverlay(participantId?: string, doc = getJitsiFrameDocument()): void {
  if (!doc) return
  doc.querySelectorAll<HTMLElement>(`.${BANNER_OVERLAY_CLASS}`).forEach((overlay) => {
    if (!participantId || overlay.dataset.participantId === participantId) {
      overlay.remove()
    }
  })
  doc.querySelectorAll<HTMLElement>(`.${BANNER_OVERLAY_HOST_CLASS}`).forEach((element) => {
    element.classList.remove(BANNER_OVERLAY_HOST_CLASS)
  })
}

function applyMeetingBannerOverlays(): void {
  reconcileMeetingPermissions()
  removeMeetingBannerOverlay()
}

function scheduleMeetingBannerOverlaySync(): void {
  if (meetingBannerOverlayFrame !== undefined) {
    window.cancelAnimationFrame(meetingBannerOverlayFrame)
  }
  meetingBannerOverlayFrame = window.requestAnimationFrame(() => {
    meetingBannerOverlayFrame = undefined
    applyMeetingBannerOverlays()
  })
}

function startMeetingBannerOverlaySync(): void {
  scheduleMeetingBannerOverlaySync()
  if (meetingBannerOverlayTimer !== undefined) return
  meetingBannerOverlayTimer = window.setInterval(applyMeetingBannerOverlays, 800)
}

function stopMeetingBannerOverlaySync(): void {
  if (meetingBannerOverlayTimer !== undefined) {
    window.clearInterval(meetingBannerOverlayTimer)
    meetingBannerOverlayTimer = undefined
  }
  if (meetingBannerOverlayFrame !== undefined) {
    window.cancelAnimationFrame(meetingBannerOverlayFrame)
    meetingBannerOverlayFrame = undefined
  }
  removeMeetingBannerOverlay()
}

function resetTilePollingState(): void {
  tilePollingCursor = 0
  strictGridPage.value = 0
  defaultLayoutPollingCurrentParticipantId = ''
}

function stopTilePolling(options: { disable?: boolean } = {}): void {
  if (options.disable) {
    tilePollingEnabled.value = false
  }
  if (tilePollingTimer !== undefined) {
    window.clearInterval(tilePollingTimer)
    tilePollingTimer = undefined
  }
  tilePollingSequence++
}

function shouldRunTilePolling(): boolean {
  return tilePollingEnabled.value && tilePollingControlAvailable.value
}

// ==================== 严格等分网格（耦合 jitsi-meet stable-11146 内部实现，升级 jitsi 必须回归测试） ====================
// 该实现直接 dispatch SET_TILE_VIEW_DIMENSIONS 到 iframe 内 redux store（payload 结构：
// gridDimensions / thumbnailSize / filmstripWidth / filmstripHeight / hasScroll），
// 并通过 .filmstrip__videos.remote-videos（react-window FixedSizeGrid 外层滚动容器）做滚动分页；
// 因为 jitsi 自身的 calculateResponsiveTileViewDimensions 只把 numberOfVisibleTiles 当“尽量塞满”的参考，
// 无法渲染严格的 N×N 网格，只能绕过它的网格算法。
const STRICT_GRID_TILE_MARGIN = 4        // TILE_VERTICAL_MARGIN / TILE_HORIZONTAL_MARGIN
const STRICT_GRID_OUTER_MARGIN = 14      // TILE_VIEW_GRID_VERTICAL_MARGIN / TILE_VIEW_GRID_HORIZONTAL_MARGIN
const STRICT_GRID_SCROLL_SIZE = 7        // SCROLL_SIZE
const STRICT_GRID_ASPECT_RATIO = 16 / 9  // TILE_ASPECT_RATIO

// 严格等分网格生效期间锁定滚动容器：隐藏滚动条并禁止用户手动滚动（滚轮/拖动/触摸）。
// 翻页只走分页器的 scrollTo 程序化滚动——overflow:hidden 下可滚动溢出仍在，scrollTo 不受影响。
// 手动滚动会破坏严格分页对齐；且 Windows 滚动条宽约 17px，超出 SCROLL_SIZE 预留的 7px，
// 竖向滚动条占位会把网格内容撑出横向滚动条，隐藏后横向溢出的根因一并消除。
const STRICT_GRID_SCROLL_LOCK_STYLE_ID = 'cloudmeet-strict-grid-scroll-lock'

function ensureStrictGridScrollLockStyle(): void {
  const doc = getJitsiFrameDocument()
  if (!doc || doc.getElementById(STRICT_GRID_SCROLL_LOCK_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = STRICT_GRID_SCROLL_LOCK_STYLE_ID
  style.textContent = `
.filmstrip__videos.remote-videos,
.filmstrip__videos {
  overflow: hidden !important;
  scrollbar-width: none !important;
}
.filmstrip__videos.remote-videos::-webkit-scrollbar,
.filmstrip__videos::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  display: none !important;
}
`
  doc.head?.appendChild(style)
}

function removeStrictGridScrollLockStyle(): void {
  getJitsiFrameDocument()?.getElementById(STRICT_GRID_SCROLL_LOCK_STYLE_ID)?.remove()
}

// Electron 全屏时清掉 Jitsi TileView 外层容器的 TILE_VIEW_GRID margin/padding（14px），
// 让宫格视频铺满整个会议区（对齐腾讯会议全屏观感）。窗口模式保留原边距，不注入。
const FULLSCREEN_TILE_VIEW_GUTTER_STYLE_ID = 'cloudmeet-fullscreen-tile-view-gutter'

function syncFullscreenTileViewGutterStyle(): void {
  const doc = getJitsiFrameDocument()
  if (!doc) return
  const shouldRemove =
    !(props.mode === 'desktop' && !androidEmbed && fullscreen.value && getMeetingLayoutTileCount(activeMeetingLayout.value) > 0)
  if (shouldRemove) {
    doc.getElementById(FULLSCREEN_TILE_VIEW_GUTTER_STYLE_ID)?.remove()
    return
  }
  let style = doc.getElementById(FULLSCREEN_TILE_VIEW_GUTTER_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = FULLSCREEN_TILE_VIEW_GUTTER_STYLE_ID
    doc.head?.appendChild(style)
  }
  style.textContent = `
.filmstrip__videos.remote-videos,
.filmstrip__videos.remote-videos > div {
  margin: 0 !important;
  padding: 0 !important;
}
/* Jitsi 在 has-scroll（恒成立）时给网格左侧补 7px padding-left 补偿右侧滚动条，
   但滚动条已被 scroll-lock 隐藏，补偿变成左侧留白条。
   注意 has-scroll 挂在 #remoteVideos（flex 父容器）上，Grid 外层并没有这个 class，
   所以选择器不能带 .remote-videos，否则匹配不到、修复不生效。 */
.tile-view .filmstrip__videos.has-scroll {
  padding-left: 0 !important;
}
/* videocontainer 原生 margin:2px 会让单格（1×1 宫格）上/左各留 2px。
   全屏铺满时全部清掉：格间距不依赖 margin（cell 宽 = 下发宽 +4，天然留 4px 间距）。
   用后代选择器而非 > div > div 层级——Jitsi Grid 内部层级若多一层会导致层级选择器匹配失败。 */
.tile-view .remote-videos .videocontainer {
  margin: 0 !important;
}
`
}

interface StrictGridMetrics {
  columns: number
  rows: number
  rowsPerPage: number
  width: number
  height: number
  filmstripWidth: number
  filmstripHeight: number
  hasScroll: boolean
}

/** Electron 宫格随实际人数排布，让完整 16:9 网格尽量填满会议区；其他端沿用固定页容量。
 *  outerMargin 默认复刻 Jitsi 的 TILE_VIEW_GRID 边距；桌面全屏传 0 让视频铺满整个会议区。 */
function getStrictGridMetrics(
  tileCount: number,
  totalTiles: number,
  viewportWidth: number,
  viewportHeight: number,
  fitToViewport = false,
  outerMargin = STRICT_GRID_OUTER_MARGIN,
): StrictGridMetrics {
  const maxColumns = Math.ceil(Math.sqrt(tileCount))
  const columns = fitToViewport ? Math.min(maxColumns, Math.ceil(Math.sqrt(Math.max(1, totalTiles)))) : maxColumns
  // 固定分屏的每页容量不能超过所选格数：2 分屏即 2 列 × 1 行。
  const configuredRowsPerPage = Math.ceil(tileCount / columns)
  const rowsPerPage = fitToViewport
    ? Math.max(1, Math.min(configuredRowsPerPage, Math.ceil(Math.max(1, totalTiles) / columns)))
    : configuredRowsPerPage
  const rows = Math.max(1, Math.ceil(totalTiles / columns))
  // 按实际人数决定完整行数。例如两人是 2×1，而不是预留空行的 2×2。
  // 再按整组 16:9 格子的宽高比尽量填满会议区。
  const gridAspectRatio = (columns * STRICT_GRID_ASPECT_RATIO) / rowsPerPage
  const gridWidth = fitToViewport
    ? Math.min(viewportWidth, viewportHeight * gridAspectRatio)
    : viewportWidth
  const gridHeight = fitToViewport ? Math.min(viewportHeight, gridWidth / gridAspectRatio) : viewportHeight
  // 按当前宫格的完整行列数计算单格尺寸，窗口宽高变化时同步缩放。
  const sizingRows = rowsPerPage
  // 桌面全屏铺满：下发满格尺寸。Jitsi 内部排版仍会在格子上固定 +4px 列宽/行高，
  // 单格场景 W×H 正好铺满视口，溢出部分被 scroll-lock 的 overflow:hidden 裁掉；
  // 多宫格时间距仍由内部 +4 机制保持，最右/最下 4px 溢出裁掉不影响观感。
  const fullscreenFill = fitToViewport && fullscreen.value
  const viewWidth = fullscreenFill ? gridWidth : gridWidth - columns * STRICT_GRID_TILE_MARGIN - outerMargin
  const viewHeight = fullscreenFill ? gridHeight : gridHeight - outerMargin - sizingRows * STRICT_GRID_TILE_MARGIN
  const initialWidth = viewWidth / columns
  const initialHeight = viewHeight / sizingRows

  let width: number
  let height: number
  if (fullscreenFill && columns === 1 && sizingRows === 1) {
    // 1×1 宫格铺满：视口未必精确 16:9（如 Windows 缩放后 1706.67×963），
    // 宽/高按 16:9 互相反推再 floor 会链式缩水（实测算出 959 高、顶部露 4px 背景）。
    // 高度直接顶满会议区，宽度按 16:9 放大，横向超出部分由 video cover 裁切吸收。
    height = Math.max(1, Math.round(viewportHeight - outerMargin))
    width = Math.max(1, Math.round(height * STRICT_GRID_ASPECT_RATIO))
  } else if (initialWidth / initialHeight > STRICT_GRID_ASPECT_RATIO) {
    height = Math.max(1, Math.floor(initialHeight))
    width = Math.max(1, Math.floor(height * STRICT_GRID_ASPECT_RATIO))
  } else {
    width = Math.max(1, Math.floor(initialWidth))
    height = Math.max(1, Math.floor(width / STRICT_GRID_ASPECT_RATIO))
  }

  const thumbnailsTotalHeight = rows * (STRICT_GRID_TILE_MARGIN + height)
  const availableHeight = fitToViewport
    ? Math.min(viewportHeight - outerMargin, rowsPerPage * (STRICT_GRID_TILE_MARGIN + height))
    : viewportHeight - outerMargin
  // 全屏铺满时滚动条已被 scroll-lock 隐藏，hasScroll 强制 false：
  // 避免 filmstripWidth 的 +7 预留让 Grid 外框宽于视口、flex 居中后内容整体偏移产生左上留白；
  // 同时也让 #remoteVideos 不再带 has-scroll class（Jitsi 的 padding-left:7px 补偿随之不生效）。
  const hasScroll = fullscreenFill ? false : availableHeight < thumbnailsTotalHeight
  const filmstripWidth =
    Math.min(gridWidth - outerMargin, columns * (STRICT_GRID_TILE_MARGIN + width)) + (hasScroll ? STRICT_GRID_SCROLL_SIZE : 0)
  const filmstripHeight = Math.min(availableHeight, thumbnailsTotalHeight)

  return { columns, rows, rowsPerPage, width, height, filmstripWidth, filmstripHeight, hasScroll }
}

/** 从 iframe redux 读取当前已生效的 tile view 尺寸（features/filmstrip.tileViewDimensions），用于判断是否需要重复下发。 */
function readAppliedStrictGridDims(store: { getState?: () => JitsiReduxState }): Omit<StrictGridMetrics, 'rowsPerPage'> | null {
  try {
    const filmstrip = getRecord(getRecord(store.getState?.())?.['features/filmstrip'])
    const dims = getRecord(filmstrip?.tileViewDimensions)
    const grid = getRecord(dims?.gridDimensions)
    const thumb = getRecord(dims?.thumbnailSize)
    if (!grid || !thumb) return null
    const columns = Number(grid.columns)
    const rows = Number(grid.rows)
    const width = Number(thumb.width)
    const height = Number(thumb.height)
    const filmstripWidth = Number(dims?.filmstripWidth)
    const filmstripHeight = Number(dims?.filmstripHeight)
    const hasScroll = dims?.hasScroll
    if (![columns, rows, width, height, filmstripWidth, filmstripHeight].every((value) => Number.isFinite(value))
      || typeof hasScroll !== 'boolean') return null
    return { columns, rows, width, height, filmstripWidth, filmstripHeight, hasScroll }
  } catch {
    return null
  }
}

/** 完整布局一致时才跳过 dispatch：全屏 4→2 分屏可能单格尺寸相同，仅可视容器高度变化。 */
function strictGridDimsAlreadyApplied(store: { getState?: () => JitsiReduxState }, metrics: StrictGridMetrics): boolean {
  const applied = readAppliedStrictGridDims(store)
  return (
    !!applied
    && applied.columns === metrics.columns
    && applied.rows === metrics.rows
    && Math.round(applied.width) === metrics.width
    && Math.round(applied.height) === metrics.height
    && applied.filmstripWidth === metrics.filmstripWidth
    && applied.filmstripHeight === metrics.filmstripHeight
    && applied.hasScroll === metrics.hasScroll
  )
}

/** 把严格网格尺寸直接下发到 iframe 内 redux store；任一环节不可达则返回 false，由调用方走兜底。 */
async function applyStrictGridDimensions(api: JitsiMeetExternalAPI, tileCount: number): Promise<boolean> {
  try {
    const frame = api.getIFrame()
    const store = getJitsiFrameWindow()?.APP?.store
    if (!frame || !store || typeof store.dispatch !== 'function') return false

    // 复用主画面轮询的成员合并逻辑：全员快照 + 本地成员（含关视频成员，网格中仍有占位格）。
    const totalTiles = (await getDefaultLayoutPollingParticipantIds(api)).length
    if (activeMeetingLayout.value === 'auto' && tileCount !== autoLayoutTileCount.value) return true
    const viewportWidth = frame.contentWindow?.innerWidth ?? frame.clientWidth
    const viewportHeight = frame.contentWindow?.innerHeight ?? frame.clientHeight
    if (viewportWidth <= 0 || viewportHeight <= 0) return false

    const fitToViewport = props.mode === 'desktop' && !androidEmbed && window.parent !== window
    // 全屏铺满：外层边距置 0，同时注入样式清掉 Jitsi TileView 容器的 TILE_VIEW_GRID margin/padding，两者必须同步。
    const metrics = getStrictGridMetrics(
      tileCount,
      totalTiles,
      viewportWidth,
      viewportHeight,
      fitToViewport,
      fitToViewport && fullscreen.value ? 0 : STRICT_GRID_OUTER_MARGIN,
    )

    strictGridMetrics = metrics
    strictGridPageCount.value = Math.max(1, Math.ceil(totalTiles / (metrics.columns * metrics.rowsPerPage)))
    if (strictGridPage.value >= strictGridPageCount.value) {
      strictGridPage.value = strictGridPageCount.value - 1
    }
    ensureStrictGridScrollLockStyle()
    syncFullscreenTileViewGutterStyle()

    // 开关视频等不改变人数的布局刷新会走"已应用"分支：跳过 dispatch。
    // 重复 dispatch 会触发 react-window 重渲染并重置 scrollTop，配合 transform 翻页造成页面抖动。
    if (!strictGridDimsAlreadyApplied(store, metrics)) {
      store.dispatch({
        type: 'SET_TILE_VIEW_DIMENSIONS',
        dimensions: {
          gridDimensions: { columns: metrics.columns, rows: metrics.rows },
          thumbnailSize: { height: metrics.height, width: metrics.width },
          filmstripHeight: metrics.filmstripHeight,
          filmstripWidth: metrics.filmstripWidth,
          hasScroll: metrics.hasScroll,
        },
      })
      // 尺寸重算后旧位移失效，先清掉再由 scheduleStrictGridPageRestore 按新尺寸补回当前页。
      clearStrictGridPageTransform()
    }
    scheduleStrictGridPageRestore()
    // 成员增减会触发 jitsi 重排分屏顺序（有滚动时不再短路），恢复为固定入会顺序。
    scheduleStableTileOrderRestore()
    return true
  } catch (error) {
    console.warn('下发严格等分网格尺寸失败', error)
    return false
  }
}

/** react-window FixedSizeGrid 的外层 div 即滚动容器；兜底匹配 .filmstrip__videos。 */
function getStrictGridScroller(): HTMLElement | null {
  const doc = getJitsiFrameDocument()
  if (!doc) return null
  return (doc.querySelector('.filmstrip__videos.remote-videos') ?? doc.querySelector('.filmstrip__videos')) as HTMLElement | null
}

/** 滚动容器的内层尺寸容器（react-window 第一个子节点），transform 翻页位移的作用对象。 */
function getStrictGridInner(): HTMLElement | null {
  return (getStrictGridScroller()?.firstElementChild as HTMLElement | null) ?? null
}

/** 清除 transform 翻页位移：尺寸重算、退出等分网格、离会时调用，避免残留位移。 */
function clearStrictGridPageTransform(): void {
  const inner = getStrictGridInner()
  if (inner?.style.transform) {
    inner.style.transform = ''
  }
}

function goToStrictGridPage(page: number): void {
  const metrics = strictGridMetrics
  const pageCount = strictGridPageCount.value
  if (!metrics || pageCount <= 1) return
  const scroller = getStrictGridScroller()
  if (!scroller) return
  const normalizedPage = ((page % pageCount) + pageCount) % pageCount
  strictGridPage.value = normalizedPage

  const targetOffset = normalizedPage * metrics.rowsPerPage * (metrics.height + STRICT_GRID_TILE_MARGIN)
  // 溢出不足一整页时（如 10 人只溢出 1 行），目标位移超出最大可滚动距离，
  // scrollTo 会被浏览器钳制，导致末页重复显示前面整页的行。
  // 先滚到可达位置让 react-window 渲染出目标行，剩余位移用 transform 补齐；
  // 被顶出视口的行由滚动锁的 overflow:hidden 裁掉——末页只显示剩余成员（腾讯会议式真分页视觉）。
  const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const actualScroll = Math.min(targetOffset, maxScroll)
  const extraOffset = targetOffset - actualScroll
  scroller.scrollTo({ top: actualScroll })
  const inner = getStrictGridInner()
  if (inner) {
    inner.style.transform = extraOffset > 0 ? `translateY(${-extraOffset}px)` : ''
  }
  scheduleMeetingBannerOverlaySync()
}

/** react-window 重渲染可能重置 scrollTop，尺寸重算后延迟把当前页的滚动位置补回来。 */
function scheduleStrictGridPageRestore(): void {
  if (strictGridPageRestoreTimer !== undefined) {
    window.clearTimeout(strictGridPageRestoreTimer)
  }
  strictGridPageRestoreTimer = window.setTimeout(() => {
    strictGridPageRestoreTimer = undefined
    if (strictGridPage.value > 0) {
      goToStrictGridPage(strictGridPage.value)
    }
  }, 80)
}

// ==================== 固定分屏顺序（等分网格专用，耦合 stable-11146 filmstrip 内部实现） ====================
// jitsi 的分屏顺序由 updateRemoteParticipants 动态计算：发言人/屏幕共享排最前，其余按昵称字母序；
// 且有滚动（超过一页）时 dominant speaker 每次变化都全量重排——第 2 页的人一说话就跳到第 1 页。
// 等分网格下改为固定入会顺序：发言人变化/成员变动后，把 filmstrip.remoteParticipants 强制恢复为
// 我们维护的稳定顺序（dispatch SET_REMOTE_PARTICIPANTS，与尺寸下发同一注入通道）。
// 默认布局（右侧成员列表）不干预，保留 jitsi 原生发言人置顶行为。
let stableTileOrder: string[] = []
let stableTileOrderRestoreTimer: number | undefined

/** 读取 iframe 内当前实际渲染的远端成员顺序（features/filmstrip.remoteParticipants）。 */
function getFilmstripRemoteParticipants(): string[] {
  try {
    const state = getJitsiFrameWindow()?.APP?.store?.getState?.()
    const filmstrip = getRecord(getRecord(state)?.['features/filmstrip'])
    const list = filmstrip?.remoteParticipants
    if (!Array.isArray(list)) return []
    return list.map((id) => normalizeParticipantId(id)).filter(Boolean)
  } catch {
    return []
  }
}

/** 计算目标顺序：已跟踪成员按入会顺序；未跟踪的（虚拟屏幕共享等）保持其在 jitsi 当前顺序中的位置。 */
function buildStableTileOrder(current: string[]): string[] {
  const desired = stableTileOrder.filter((id) => current.includes(id))
  current.forEach((id, index) => {
    if (!desired.includes(id)) {
      desired.splice(Math.min(index, desired.length), 0, id)
    }
  })
  return desired
}

/** 把 jitsi 重排后的分屏顺序恢复为固定入会顺序；仅在等分网格且会中生效。 */
function enforceStableTileOrder(): void {
  if (activeMeetingLayout.value === 'default' || status.value !== 'joined') return
  const store = getJitsiFrameWindow()?.APP?.store
  if (!store || typeof store.dispatch !== 'function') return
  const current = getFilmstripRemoteParticipants()
  if (!current.length) return
  const desired = buildStableTileOrder(current)
  if (desired.length === current.length && desired.every((id, index) => id === current[index])) return
  try {
    store.dispatch({ type: 'SET_REMOTE_PARTICIPANTS', participants: desired })
  } catch (error) {
    console.warn('恢复固定分屏顺序失败', error)
  }
}

/** jitsi 的重排发生在我们收到事件之前/同时，延迟一拍再恢复，避免被其覆盖；连续触发自动去抖。 */
function scheduleStableTileOrderRestore(): void {
  if (activeMeetingLayout.value === 'default') return
  if (stableTileOrderRestoreTimer !== undefined) {
    window.clearTimeout(stableTileOrderRestoreTimer)
  }
  stableTileOrderRestoreTimer = window.setTimeout(() => {
    stableTileOrderRestoreTimer = undefined
    enforceStableTileOrder()
  }, 80)
}

/** 成员入会：追加到稳定顺序末尾（去重、排除自己），并恢复一次顺序。 */
function trackStableTileOrderJoin(participantId: string): void {
  const id = normalizeParticipantId(participantId)
  if (!id || id === localParticipantId.value) return
  if (!stableTileOrder.includes(id)) {
    stableTileOrder.push(id)
  }
  scheduleStableTileOrderRestore()
}

/** 成员离会：从稳定顺序移除，并恢复一次顺序。 */
function trackStableTileOrderLeave(participantId: string): void {
  const id = normalizeParticipantId(participantId)
  if (!id) return
  stableTileOrder = stableTileOrder.filter((existing) => existing !== id)
  scheduleStableTileOrderRestore()
}

function resetStableTileOrder(): void {
  stableTileOrder = []
  if (stableTileOrderRestoreTimer !== undefined) {
    window.clearTimeout(stableTileOrderRestoreTimer)
    stableTileOrderRestoreTimer = undefined
  }
}

/** 兜底路径：旧的 overwriteConfig 逻辑；已处于 tile view 时 setTileView(true) 是 no-op，先关再开强制 jitsi 重算尺寸（会有短暂主画面闪烁）。 */
function applyLegacyTileViewLayout(api: JitsiMeetExternalAPI, tileCount: number): void {
  strictGridMetrics = null
  strictGridPage.value = 0
  strictGridPageCount.value = 1
  clearStrictGridPageTransform()
  // 兜底路径走 jitsi 原生平铺分页，恢复其滚动能力。
  removeStrictGridScrollLockStyle()
  api.executeCommand('overwriteConfig', {
    tileView: {
      numberOfVisibleTiles: tileCount,
    },
  })
  api.executeCommand('pinParticipant', null)
  api.executeCommand('setTileView', false)
  window.setTimeout(() => {
    try {
      api.executeCommand('setTileView', true)
    } catch (error) {
      console.warn('恢复等分视频布局失败', error)
    }
  }, 150)
}

function applyTileViewLayout(api: JitsiMeetExternalAPI, tileCount: number, activateTileView = true): void {
  if (activateTileView) {
    try {
      api.executeCommand('setTileView', true)
    } catch (error) {
      console.warn('开启等分视频布局失败', error)
      return
    }
  }
  void applyStrictGridDimensions(api, tileCount)
    .then((applied) => {
      if (!applied) {
        applyLegacyTileViewLayout(api, tileCount)
      }
    })
    .catch((error) => {
      console.warn('应用严格等分网格失败，使用兜底布局', error)
      applyLegacyTileViewLayout(api, tileCount)
    })
}

function getNextDefaultLayoutPollingParticipantId(ids: string[]): string {
  if (!ids.length) return ''
  const currentIndex = defaultLayoutPollingCurrentParticipantId
    ? ids.indexOf(defaultLayoutPollingCurrentParticipantId)
    : -1
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % ids.length : tilePollingCursor % ids.length
  tilePollingCursor = (nextIndex + 1) % ids.length
  return ids[nextIndex] || ''
}

async function applyDefaultLayoutPollingState(api: JitsiMeetExternalAPI, sequence: number): Promise<void> {
  const ids = await getDefaultLayoutPollingParticipantIds(api)
  if (sequence !== tilePollingSequence || activeMeetingLayout.value !== 'default') return
  const participantId = getNextDefaultLayoutPollingParticipantId(ids)
  if (!participantId) return

  try {
    api.executeCommand('setTileView', false)
    api.executeCommand('pinParticipant', participantId, 'camera')
    defaultLayoutPollingCurrentParticipantId = participantId
    largeVideoParticipantId = participantId
    forceJitsiLayoutReflow(api)
    scheduleMeetingBannerOverlaySync()
  } catch (error) {
    console.warn('轮询切换主画面失败', error)
  }
}

function forceJitsiLayoutReflow(api: JitsiMeetExternalAPI): void {
  const frame = api.getIFrame()
  if (!frame) return

  try {
    const frameWindow = frame.contentWindow
    if (frameWindow) {
      const ResizeEvent = (frameWindow as Window & { Event: typeof Event }).Event
      frameWindow.dispatchEvent(new ResizeEvent('resize'))
    }
  } catch {
    /* 跨域部署时不能触达 iframe 内部窗口，忽略即可。 */
  }

  try {
    // Jitsi 持久保存非零宽高；普通 resize 不会清除，退出全屏会暴露旧尺寸。
    // 0 解除 preferredWidth/Height，仍由 Jitsi 扣除成员栏/聊天栏占位。
    api.executeCommand('resizeLargeVideo', 0, 0)
  } catch {
    /* 旧版 Jitsi 不支持 resizeLargeVideo 时，setTileView 仍会兜底刷新。 */
  }
}

function clearTileLayoutRefreshTimers(): void {
  tileLayoutRefreshTimers.forEach((timer) => window.clearTimeout(timer))
  tileLayoutRefreshTimers = []
}

function autoTileCount(participants: number): number {
  if (participants <= 9) return 9
  return participants <= 25 ? 25 : 49
}

async function refreshAutoLayout(sequence: number): Promise<void> {
  const api = jitsiApi.value
  if (!api || activeMeetingLayout.value !== 'auto') return
  const participants = (await getDefaultLayoutPollingParticipantIds(api)).length
  if (sequence !== autoLayoutRefreshSequence || api !== jitsiApi.value || activeMeetingLayout.value !== 'auto') return
  const nextTileCount = autoTileCount(participants)
  if (nextTileCount !== autoLayoutTileCount.value) {
    autoLayoutTileCount.value = nextTileCount
    strictGridPage.value = 0
    if (tilePollingEnabled.value) restartTilePolling({ reset: true })
    else applyTileViewLayout(api, nextTileCount)
  } else if (tilePollingEnabled.value) {
    restartTilePolling()
  }
  if (!tilePollingEnabled.value) scheduleActiveTileLayoutRefresh()
}

function scheduleAutoLayoutRefresh(): void {
  autoLayoutRefreshSequence++
  const sequence = autoLayoutRefreshSequence
  autoLayoutRefreshTimers.forEach((timer) => window.clearTimeout(timer))
  autoLayoutRefreshTimers = [160, 800].map((delay) => window.setTimeout(() => {
    void refreshAutoLayout(sequence)
  }, delay))
}

function refreshActiveTileLayout(): void {
  if (tilePollingEnabled.value) return
  const api = jitsiApi.value
  const tileCount = getMeetingLayoutTileCount(activeMeetingLayout.value)
  if (!api || tileCount <= 0) return

  try {
    applyTileViewLayout(api, tileCount)
    // 不再调 forceJitsiLayoutReflow：宫格尺寸未变时，合成 resize / resizeLargeVideo
    // 只会无谓 repaint 视频区（闪屏来源）；尺寸变化由 applyStrictGridDimensions 直接生效。
    scheduleMeetingBannerOverlaySync()
  } catch (error) {
    console.warn('刷新等分视频布局失败', error)
  }
}

function scheduleActiveTileLayoutRefresh(): void {
  if (tilePollingEnabled.value || getMeetingLayoutTileCount(activeMeetingLayout.value) <= 0) return
  clearTileLayoutRefreshTimers()
  // 单轮延迟即可：尺寸/页数只需一次重算，多轮（旧实现 3 轮）会导致 grid 反复重排闪屏。
  const refreshDelays = [120]
  refreshDelays.forEach((delay) => {
    const timer = window.setTimeout(() => {
      tileLayoutRefreshTimers = tileLayoutRefreshTimers.filter((activeTimer) => activeTimer !== timer)
      refreshActiveTileLayout()
    }, delay)
    tileLayoutRefreshTimers.push(timer)
  })
}

function clearJitsiWindowResizeRefreshTimers(): void {
  if (jitsiWindowResizeRefreshTimer !== undefined) {
    window.clearTimeout(jitsiWindowResizeRefreshTimer)
    jitsiWindowResizeRefreshTimer = undefined
  }
}

function refreshJitsiLayoutAfterWindowResize(): void {
  const api = jitsiApi.value
  const frame = api?.getIFrame()
  if (!api || !frame || frame.clientWidth <= 0 || frame.clientHeight <= 0) return

  try {
    const tileCount = getMeetingLayoutTileCount(activeMeetingLayout.value)
    if (!tilePollingEnabled.value && tileCount > 0) {
      applyTileViewLayout(api, tileCount, false)
    } else if (activeMeetingLayout.value === 'default') {
      // 兼容此前写入的指定尺寸；也覆盖全屏 CSS 移除后的默认主画面。
      api.executeCommand('resizeLargeVideo', 0, 0)
    }
    // 宫格仍只夺回严格网格尺寸，不发送主视频 resize，避免重绘造成闪屏。
    scheduleMeetingBannerOverlaySync()
  } catch (error) {
    console.warn('刷新窗口尺寸后的会议布局失败', error)
  }
}

function scheduleJitsiWindowResizeRefresh(force = false): void {
  const root = meetingStageRoot.value
  if (!root) return
  const rect = root.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const sizeKey = `${Math.round(rect.width)}x${Math.round(rect.height)}`
  if (!force && sizeKey === lastMeetingStageSizeKey) return
  lastMeetingStageSizeKey = sizeKey
  clearJitsiWindowResizeRefreshTimers()
  // 外层尺寸稳定后，覆盖一次严格网格或恢复默认主视频的响应式尺寸。
  // 壳消息和 ResizeObserver 会报告同一次变化；缩放后无需重新开启 tile view。
  jitsiWindowResizeRefreshTimer = window.setTimeout(() => {
    jitsiWindowResizeRefreshTimer = undefined
    refreshJitsiLayoutAfterWindowResize()
  }, 180)
}

function stopMeetingStageResizeObserver(): void {
  meetingStageResizeObserver?.disconnect()
  meetingStageResizeObserver = null
  lastMeetingStageSizeKey = ''
}

function startMeetingStageResizeObserver(): void {
  stopMeetingStageResizeObserver()
  const target = meetingStageRoot.value
  if (!target || typeof window.ResizeObserver === 'undefined') return

  meetingStageResizeObserver = new window.ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (!rect) return
    if (rect.width <= 0 || rect.height <= 0) return
    scheduleJitsiWindowResizeRefresh()
  })
  meetingStageResizeObserver.observe(target)
}

async function applyTilePollingState(sequence: number, options: { replaceOne?: boolean } = {}): Promise<void> {
  if (sequence !== tilePollingSequence) return
  const api = jitsiApi.value
  if (!api) return
  if (activeMeetingLayout.value === 'polling') {
    await applyPollingLayoutTick(sequence)
    return
  }
  if (activeMeetingLayout.value === 'default') {
    await applyDefaultLayoutPollingState(api, sequence)
    return
  }

  const tileCount = getMeetingLayoutTileCount(activeMeetingLayout.value)
  if (tileCount <= 0) return

  // 网格模式轮询 = 严格网格分页轮转：每帧刷新尺寸（总人数不满一页时自然只有单页），
  // replaceOne 节拍到来时翻到下一页（首尾循环）。
  try {
    applyTileViewLayout(api, tileCount)
    scheduleMeetingBannerOverlaySync()
    if (options.replaceOne && strictGridPageCount.value > 1) {
      goToStrictGridPage(strictGridPage.value + 1)
    }
  } catch (error) {
    console.warn('轮询切换等分网格页失败', error)
  }
}

function restartTilePolling(options: { reset?: boolean } = {}): void {
  stopTilePolling()
  if (options.reset) {
    resetTilePollingState()
  }
  if (!shouldRunTilePolling()) return

  const intervalMs = tilePollingSeconds.value * 1000
  const sequence = tilePollingSequence
  void applyTilePollingState(sequence)
  tilePollingTimer = window.setInterval(() => {
    void applyTilePollingState(sequence, { replaceOne: true })
  }, intervalMs)
}

// ==================== 轮询布局（左槽固定主持人 + 右槽轮播勾选组员，复用上方轮询计时器） ====================

/** 向桌面/Android 壳上报当前布局（web 主动切换时让标题栏选中态一致）。 */
function notifyShellLayoutChanged(mode: string): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-layout-changed', mode }, '*')
  }
}

/** 名单内仍在会的成员（离会即被剔除，不由右槽显示）。 */
async function getOnlinePollingGroupIds(api: JitsiMeetExternalAPI): Promise<string[]> {
  const snapshots = await getMeetingParticipantSnapshots(api)
  const online = new Set(snapshots.map((snapshot) => snapshot.id))
  return pollingGroupIds.value.filter((id) => online.has(id))
}

/** 轮询节拍：刷新左槽主持人，右槽按游标切到下一位组员；幂等，单人不会反复重建视频。 */
async function applyPollingLayoutTick(sequence: number): Promise<void> {
  if (sequence !== tilePollingSequence) return
  const api = jitsiApi.value
  if (!api) return
  const onlineIds = await getOnlinePollingGroupIds(api)
  if (sequence !== tilePollingSequence) return
  const next = getNextPollingMemberId(onlineIds, pollingRightParticipantId.value, pollingCursor)
  pollingCursor = next.cursor
  pollingRightParticipantId.value = next.id
  await refreshPollingSlots()
}

/** 目标参与者变化时才重绑对应槽位；attach 支持同轨道多容器，不影响 iframe 内渲染。 */
async function attachPollingSlot(kind: 'left' | 'right', participantId: string): Promise<void> {
  const slot = kind === 'left' ? pollingLeftSlot.value : pollingRightSlot.value
  if (!slot) return
  const api = jitsiApi.value
  let track: PollingJitsiTrack | null = null
  if (api && participantId && status.value === 'joined') {
    track = getParticipantCameraTrack(api, participantId, localParticipantId.value)
    // 摄像头关闭时显示占位，不让黑屏占位画面。
    if (track?.isMuted?.()) track = null
  }
  const attachedId = kind === 'left' ? pollingLeftAttachedId : pollingRightAttachedId
  const attachedTrack = kind === 'left' ? pollingLeftTrack : pollingRightTrack
  const attachedVideo = slot.querySelector('video')
  if (attachedId === participantId && attachedTrack === track) {
    if (kind === 'left') pollingLeftHasVideo.value = Boolean(track)
    else pollingRightHasVideo.value = Boolean(track)
    return
  }
  if (attachedTrack && attachedVideo) {
    try {
      attachedTrack.detach(attachedVideo)
    } catch {
      /* iframe 重载后旧轨道可能已失效，忽略 */
    }
  }
  slot.querySelectorAll('video').forEach((video) => video.remove())
  if (kind === 'left') {
    pollingLeftAttachedId = participantId
    pollingLeftTrack = track
  } else {
    pollingRightAttachedId = participantId
    pollingRightTrack = track
  }
  if (track) {
    // JitsiTrack.attach 只设置传入媒体元素的 srcObject，不会在 div 内创建 video。
    const video = slot.ownerDocument.createElement('video')
    video.autoplay = true
    video.muted = true
    video.playsInline = true
    slot.appendChild(video)
    try {
      await track.attach(video)
      void video.play().catch(() => undefined)
    } catch (error) {
      try { track.detach(video) } catch { /* 轨道已失效 */ }
      video.remove()
      console.warn('轮询视频轨道挂载失败', error)
      track = null
      if (kind === 'left') pollingLeftTrack = null
      else pollingRightTrack = null
    }
  }
  if (kind === 'left') pollingLeftHasVideo.value = Boolean(track)
  else pollingRightHasVideo.value = Boolean(track)
}

/** 按当前主持人 + 右槽组员刷新两个槽位；仅轮询布局下生效。 */
async function refreshPollingSlots(): Promise<void> {
  if (activeMeetingLayout.value !== 'polling') return
  const api = jitsiApi.value
  if (!api) return
  pollingHostId.value = getMeetingModeratorId(api)
  await attachPollingSlot('left', pollingHostId.value)
  await attachPollingSlot('right', pollingRightParticipantId.value)
}

/** 退出轮询布局/离开会议：detach 轨道、清挂载引用，避免残留画面。 */
function clearPollingSlots(): void {
  const slots: Array<'left' | 'right'> = ['left', 'right']
  slots.forEach((kind) => {
    const slot = kind === 'left' ? pollingLeftSlot.value : pollingRightSlot.value
    const attachedTrack = kind === 'left' ? pollingLeftTrack : pollingRightTrack
    if (slot) {
      slot.querySelectorAll('video').forEach((video) => {
        try { attachedTrack?.detach(video) } catch { /* 轨道已失效 */ }
        video.srcObject = null
        video.remove()
      })
    }
  })
  pollingLeftAttachedId = ''
  pollingRightAttachedId = ''
  pollingLeftTrack = null
  pollingRightTrack = null
  pollingLeftHasVideo.value = false
  pollingRightHasVideo.value = false
}

function refreshMeetingLayoutAfterParticipantChange(): void {
  if (activeMeetingLayout.value === 'auto') {
    scheduleAutoLayoutRefresh()
    return
  }
  if (tilePollingEnabled.value) {
    restartTilePolling()
    return
  }
  scheduleActiveTileLayoutRefresh()
}

function sendMeetingBannerStateToParticipant(participantId: string, ownerParticipantId: string, state: MeetingBannerState): void {
  if (!jitsiApi.value || !participantId || !ownerParticipantId) return
  try {
    jitsiApi.value.executeCommand('sendEndpointTextMessage', participantId, encodeMeetingBannerMessage(ownerParticipantId, state))
  } catch (error) {
    console.warn('同步会议电子屏失败', error)
  }
}

function broadcastLocalMeetingBannerState(state = meetingBanner.value): void {
  if (androidEmbed || !localModerator.value) return
  const api = jitsiApi.value
  if (!getJoinedModeratorConference(api)) return
  const ownerParticipantId = localParticipantId.value
  if (!api || !ownerParticipantId || state.updatedAt <= 0) return
  getRemoteParticipantIds(api).forEach((participantId) => {
    sendMeetingBannerStateToParticipant(participantId, ownerParticipantId, state)
  })
}

function syncLocalMeetingBannerToParticipant(participant: unknown): void {
  if (androidEmbed || !localModerator.value) return
  if (!getJoinedModeratorConference(jitsiApi.value)) return
  if (meetingBanner.value.updatedAt <= 0 || !localParticipantId.value) return
  const participantId = getParticipantId(participant)
  if (participantId && participantId !== localParticipantId.value) {
    sendMeetingBannerStateToParticipant(participantId, localParticipantId.value, meetingBanner.value)
    return
  }
  window.setTimeout(() => broadcastLocalMeetingBannerState(), 300)
}

// 入会通知可能早于接收端监听或数据通道就绪。主动拉取并有限重试，状态回复即确认。
function requestMissingMeetingBannerStates(): void {
  const api = jitsiApi.value
  if (!api || status.value !== 'joined') return
  getRemoteParticipantIds(api).forEach((participantId) => {
    if (Object.prototype.hasOwnProperty.call(participantMeetingBanners.value, participantId)) return
    try {
      api.executeCommand('sendEndpointTextMessage', participantId, MEETING_BANNER_REQUEST_SIGNAL)
    } catch (error) {
      console.warn('请求会议电子屏状态失败', error)
    }
  })
}

function clearMeetingBannerStateSync(): void {
  meetingBannerStateSyncTimers.forEach((timer) => window.clearTimeout(timer))
  meetingBannerStateSyncTimers = []
}

function scheduleMeetingBannerStateSync(): void {
  clearMeetingBannerStateSync()
  const retryDelays = [0, 500, 1500, 3500, 7500, 15000]
  retryDelays.forEach((delay) => {
    const timer = window.setTimeout(() => {
      meetingBannerStateSyncTimers = meetingBannerStateSyncTimers.filter((activeTimer) => activeTimer !== timer)
      requestMissingMeetingBannerStates()
      void refreshMeetingSubject()
    }, delay)
    meetingBannerStateSyncTimers.push(timer)
  })
}

function handleMeetingBannerMessage(payload: unknown, fallback?: unknown): void {
  if (getEndpointMessage(payload, fallback) === MEETING_BANNER_REQUEST_SIGNAL) {
    const participantId = getEndpointSenderParticipantId(payload)
    if (participantId && participantId !== localParticipantId.value) {
      // 即使没有设置电子屏也回复空状态，让请求方停止重试。
      sendMeetingBannerStateToParticipant(participantId, localParticipantId.value,
        localModerator.value && getJoinedModeratorConference(jitsiApi.value)
          ? meetingBanner.value : createDefaultMeetingBannerState())
    }
    return
  }
  const message = parseMeetingBannerMessage(payload, fallback)
  if (message) {
    applyParticipantMeetingBannerState(message.participantId, message.state)
    void refreshMeetingSubject()
  }
}

function reconcileMeetingPermissions(): void {
  const api = jitsiApi.value
  const role = getParticipantRole(api, localParticipantId.value)
  const moderator = Boolean(getJoinedModeratorConference(api))
  // Cached moderator roles during disconnect/transition cannot authorize UI.
  const verifiedRole = moderator ? 'moderator' : role === 'moderator' ? '' : role
  if (localModerator.value !== moderator || localRole.value !== verifiedRole) {
    setLocalModerator(moderator, verifiedRole)
  }
  Object.keys(participantMeetingBanners.value).forEach((participantId) => {
    if (getParticipantRole(api, participantId) !== 'moderator') {
      removeParticipantMeetingBannerState(participantId)
    }
  })
}

function setLocalModerator(value: boolean, role = value ? 'moderator' : ''): void {
  const demoted = localModerator.value && !value && (role === 'participant' || role === 'none')
  if (demoted && hostKey.value) {
    // A passive creator reclaim does not run the source transfer callback.
    // Retire its stale key without deleting a newly delivered replacement.
    const previousKey = hostKey.value
    const pendingReplacement = getPendingHostTransfer(props.roomName)
    if (!pendingReplacement) {
      try { clearTransferredHostKey(props.roomName, previousKey) }
      catch { console.warn('旧主持人凭据清理失败') }
    }
    hostKey.value = ''
    hostToken.value = null
    // Preserve the live media/XMPP session. Prosody has already revoked its
    // affiliation; a stale JWT cannot grant ownership on a fresh online check.
    // Clearing this prop supplies guest credentials to the next explicit init,
    // not a token replacement inside the current iframe/transport.
  }
  localRole.value = role
  localModerator.value = Boolean(value)
  shellCloseMenuCanEndForAll.value = localModerator.value && !!hostKey.value
  if (!localModerator.value) {
    bannerPanelOpen.value = false
    removeParticipantMeetingBannerState(localParticipantId.value)
  }
}

function handleLocalRoleChanged(participantId: unknown, role: unknown): void {
  const change = normalizeRoleChange(participantId, role)
  if (!change.participantId) return
  if (change.role !== 'moderator') removeParticipantMeetingBannerState(change.participantId)
  if (!localParticipantId.value || change.participantId !== localParticipantId.value) return
  // External API role events are queued postMessages. An initial participant
  // event can arrive after online JWT verification has already granted owner.
  // Use the current iframe state, never a historical event, to retire keys.
  const currentRole = getParticipantRole(jitsiApi.value, localParticipantId.value)
  const moderator = Boolean(getJoinedModeratorConference(jitsiApi.value))
  setLocalModerator(moderator, moderator ? 'moderator' : currentRole === 'moderator' ? '' : currentRole)
  if (localModerator.value) broadcastLocalMeetingBannerState()
}

const LARGE_VIDEO_FIT_STYLE_ID = 'cloudmeet-large-video-fit'

/** Fill only the desktop fullscreen main-video area, not the filmstrip or viewport.
 * Jitsi's inline wrapper dimensions can otherwise leave the video in the top-left. */
function syncDesktopFullscreenMainVideoStyle(): void {
  const doc = getJitsiFrameDocument()
  if (!doc?.head) return
  const styleId = 'cloudmeet-desktop-fullscreen-main-video'
  let style = doc.getElementById(styleId) as HTMLStyleElement | null
  if (props.mode !== 'desktop' || androidEmbed || !fullscreen.value || activeMeetingLayout.value !== 'default') {
    style?.remove()
    return
  }
  if (style) return
  style = doc.createElement('style')
  style.id = styleId
  style.textContent = `
#largeVideoWrapper {
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
}
#largeVideo {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
}
`
  doc.head.appendChild(style)
}

/**
 * 让主画面视频完整显示（object-fit: contain）。
 * Jitsi 默认 #largeVideo{object-fit:cover}：竖屏/窄屏（Android 竖持）看横屏共享时，
 * 画面被放大到撑满高度、左右两侧被裁掉，参会人只能看到共享内容的中间一截。
 * contain 后空出的区域由 jitsi 自带的模糊背景层填充，观感与腾讯会议一致。幂等。
 */
function ensureLargeVideoFitStyle(): void {
  syncDesktopFullscreenMainVideoStyle()
  const doc = getJitsiFrameDocument()
  if (!doc?.head || doc.getElementById(LARGE_VIDEO_FIT_STYLE_ID)) return
  const style = doc.createElement('style')
  style.id = LARGE_VIDEO_FIT_STYLE_ID
  style.textContent = `
#largeVideo,
#largeVideoWrapper {
  object-fit: contain !important;
}
#sharedVideo video {
  object-fit: contain !important;
}
`
  doc.head.appendChild(style)
}

/** 宫格和独立轮询布局共用双击行为；单击不改变当前布局。 */
function openParticipantMainView(participantId: string): void {
  if (!participantId) return
  applyMeetingLayout('default')
  try { jitsiApi.value?.executeCommand('pinParticipant', participantId, 'camera') } catch { /* Conference may be closing. */ }
  notifyShellLayoutChanged('default')
}

function installGridVideoClickHandlers(): void {
  if (props.mode !== 'desktop') return
  const doc = getJitsiFrameDocument()
  if (!doc) return

  const getVideoTile = (event: MouseEvent): HTMLElement | null => {
    if (getMeetingLayoutTileCount(activeMeetingLayout.value) <= 0) return null
    const target = event.target as Element | null
    if (!target || typeof target.closest !== 'function') return null
    if (target.closest('button, a, input, select, textarea, [role="button"], [contenteditable="true"]')) return null
    return target.closest<HTMLElement>('[id^="participant_"], [id^="localVideoContainer"]')
  }

  const onClick = (event: MouseEvent): void => {
    if (!getVideoTile(event)) return
    // Jitsi pins a tile on click, which exits tile view. A single click must keep the grid.
    event.stopImmediatePropagation()
    event.preventDefault()
  }
  const onDoubleClick = (event: MouseEvent): void => {
    const tile = getVideoTile(event)
    if (!tile) return
    event.stopImmediatePropagation()
    event.preventDefault()
    const participantId = tile.id.startsWith('participant_')
      ? tile.id.slice('participant_'.length)
      : localParticipantId.value
    openParticipantMainView(participantId)
  }

  doc.addEventListener('click', onClick, true)
  doc.addEventListener('dblclick', onDoubleClick, true)
  removeGridVideoClickHandlers = () => {
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('dblclick', onDoubleClick, true)
  }
}

function setupMeetingApiListeners(api: JitsiMeetExternalAPI): void {
  cleanupMeetingApiListeners()
  const frame = api.getIFrame()?.contentWindow
  if (frame) meetingApiListenerCleanups.push(attachHostParticipantMenu(frame, id => {
    const state = (frame as Window & { APP?: any }).APP?.store?.getState()
    const participants = state?.['features/base/participants']
    const localId = participants?.local?.id
    return getHostParticipantAction(
      Boolean(hostKey.value) && Boolean(getJoinedModeratorConference(api)),
      canReclaimHost(api, props.roomName, Boolean(getJoinedModeratorConference(api))),
      getParticipantRole(api, id) ?? '', id === localId,
    )
  }))
  ensureLargeVideoFitStyle()
  installGridVideoClickHandlers()
  let transferErrorReported = false
  meetingApiListenerCleanups.push(attachHostTransferClient(api, props.roomName, {
    onComplete: async (key) => {
      if (jitsiApi.value !== api || status.value !== 'joined') throw new Error('会议连接已更换')
      const token = await fetchHostToken(props.roomName, key, displayName.value || '主持人', session?.endTime)
      if (!token || jitsiApi.value !== api || status.value !== 'joined'
        || getPendingHostTransfer(props.roomName)?.hostKey !== key
        || !getJoinedModeratorConference(api)) {
        throw new Error('主持人令牌暂不可用')
      }
      hostKey.value = key
      hostToken.value = token
      reclaimDialogOpen.value = false
      // Roles were committed on the current connection before acknowledgement.
      // Cache the new JWT for a future iframe init; do not hang up live media.
      reconcileMeetingPermissions()
    },
    onError: (message) => {
      if (transferErrorReported) return
      transferErrorReported = true
      console.warn('主持人转让待确认', message)
      showStageToast('主持人转让待确认，正在重试')
    },
  }))
  const on = (event: string, handler: (...args: unknown[]) => void) => {
    api.addListener(event, handler)
    meetingApiListenerCleanups.push(() => api.removeListener(event, handler))
  }

  on('participantMenuButtonClick', (payload: unknown) => {
    const clicked = payload as { key?: unknown; participantId?: unknown } | null
    if (clicked?.key === HOST_RECLAIM_MENU_ID && typeof clicked.participantId === 'string') {
      if (!canShowHostReclaim.value || reclaimBusy.value || transferBusy.value
          || getParticipantRole(api, clicked.participantId) !== 'moderator') {
        showStageToast('当前成员或收回权限已变化，请重新选择')
        return
      }
      reclaimTargetId.value = clicked.participantId
      reclaimDialogOpen.value = true
      return
    }
    if (clicked?.key !== HOST_TRANSFER_MENU_ID || typeof clicked.participantId !== 'string') return
    const id = clicked.participantId
    const role = getParticipantRole(api, id)
    if (!localModerator.value || !hostKey.value || !getJoinedModeratorConference(api)
        || (role !== 'participant' && role !== 'none') || transferBusy.value || reclaimBusy.value) {
      showStageToast('当前成员或主持人权限已变化，请稍后重试')
      return
    }
    const participant = api.getParticipantsInfo().find(item => (item.participantId ?? item.id) === id)
    transferTarget.value = { id, name: participant?.displayName?.trim() || '该成员' }
  })

  on('participantJoined', (participant: unknown) => {
    participantCount.value++
    const participantId = getParticipantId(participant)
    if (participantId) {
      videoMutedParticipantIds.delete(participantId)
      trackStableTileOrderJoin(participantId)
    }
    syncLocalMeetingBannerToParticipant(participant)
    scheduleMeetingBannerStateSync()
    refreshMeetingLayoutAfterParticipantChange()
    scheduleNativeChatStateSync()
    // 轮询布局下主持人可能因新成员入会/角色补齐而变化，幂等刷新无副作用。
    if (activeMeetingLayout.value === 'polling') void refreshPollingSlots()
  })
  on('participantLeft', (participant: unknown) => {
    participantCount.value = Math.max(0, participantCount.value - 1)
    const participantId = getParticipantId(participant)
    if (participantId) {
      videoMutedParticipantIds.delete(participantId)
      trackStableTileOrderLeave(participantId)
      removeParticipantMeetingBannerState(participantId)
      if (participantId === largeVideoParticipantId) {
        largeVideoParticipantId = ''
      }
      // 组员离会：从本次名单移除；正是右槽当前人则清空，由轮询节拍/刷新切下一位。
      if (pollingGroupIds.value.includes(participantId)) {
        pollingGroupIds.value = pollingGroupIds.value.filter((id) => id !== participantId)
      }
      if (participantId === pollingRightParticipantId.value) {
        pollingRightParticipantId.value = ''
      }
    }
    refreshMeetingLayoutAfterParticipantChange()
    scheduleNativeChatStateSync()
    // 主持人离会/冻结态下组员离会都要及时更新槽位。
    if (activeMeetingLayout.value === 'polling') void refreshPollingSlots()
  })
  on('participantMuted', (payload: unknown) => {
    const event = normalizeParticipantMute(payload)
    if (!event.participantId || event.mediaType !== 'video') return
    if (event.isMuted) {
      videoMutedParticipantIds.add(event.participantId)
    } else {
      videoMutedParticipantIds.delete(event.participantId)
    }
    // 视频开关不改变参会人数与宫格尺寸/页数，不触发布局刷新；
    // 否则会发起多轮 setTileView/resizeLargeVideo 重排造成闪屏。
    // 轮询布局的槽位占位要跟随摄像头开关状态。
    if (activeMeetingLayout.value === 'polling') void refreshPollingSlots()
  })
  on('participantRoleChanged', handleLocalRoleChanged)
  // 主持权转让后左槽要按真实角色换绑（handleLocalRoleChanged 只管本地权限）。
  on('participantRoleChanged', () => {
    if (activeMeetingLayout.value === 'polling') void refreshPollingSlots()
  })
  on('largeVideoChanged', (payload: unknown) => {
    const participantId = normalizeLargeVideoChange(payload)
    if (participantId) {
      largeVideoParticipantId = participantId
      if (tilePollingEnabled.value && activeMeetingLayout.value === 'default') {
        defaultLayoutPollingCurrentParticipantId = participantId
      }
    }
    scheduleMeetingBannerOverlaySync()
  })
  on('dominantSpeakerChanged', (payload: unknown) => {
    // 等分网格下发言人变化会让 jitsi 全量重排分屏顺序，恢复为固定入会顺序。
    scheduleStableTileOrderRestore()
    if (activeMeetingLayout.value !== 'default') return
    const participantId = normalizeLargeVideoChange(payload)
    if (participantId) {
      largeVideoParticipantId = participantId
    }
    scheduleMeetingBannerOverlaySync()
  })
  on('screenSharingStatusChanged', () => {
    // 屏幕共享产生虚拟参会人并强制重排分屏顺序，恢复时未跟踪的虚拟 ID 会保持其当前位置（置顶）。
    scheduleStableTileOrderRestore()
  })
  on('tileViewChanged', () => {
    scheduleMeetingBannerOverlaySync()
  })
  on('displayNameChange', scheduleNativeChatStateSync)
  on('chatUpdated', (event: unknown) => {
    if (event && typeof event === 'object') {
      const isOpen = (event as { isOpen?: boolean }).isOpen
      if (typeof isOpen === 'boolean') {
        nativeChatOpen.value = isOpen
      }
    }
    scheduleNativeChatStateSync()
  })
  on('endpointTextMessageReceived', handleMeetingBannerMessage)
}

async function confirmHostReclaim(): Promise<void> {
  const api = jitsiApi.value
  if (!api || status.value !== 'joined' || !reclaimDialogOpen.value || reclaimBusy.value
      || transferBusy.value || !canShowHostReclaim.value) return
  if (getParticipantRole(api, reclaimTargetId.value) !== 'moderator') {
    reclaimDialogOpen.value = false
    showStageToast('主持人已变化，请重新选择当前主持人')
    return
  }
  reclaimBusy.value = true
  try {
    await requestHostReclaim(api, props.roomName)
    if (jitsiApi.value !== api) return
    reclaimDialogOpen.value = false
    showStageToast('收回请求已处理，等待密钥领取与确认')
  } catch {
    if (jitsiApi.value === api) showStageToast('收回尚未确认，请稍后重试；不要将等待状态视为成功')
  } finally { reclaimBusy.value = false }
}

async function confirmHostTransfer(): Promise<void> {
  const target = transferTarget.value
  const api = jitsiApi.value
  const previousKey = hostKey.value
  if (!target || !api || !previousKey || transferBusy.value || reclaimBusy.value) return
  const targetRole = getParticipantRole(api, target.id)
  if (!localModerator.value || !getJoinedModeratorConference(api)
      || (targetRole !== 'participant' && targetRole !== 'none')) {
    transferTarget.value = null
    showStageToast('主持人或目标成员状态已变化，请重新选择')
    return
  }
  transferBusy.value = true
  const finishSourceHandoff = (message: string) => {
    let cacheCleared = true
    try { clearTransferredHostKey(props.roomName, previousKey) }
    catch { cacheCleared = false }
    hostKey.value = ''
    hostToken.value = null
    transferTarget.value = null
    showStageToast(cacheCleared ? message : '主持权限已转出，但本地密钥清理失败，请清除会议缓存后再加入')
    reconcileMeetingPermissions()
  }
  try {
    await requestHostTransfer(api, props.roomName, target.id)
    if (jitsiApi.value !== api || (hostKey.value && hostKey.value !== previousKey)) return
    finishSourceHandoff('主持权限已交给目标成员，等待对方确认')
  } catch (error) {
    // A lost IQ response can follow a committed role change. Only Jitsi's
    // live participant role can justify clearing the rotated old key.
    if (jitsiApi.value !== api || (hostKey.value && hostKey.value !== previousKey)) return
    const localRole = getParticipantRole(api, localParticipantId.value)
    const demoted = jitsiApi.value === api && (localRole === 'participant' || localRole === 'none')
    if (demoted) {
      finishSourceHandoff('主持权限已转出，目标确认状态待核实')
    } else {
      showStageToast(`转让尚未确认：${(error as Error).message}`)
    }
  } finally {
    transferBusy.value = false
  }
}

function cleanupMeetingApiListeners(): void {
  removeGridVideoClickHandlers?.()
  removeGridVideoClickHandlers = null
  clearMeetingBannerStateSync()
  meetingApiListenerCleanups.forEach((cleanup) => cleanup())
  meetingApiListenerCleanups = []
}

function openBannerPanel(): void {
  if (!localModerator.value || !getJoinedModeratorConference(jitsiApi.value)) return
  customToolbar.value?.closeFloatingMenus()
  bannerDraftVisible.value = meetingBanner.value.visible || (meetingBanner.value.text.trim().length === 0 && !meetingBanner.value.logoUrl)
  bannerDraftText.value = meetingBanner.value.text
  bannerDraftFontSize.value = meetingBanner.value.fontSize
  bannerDraftColor.value = meetingBanner.value.color
  bannerDraftFontFamily.value = meetingBanner.value.fontFamily
  bannerDraftBgColor.value = meetingBanner.value.bgColor
  bannerDraftLogoUrl.value = meetingBanner.value.logoUrl
  setBannerLogoFile(null)
  bannerLogoError.value = ''
  bannerPanelOpen.value = true
}

function closeBannerPanel(): void {
  bannerPanelOpen.value = false
}

function handleBannerTextInput(event: Event): void {
  bannerDraftText.value = (event.target as HTMLTextAreaElement).value
}

function setBannerDraftFontSize(value: unknown): void {
  bannerDraftFontSize.value = clampBannerFontSize(value)
}

function handleBannerFontSizeInput(event: Event): void {
  setBannerDraftFontSize((event.target as HTMLInputElement).value)
}

async function saveBannerPanel(): Promise<void> {
  const api = jitsiApi.value
  const conference = getJoinedModeratorConference(api)
  if (!localModerator.value || !conference) return
  if (bannerLogoSaving.value) return
  const text = bannerDraftText.value.trim()
  if (text.length > BANNER_TEXT_MAX_LENGTH && text !== meetingBanner.value.text) {
    bannerLogoError.value = '新会议主题不能超过 80 字；原有长主题可保留并修改展示设置'
    return
  }
  if (!text || !hostKey.value) {
    bannerLogoError.value = !text ? '会议主题不能为空' : '当前主持人缺少业务写入凭据，无法保存会议主题'
    return
  }
  let logoUrl = bannerDraftLogoUrl.value
  // 新选了本地图片时先上传会标（nginx DAV 落盘，auth_request 校验主持人身份）。
  if (bannerLogoFile.value) {
    if (!hostKey.value) {
      bannerLogoError.value = '当前身份不能上传会标，请从已上传选择或仅设置文字'
      return
    }
    bannerLogoSaving.value = true
    try {
      logoUrl = await uploadBannerLogo(props.roomName, hostKey.value, bannerLogoFile.value)
    } catch (error) {
      bannerLogoError.value = (error as Error).message
      bannerLogoSaving.value = false
      return
    }
    bannerLogoSaving.value = false
  }
  if (api !== jitsiApi.value || !localModerator.value || getJoinedModeratorConference(api) !== conference) return
  const nextState: MeetingBannerState = {
    visible: bannerDraftVisible.value && (text.length > 0 || logoUrl.length > 0),
    text,
    fontSize: clampBannerFontSize(bannerDraftFontSize.value),
    color: normalizeBannerColor(bannerDraftColor.value, BANNER_COLOR_DEFAULT),
    fontFamily: normalizeBannerFontFamily(bannerDraftFontFamily.value),
    bgColor: normalizeBannerBgColor(bannerDraftBgColor.value),
    logoUrl,
    position: 'top',
    updatedAt: Date.now(),
  }
  bannerLogoSaving.value = true
  try {
    const saved = await saveMeetingBanner(props.roomName, hostKey.value, nextState)
    const canonical = normalizeMeetingBannerState(saved)
    if (!canonical) throw new Error('服务端未返回保存后的主题，请刷新后确认')
    Object.assign(nextState, canonical)
  } catch (error) {
    bannerLogoError.value = `保存会议主题失败：${(error as Error).message}`
    return
  } finally {
    bannerLogoSaving.value = false
  }
  if (api !== jitsiApi.value || !localModerator.value || getJoinedModeratorConference(api) !== conference) return
  applyLocalMeetingBannerState(nextState)
  broadcastLocalMeetingBannerState(nextState)
  setBannerLogoFile(null)
  bannerLogoError.value = ''
  bannerPanelOpen.value = false
}

async function hideBanner(): Promise<void> {
  if (!localModerator.value || !getJoinedModeratorConference(jitsiApi.value)) return
  bannerDraftVisible.value = false
  await saveBannerPanel()
}

/** 会议时长格式化：1 小时内 mm:ss，超过 1 小时 h:mm:ss。 */
function formatElapsedText(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 把会议时长推给 Electron 壳（标题栏"会议详情 04:12"）；空串表示清空隐藏。仅桌面嵌入环境生效。 */
function postElapsedToShell(text: string): void {
  if (props.mode === 'desktop' && window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-meeting-elapsed', text }, '*')
  }
}

function startElapsedTicker(): void {
  stopElapsedTicker()
  if (props.mode !== 'desktop' || window.parent === window) return
  postElapsedToShell(formatElapsedText(Date.now() - meetingJoinedAt))
  elapsedTicker = window.setInterval(() => {
    postElapsedToShell(formatElapsedText(Date.now() - meetingJoinedAt))
  }, 1000)
}

function stopElapsedTicker(): void {
  if (elapsedTicker !== undefined) {
    window.clearInterval(elapsedTicker)
    elapsedTicker = undefined
  }
}

function showStageToast(message: string): void {
  toastText.value = message
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastText.value = ''), 2200)
}

function getRecordingErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function pickSupportedMimeType(candidates: string[]): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
}

function createRecordingMediaRecorder(stream: MediaStream, mimeType: string): MediaRecorder {
  return new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
}

function normalizeMeetingLayoutMode(mode: unknown): MeetingLayoutMode {
  const value = String(mode || '')
  if (value === 'auto' || value === 'default') return value
  if (value === 'polling') return 'polling'
  // Electron 客户端"布局"弹窗中的固定分屏选项（grid-2 ~ grid-49）。
  if ((FIXED_GRID_LAYOUT_MODES as readonly string[]).includes(value)) return value as FixedGridLayoutMode
  return 'default'
}

function getMeetingLayoutTileCount(mode: MeetingLayoutMode): number {
  if (mode === 'auto') return autoLayoutTileCount.value
  if (mode.startsWith('grid-')) return Number(mode.slice('grid-'.length)) || 0
  return 0
}

function applyMeetingLayout(mode: MeetingLayoutMode, options: { silent?: boolean } = {}): void {
  if (mode === 'polling' && !canUseHostMediaControls()) return
  const leavingPolling = activeMeetingLayout.value === 'polling' && mode !== 'polling'
  activeMeetingLayout.value = mode
  autoLayoutRefreshSequence++
  autoLayoutRefreshTimers.forEach((timer) => window.clearTimeout(timer))
  autoLayoutRefreshTimers = []
  if (mode === 'auto') autoLayoutTileCount.value = 9
  stopTilePolling({ disable: true })
  clearTileLayoutRefreshTimers()
  // 离开轮询布局：回收两个槽位的轨道引用与画面。
  if (leavingPolling || mode === 'polling') clearPollingSlots()
  // 切换布局后从第一页开始，避免沿用上一种网格的页码。
  strictGridPage.value = 0
  if (mode === 'polling') strictGridPageCount.value = 1
  if (mode !== 'default') {
    largeVideoParticipantId = ''
    removeMeetingBannerOverlay()
  } else {
    // 退出等分网格：恢复 jitsi 平铺/主画面布局的原生滚动，清掉翻页位移。
    removeStrictGridScrollLockStyle()
    clearStrictGridPageTransform()
  }
  syncFullscreenTileViewGutterStyle()
  syncDesktopFullscreenMainVideoStyle()
  const api = jitsiApi.value
  if (!api) return

  try {
    api.executeCommand('toggleParticipantsPane', false)
  } catch {
    /* 低版本 Jitsi 可能没有该命令，不影响布局切换 */
  }

  try {
    if (mode === 'default') {
      api.executeCommand('pinParticipant', null)
      api.executeCommand('setTileView', false)
      api.executeCommand('resizeLargeVideo', 0, 0)
      scheduleMeetingBannerOverlaySync()
      if (!options.silent) showStageToast('已切换为右侧成员列表')
      return
    }

    if (mode === 'polling') {
      api.executeCommand('setTileView', false)
      api.executeCommand('pinParticipant', null)
      // 槽位 overlay 随 activeMeetingLayout 切换后才挂载，等 DOM 就绪再绑轨道。
      void nextTick().then(() => refreshPollingSlots())
      if (tilePollingEnabled.value) restartTilePolling()
      notifyShellLayoutChanged('polling')
      scheduleMeetingBannerOverlaySync()
      if (!options.silent) showStageToast('已切换为轮询布局')
      return
    }

    const tileCount = getMeetingLayoutTileCount(mode)
    applyTileViewLayout(api, tileCount)
    forceJitsiLayoutReflow(api)
    scheduleActiveTileLayoutRefresh()
    scheduleMeetingBannerOverlaySync()
    if (mode === 'auto') scheduleAutoLayoutRefresh()
    if (!options.silent) {
      showStageToast(mode === 'auto' ? '已切换为宫格布局' : `已切换为 ${tileCount} 分屏`)
    }
  } catch (error) {
    console.error('切换会议布局失败', error)
    if (!options.silent) showStageToast('切换布局失败')
  }
}

function handleDesktopShellMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return
  const data = event.data as {
    type?: string
    mode?: unknown
    settings?: DesktopSettings
    message?: unknown
    to?: unknown
    sessionId?: unknown
  } | null
  if (data?.type === 'cloudmeet-recording-transcode-complete' || data?.type === 'cloudmeet-recording-transcode-failed') {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
    const message = recordingTranscodes.outcome(sessionId, data.type === 'cloudmeet-recording-transcode-complete' ? 'complete' : 'failed')
    if (message) showStageToast(message)
    return
  }
  if (data?.type === 'cloudmeet-window-resized') {
    scheduleJitsiWindowResizeRefresh()
    return
  }
  if (data?.type === 'cloudmeet-layout-change') {
    // Older Android APKs send `auto` on every iframe load. Mobile uses the
    // main-video layout regardless of the desktop grid setting.
    const mode = androidEmbed ? 'default' : normalizeMeetingLayoutMode(data.mode)
    if (mode !== activeMeetingLayout.value) applyMeetingLayout(mode)
    return
  }
  if (androidEmbed && data?.type === 'cloudmeet-toolbar-height') {
    const height = Number((data as { height?: unknown }).height)
    androidToolbarHeight.value = Number.isFinite(height) ? Math.max(0, height) : 0
    return
  }
  if (data?.type === 'cloudmeet-desktop-settings-changed') {
    applyDesktopSettings(data.settings)
    return
  }
  if (data?.type === 'cloudmeet-native-chat-send') {
    sendNativeChatMessageFromShell(data)
    return
  }
  if (data?.type === 'cloudmeet-native-chat-state-get') {
    void syncNativeChatState()
    return
  }
  handleDesktopRecordingMessage(event)
}

function handleDesktopRecordingMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return
  const data = event.data as DesktopRecordingResponse | null
  if (!data?.type || !data.requestId) return
  const pending = desktopRecordingRequests.get(data.requestId)
  if (!pending || pending.responseType !== data.type) return

  desktopRecordingRequests.delete(data.requestId)
  window.clearTimeout(pending.timer)
  if (data.error) {
    pending.reject(new Error(data.error))
    return
  }
  pending.resolve(data)
}

function rejectDesktopRecordingRequests(): void {
  for (const [requestId, pending] of desktopRecordingRequests.entries()) {
    desktopRecordingRequests.delete(requestId)
    window.clearTimeout(pending.timer)
    pending.reject(new Error('录制请求已取消'))
  }
}

function sendDesktopRecordingRequest<T extends DesktopRecordingResponse>(
  message: Record<string, unknown>,
  responseType: string,
  transfer?: Transferable[],
  timeout = 30000,
): Promise<T> {
  if (props.mode !== 'desktop' || window.parent === window) {
    return Promise.reject(new Error('本地录屏仅支持桌面客户端'))
  }

  const requestId = `recording-${Date.now()}-${++recordingBridgeSequence}`
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      desktopRecordingRequests.delete(requestId)
      reject(new Error('桌面端录制服务无响应'))
    }, timeout)
    desktopRecordingRequests.set(requestId, {
      responseType,
      resolve: resolve as (value: DesktopRecordingResponse) => void,
      reject,
      timer,
    })

    try {
      const payload = { ...message, requestId }
      if (transfer?.length) {
        window.parent.postMessage(payload, '*', transfer)
      } else {
        window.parent.postMessage(payload, '*')
      }
    } catch (error) {
      desktopRecordingRequests.delete(requestId)
      window.clearTimeout(timer)
      reject(error instanceof Error ? error : new Error('发送录制请求失败'))
    }
  }) as Promise<T>
}

async function getDesktopRecordingSettings(): Promise<DesktopSettings> {
  const response = await sendDesktopRecordingRequest<DesktopRecordingResponse>(
    { type: 'cloudmeet-recording-settings-get' },
    'cloudmeet-recording-settings',
  )
  return response.settings ?? {}
}

async function startDesktopRecordingSession(options: Record<string, unknown>): Promise<DesktopRecordingSession> {
  const response = await sendDesktopRecordingRequest<DesktopRecordingResponse>(
    { type: 'cloudmeet-recording-session-start', options },
    'cloudmeet-recording-session-started',
  )
  if (!response.session?.sessionId) throw new Error('创建录制会话失败')
  return response.session
}

async function writeDesktopRecordingChunk(sessionId: string, kind: RecordingChunkKind, blob: Blob): Promise<void> {
  if (!blob.size) return
  const data = await blob.arrayBuffer()
  const response = await sendDesktopRecordingRequest<DesktopRecordingResponse>(
    { type: 'cloudmeet-recording-session-chunk', sessionId, kind, data },
    'cloudmeet-recording-session-chunk-written',
    [data],
  )
  if (response.result?.ok === false) {
    throw new Error(response.result.error || '写入录制文件失败')
  }
}

async function finishDesktopRecordingSession(sessionId: string): Promise<DesktopRecordingResult> {
  const response = await sendDesktopRecordingRequest<DesktopRecordingResponse>(
    { type: 'cloudmeet-recording-session-finish', sessionId },
    'cloudmeet-recording-session-finished',
  )
  if (response.result?.ok === false) {
    throw new Error(response.result.error || '结束录制失败')
  }
  return response.result ?? {}
}

async function cancelDesktopRecordingSession(sessionId: string): Promise<void> {
  await sendDesktopRecordingRequest<DesktopRecordingResponse>(
    { type: 'cloudmeet-recording-session-cancel', sessionId },
    'cloudmeet-recording-session-canceled',
  )
}

function stopRecorder(recorder: MediaRecorder | null): Promise<void> {
  if (!recorder || recorder.state === 'inactive') return Promise.resolve()
  return new Promise((resolve) => {
    const settle = () => resolve()
    recorder.addEventListener('stop', settle, { once: true })
    recorder.addEventListener('error', settle, { once: true })
    try {
      recorder.stop()
    } catch {
      resolve()
    }
  })
}

function resetLocalRecordingState(): void {
  recordingGroup = null
  localRecording.value = false
  localRecordingBusy.value = false
}

async function startLocalRecording(): Promise<void> {
  if (!canUseHostMediaControls()) {
    showStageToast('仅主持人可以录屏')
    return
  }
  if (localRecordingBusy.value || localRecording.value) return
  if (props.mode !== 'desktop' || window.parent === window) {
    showStageToast('本地录屏仅支持桌面客户端')
    return
  }
  if (typeof MediaRecorder === 'undefined') {
    showStageToast('当前环境不支持本地录屏')
    return
  }

  localRecordingBusy.value = true
  localRecordingError.value = ''
  const generation = recordingPermissionGeneration
  const conference = getJoinedModeratorConference(jitsiApi.value)
  const assertRecordingPermission = () => {
    if (generation !== recordingPermissionGeneration || !canUseHostMediaControls()
      || getJoinedModeratorConference(jitsiApi.value) !== conference) {
      throw new Error('主持人权限已失效，录屏启动已取消')
    }
  }

  try {
    const settings = await getDesktopRecordingSettings()
    assertRecordingPermission()
    const modes: RecordingMode[] = Array.isArray(settings.recording?.modes)
      ? (['host-camera', 'shared-screen', 'composite'] as RecordingMode[]).filter(mode => settings.recording!.modes!.includes(mode))
      : [settings.recording?.mode === 'shared-screen' ? 'shared-screen' : 'host-camera']
    if (!modes.length) throw new Error('请至少选择一种录制模式')
    const videoMimeType = pickSupportedMimeType([
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
    ])
    const audioMimeType = pickSupportedMimeType(['audio/webm;codecs=opus', 'audio/webm'])

    // 定向录制：固定 Canvas + Web Audio 稳定输出（替代旧整屏捕获），
    // MediaRecorder 面对的输出流身份在源切换（角色转移/共享接替）全程不变。
    const adapter = createRecordingSourcesAdapter(jitsiApi.value)
    const readyKey = (mode: RecordingMode): string | null => {
      const selection = adapter.select(mode)
      if (!selection || getRecordingStartBlockReason(selection, mode)) return null
      return mode === 'host-camera' ? 'host-camera' : selection.share.identity || null
    }
    if (!modes.some(mode => readyKey(mode))) {
      throw new Error(getRecordingStartBlockReason(adapter.select(modes[0]!), modes[0]!) || '当前没有可启动的录制模式')
    }
    const group = createRecordingGroup({
      readyKey,
      subscribe: adapter.subscribe,
      onChanged: active => { localRecording.value = active },
      onError: error => {
        localRecordingError.value = getRecordingErrorMessage(error, '部分录制输出失败')
        showStageToast(localRecordingError.value)
      },
      create: async (mode, onEnded) => {
        const engine: DirectedRecordingEngine = createDirectedRecordingEngine({
          mode, onShareEnded: () => { void onEnded() },
          onError: error => { console.error('定向录制引擎错误', error) },
        })
        let sessionId = ''
        let videoRecorder: MediaRecorder | null = null
        let audioRecorder: MediaRecorder | null = null
        let unsubscribe: (() => void) | null = null
        let silent = false
        let writeError: unknown = null
        const writes = new Set<Promise<void>>()
        const cleanups: Array<() => void> = []
        const queue = (kind: RecordingChunkKind, blob: Blob) => {
          if (!blob.size || !sessionId) return
          const pending = writeDesktopRecordingChunk(sessionId, kind, blob).catch(error => {
            writeError = error
            void onEnded()
          })
          writes.add(pending)
          void pending.finally(() => writes.delete(pending))
        }
        return {
          async start() {
            assertRecordingPermission()
            await engine.start()
            assertRecordingPermission()
            const selection = adapter.select(mode)
            const reason = getRecordingStartBlockReason(selection, mode)
            if (reason) throw new Error(reason)
            await engine.applySource(selection!)
            assertRecordingPermission()
            const stream = engine.getOutputStream() as MediaStream | null
            if (!stream?.getVideoTracks().length) throw new Error('录制输出流创建失败')
            videoRecorder = createRecordingMediaRecorder(stream, videoMimeType)
            const audioTracks = stream.getAudioTracks()
            audioRecorder = settings.recording?.recordAudioFile && audioTracks.length
              ? createRecordingMediaRecorder(new MediaStream(audioTracks), audioMimeType) : null
            const session = await startDesktopRecordingSession({
              mode, roomName: props.roomName, subject: displaySubject.value,
              recordAudioFile: Boolean(audioRecorder), videoMimeType: videoRecorder.mimeType,
              audioMimeType: audioRecorder?.mimeType ?? '',
            })
            sessionId = session.sessionId
            assertRecordingPermission()
            videoRecorder.addEventListener('dataavailable', event => queue('video', event.data))
            audioRecorder?.addEventListener('dataavailable', event => queue('audio', event.data))
            for (const track of stream.getTracks()) {
              const ended = () => { void onEnded() }
              track.addEventListener('ended', ended)
              cleanups.push(() => track.removeEventListener('ended', ended))
            }
            unsubscribe = adapter.subscribe(() => {
              const next = adapter.select(mode)
              if (next) void engine.applySource(next).catch(error => {
                writeError = error
                void onEnded()
              })
            })
            videoRecorder.start(1000)
            audioRecorder?.start(1000)
            videoRecorder.addEventListener('error', event => {
              writeError = event
              void onEnded()
            })
            audioRecorder?.addEventListener('error', event => {
              writeError = event
              void onEnded()
            })
          },
          async finish(cancel) {
            silent = recordingStopSilent
            unsubscribe?.(); unsubscribe = null
            cleanups.splice(0).forEach(cleanup => cleanup())
            await Promise.all([stopRecorder(audioRecorder), stopRecorder(videoRecorder)])
            await Promise.all([...writes])
            if (!sessionId) return
            if (cancel) await cancelDesktopRecordingSession(sessionId)
            else {
              if (!silent) recordingTranscodes.start(sessionId)
              try {
                const result = await finishDesktopRecordingSession(sessionId)
                if (!silent) showStageToast(recordingTranscodes.finish(sessionId, result))
              } catch (error) {
                recordingTranscodes.cancel(sessionId)
                throw error
              }
            }
            if (writeError) throw writeError
          },
          async dispose() {
            unsubscribe?.()
            cleanups.splice(0).forEach(cleanup => cleanup())
            await engine.dispose()
          },
        }
      },
    })
    recordingGroup = group
    recordingStopSilent = false
    await group.start(modes)
    assertRecordingPermission()
    const running = group.runningCount
    showStageToast(`录屏已开始：${running} 种模式录制中${running < modes.length ? `，${modes.length - running} 种模式等待录制源就绪` : ''}`)
  } catch (error) {
    await recordingGroup?.stop(true)
    resetLocalRecordingState()
    localRecordingError.value = getRecordingErrorMessage(error, '录屏启动失败')
    showStageToast(localRecordingError.value)
  } finally {
    localRecordingBusy.value = false
  }
}

let recordingStopPromise: Promise<void> | null = null
let recordingStopSilent = false

function stopLocalRecording(options: { silent?: boolean; cancel?: boolean } = {}): Promise<void> {
  if (recordingStopPromise) return recordingStopPromise
  recordingStopPromise = finishLocalRecording(options).finally(() => { recordingStopPromise = null })
  return recordingStopPromise
}

async function finishLocalRecording(options: { silent?: boolean; cancel?: boolean } = {}): Promise<void> {
  if (!recordingGroup) return
  // Revocation, hangup and track-ended may request the same save concurrently.
  if (localRecordingBusy.value) {
    recordingPermissionGeneration += 1
    return
  }

  localRecording.value = false
  localRecordingBusy.value = true
  localRecordingError.value = ''
  recordingStopSilent = Boolean(options.silent)

  try {
    await recordingGroup.stop(Boolean(options.cancel))
  } catch (error) {
    localRecordingError.value = getRecordingErrorMessage(error, '结束录制失败')
    if (!options.silent) {
      showStageToast(getRecordingErrorMessage(error, '结束录制失败'))
    }
  } finally {
    resetLocalRecordingState()
  }
}

function toggleLocalRecording(): void {
  if (!canUseHostMediaControls()) {
    showStageToast('仅主持人可以录屏')
    return
  }
  if (localRecordingBusy.value) return
  if (localRecording.value) {
    void stopLocalRecording()
    return
  }
  void startLocalRecording()
}

// Same-page bridge used by the Electron sharing runtime; never invokes Jitsi's cloud recording.
const sharingRecordingControl = {
  getState: () => ({
    available: hostMediaControlsVisible.value && canUseHostMediaControls() && window.parent !== window && typeof MediaRecorder !== 'undefined',
    active: localRecording.value,
    busy: localRecordingBusy.value,
    error: localRecordingError.value,
  }),
  toggle: () => {
    if (!canUseHostMediaControls()) return { ok: false, error: '仅主持人可以录屏' }
    if (!sharingRecordingControl.getState().available) return { ok: false, error: '本地录屏仅支持桌面客户端' }
    if (localRecordingBusy.value) return { ok: false, error: '录制正在处理中，请稍候' }
    toggleLocalRecording()
    return { ok: true }
  },
}
const sharingRecordingWindow = window as Window & { __cloudmeetRecording?: typeof sharingRecordingControl }

function toggleTilePolling(): void {
  if (!canUseHostMediaControls()) {
    showStageToast('仅主持人可以使用轮询')
    return
  }
  customToolbar.value?.closeFloatingMenus()
  if (!tilePollingControlAvailable.value) {
    showStageToast(tilePollingSeconds.value <= 0 ? '请在设置中开启轮询时间' : '轮询不可用')
    return
  }
  // 每次点击都打开同一个设置对话框；开始/停止/保存由对话框确认后生效。
  pollingHostId.value = getMeetingModeratorId(jitsiApi.value)
  pollingDialogOpen.value = true
}

/** 对话框确认：更新名单；未运行时进入轮询布局并开启轮询，运行中仅保存设置。 */
function onPollingDialogConfirm(ids: string[]): void {
  if (!canUseHostMediaControls()) {
    pollingDialogOpen.value = false
    return
  }
  pollingGroupIds.value = [...ids]
  pollingGroupConfigured = true
  pollingDialogOpen.value = false
  if (!tilePollingEnabled.value) {
    if (activeMeetingLayout.value !== 'polling') applyMeetingLayout('polling')
    // 包括停止后原布局内重新开始：主动纠正标题栏保存/选中状态。
    notifyShellLayoutChanged('polling')
    tilePollingEnabled.value = true
    pollingCursor = 0
    restartTilePolling({ reset: true })
    showStageToast('已开启轮询')
    return
  }
  restartTilePolling()
  void refreshPollingSlots()
}

/** 停止轮询：保留名单、冻结右侧当前画面、停留在轮询布局（规则 3/6）。 */
function onPollingDialogStop(): void {
  pollingDialogOpen.value = false
  stopTilePolling({ disable: true })
  showStageToast('已停止轮询')
}

function onPollingDialogCancel(): void {
  pollingDialogOpen.value = false
}

function onJoined(info: { participantId: string; displayName?: string }): void {
  setStatus('joined')
  if (!meetingJoinedAt) meetingJoinedAt = Date.now()
  startElapsedTicker()
  localParticipantId.value = info.participantId ?? ''
  // 从 JitsiFrame 拿到 API 实例交给自定义工具栏；必须 markRaw，避免 Vue 深代理跨界对象抛 SecurityError。
  const api = jitsiFrame.value?.getApi()
  jitsiApi.value = api ? markRaw(api) : null
  reconcileMeetingPermissions()
  if (api) {
    setupMeetingApiListeners(api)
    if (!androidEmbed && localModerator.value) {
      applyParticipantMeetingBannerState(localParticipantId.value, meetingBanner.value)
    }
    applyMeetingLayout(activeMeetingLayout.value, { silent: true })
    try {
      participantCount.value = api.getParticipantsInfo()?.length ?? 0
    } catch {
      /* 低版本 Jitsi 无该方法时从 0 起步，事件会随后补齐 */
    }
  }
  scheduleNativeChatStateSync()
  if (!largeVideoParticipantId && localParticipantId.value && participantCount.value <= 1) {
    largeVideoParticipantId = localParticipantId.value
  }
  startMeetingBannerOverlaySync()
  broadcastLocalMeetingBannerState()
  scheduleMeetingBannerStateSync()
  void reportJoined(info)
}

/**
 * 同步服务端会议结束状态（endMeeting 接口）：
 * 仅由显式"全员结束会议"流程调用，业务成功后重复触发不再落库；
 * 普通离会及本地人数变化不证明房间结束，不能触发此接口。
 */
async function notifyMeetingEnded(): Promise<void> {
  if (endReported) return
  if (!hostKey.value) throw new Error('本机未保存主持人密钥，无法结束会议')
  await endMeeting(props.roomName, hostKey.value)
  endReported = true
}

function clearMeetingRuntimeState(): void {
  setLocalModerator(false)
  cleanupMeetingApiListeners()
  stopTilePolling({ disable: true })
  clearTileLayoutRefreshTimers()
  // 退出会议即清除轮询组名单与槽位画面。
  clearPollingSlots()
  pollingGroupIds.value = []
  pollingGroupConfigured = false
  pollingCursor = 0
  pollingRightParticipantId.value = ''
  pollingHostId.value = ''
  pollingDialogOpen.value = false
  autoLayoutRefreshSequence++
  autoLayoutRefreshTimers.forEach((timer) => window.clearTimeout(timer))
  autoLayoutRefreshTimers = []
  stopMeetingBannerOverlaySync()
  participantMeetingBanners.value = {}
  largeVideoParticipantId = ''
  strictGridMetrics = null
  strictGridPage.value = 0
  strictGridPageCount.value = 1
  removeStrictGridScrollLockStyle()
  clearStrictGridPageTransform()
  resetStableTileOrder()
  if (strictGridPageRestoreTimer !== undefined) {
    window.clearTimeout(strictGridPageRestoreTimer)
    strictGridPageRestoreTimer = undefined
  }
  videoMutedParticipantIds.clear()
  jitsiApi.value = null
  clearNativeChatState()
  bannerPanelOpen.value = false
  // 停掉时长推送并通知壳隐藏标题栏计时；meetingJoinedAt 保留给会后时长统计使用。
  stopElapsedTicker()
  postElapsedToShell('')
}

async function onKicked(): Promise<void> {
  clearMeetingRuntimeState()
  await stopLocalRecording({ silent: true })
  setStatus('kicked')
  emit('kicked')
}

/** 收到主持人全员结束信号：桌面端不展示结束页，直接交给 Electron 关闭会议窗口。 */
async function onConferenceEnded(): Promise<void> {
  clearCloseFallback()
  clearMeetingRuntimeState()
  await stopLocalRecording({ silent: true })
  if (props.mode === 'desktop') {
    // 先把通知写入与桌面首页共享的 localStorage，再关闭会议窗口，确保首页能显示会后提示。
    publishMeetingEndedNotice(props.roomName, meetingJoinedAt ? (Date.now() - meetingJoinedAt) / 1000 : 0)
    // 远端已明确收到“全员结束”信号：此时不再等待任何 Jitsi 结束面板，直接关窗。
    closeWindow()
    return
  }
  setStatus('left')
}

async function onConnectionLost(): Promise<void> {
  // Keep signal loss distinct from normal leave; neither proves room termination.
  clearMeetingRuntimeState()
  errorMsg.value = '连接已断开，你已退出本地会议；这不代表会议已结束。请检查网络后手动重新加入。'
  setStatus('left')
  await stopLocalRecording({ silent: true })
}

async function onLeft(): Promise<void> {
  clearMeetingRuntimeState()
  await stopLocalRecording({ silent: true })
  // 缓存人数及本机密钥不能证明自己是最后一人；离会只收尾本端，不写业务 ENDED。
  if (props.mode === 'desktop') {
    // 桌面会议页只负责关闭本地窗口；会议是否结束由主持人明确的结束接口决定。
    closeWindow()
    return
  }
  // 保留会话信息，便于用户回到首页后继续复制或查看当前会议上下文。
  setStatus('left')
}

function onError(msg: string): void {
  clearNativeChatState()
  errorMsg.value = msg
  if (props.mode === 'web') {
    setStatus('left')
  }
}

const toastText = ref('')

const ANDROID_FULLSCREEN_LAYOUT_STYLE_ID = 'cloudmeet-android-fullscreen-layout'

/** The Android preview strip is rendered above the iframe; keep Jitsi's own
 * filmstrip out of the picture while retaining its video subscriptions. */
function syncAndroidFullscreenLayout(): void {
  if (!androidEmbed) return
  const doc = getJitsiFrameDocument()
  if (!doc?.head) return

  let style = doc.getElementById(ANDROID_FULLSCREEN_LAYOUT_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = ANDROID_FULLSCREEN_LAYOUT_STYLE_ID
    doc.head.appendChild(style)
  }

  style.textContent = `
#filmstrip, #filmstripRemoteVideosContainer, .filmstrip {
  opacity: 0 !important;
  pointer-events: none !important;
}
`
}

function refreshAndroidFullscreenLayout(): void {
  if (!androidEmbed) return
  syncAndroidFullscreenLayout()
  const api = jitsiApi.value
  if (!api) return
  forceJitsiLayoutReflow(api)
  window.setTimeout(() => forceJitsiLayoutReflow(api), 120)
}

function setFullscreenState(value: boolean): void {
  fullscreen.value = value
  if (!fullscreen.value) {
    fullscreenToolbarVisible.value = false
  }
  syncFullscreenTileViewGutterStyle()
  syncDesktopFullscreenMainVideoStyle()
  refreshAndroidFullscreenLayout()
  scheduleJitsiWindowResizeRefresh(true)
  scheduleMeetingBannerOverlaySync()
}

function setFullscreenControlsVisible(value: boolean, titlebarHeight?: number): void {
  fullscreenToolbarVisible.value = Boolean(value)
  fullscreenTitlebarHeight = typeof titlebarHeight === 'number' && Number.isFinite(titlebarHeight) && titlebarHeight >= 0
    ? titlebarHeight
    : 40
  scheduleMeetingBannerOverlaySync()
}

function requestExitFullscreen(): void {
  if (!fullscreen.value) return
  if (props.mode === 'desktop' && window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-set-fullscreen', fullscreen: false }, '*')
    return
  }

  if (document.fullscreenElement) {
    void document.exitFullscreen()
  }
}

/** Desktop invitation previews the same text that the user explicitly copies. */
const desktopInviteOpen = ref(false)

function inviteFromToolbar(): void {
  if (!localModerator.value) return
  if (props.mode === 'web') {
    emit('invite')
    return
  }
  desktopInviteOpen.value = true
}

function reloadPage(): void {
  window.location.reload()
}

function goHome(): void {
  emit('go-home')
}

/** 桌面会议页的结束/被移出/错误面板没有"返回首页"语义，直接关闭本窗口。 */
function closeWindow(): void {
  emit('close-window')
}

/** 关闭标题栏关闭按钮触发的小菜单；不影响底部工具栏自己的结束菜单。 */
function closeShellCloseMenu(): void {
  shellCloseMenuOpen.value = false
}

function clearCloseFallback(): void {
  if (closeFallbackTimer !== undefined) {
    window.clearTimeout(closeFallbackTimer)
    closeFallbackTimer = undefined
  }
}

/** 离开会议：Web 端挂断/桌面端工具栏结束时触发，Jitsi 离会事件交由 onLeft 收尾。 */
function requestLeave(): void {
  requestExitFullscreen()
  jitsiFrame.value?.requestLeave()
}

/**
 * 工具栏"结束会议"面板点击（离开会议/全员结束会议）：
 * Web 端只挂断留在结束面板；桌面端走关闭窗口协议。
 */
async function onHangupFromToolbar(): Promise<void> {
  await stopLocalRecording({ silent: true })
  if (props.mode === 'web') {
    requestLeave()
    return
  }
  closeShellCloseMenu()
  void requestLeaveAndClose()
}

let endingForAll = false
/** Business state first; command dispatch has no server acknowledgement in External API. */
async function onEndForAll(): Promise<void> {
  if (endingForAll || !localModerator.value || !jitsiApi.value || !hostKey.value) return
  const api = jitsiApi.value
  const conference = getJoinedModeratorConference(api)
  if (!conference) {
    showStageToast('当前房间连接或主持人角色尚未确认，请恢复连接后重试；尚未发送结束请求')
    return
  }
  endingForAll = true
  closeShellCloseMenu()
  try {
    await notifyMeetingEnded()
    if (api !== jitsiApi.value || !localModerator.value || getJoinedModeratorConference(api) !== conference) {
      throw new Error('房间连接或主持人角色已变化')
    }
    api.executeCommand('endConference')
    showStageToast('会议记录已结束，已发送房间结束请求；尚未确认全员退出，请核对房间状态')
  } catch (error) {
    showStageToast(`${endReported ? '会议记录已结束，但房间结束未确认' : '结束失败，尚未发送房间结束请求'}：${(error as Error).message}`)
  } finally {
    endingForAll = false
  }
}

/**
 * 底部结束菜单选择“离开会议”后，先让 Jitsi 主动退出会议，
 * 再由 onLeft 走 closeWindow，避免直接销毁 iframe 造成会议内用户残留。
 */
async function requestLeaveAndClose(): Promise<void> {
  closeShellCloseMenu()
  if (needsJoin.value || errorMsg.value || status.value === 'kicked') {
    closeWindow()
    return
  }
  await stopLocalRecording({ silent: true })
  requestLeave()
  clearCloseFallback()
  closeFallbackTimer = window.setTimeout(closeWindow, 1800)
}

/** 把桌面壳传入的关闭按钮位置限制在 iframe 可视区域内，避免菜单贴边或跑出屏幕。 */
function applyShellCloseMenuAnchor(anchor?: ShellCloseMenuAnchor): void {
  const top = Number(anchor?.top)
  const right = Number(anchor?.right)
  shellCloseMenuTop.value = Number.isFinite(top) ? Math.max(8, Math.min(top, window.innerHeight - 170)) : 12
  shellCloseMenuRight.value = Number.isFinite(right) ? Math.max(8, Math.min(right, window.innerWidth - 220)) : 12
}

/**
 * Electron 标题栏关闭按钮在按钮附近弹出同款结束选项，具体动作仍复用底部工具栏方法。
 * 返回 true 表示请求已被会议页接管，桌面壳可取消自己的兜底强关。
 */
function requestCloseFromShell(anchor?: ShellCloseMenuAnchor): boolean {
  if (status.value === 'joined' && customToolbar.value) {
    customToolbar.value.closeFloatingMenus()
    applyShellCloseMenuAnchor(anchor)
    shellCloseMenuCanEndForAll.value = Boolean(hostKey.value && getJoinedModeratorConference(jitsiApi.value))
    shellCloseMenuOpen.value = true
    return true
  }
  void requestLeaveAndClose()
  return true
}

/** 标题栏菜单的“离开会议”与底部工具栏保持同一动作，避免窗口关闭入口出现不同离会语义。 */
function leaveFromShellCloseMenu(): void {
  customToolbar.value?.leaveMeeting()
}

/** 标题栏菜单的“全员结束会议”直接复用工具栏结束全员逻辑，包含远端通知和服务端结束同步。 */
function endForAllFromShellCloseMenu(): void {
  if (!hostKey.value || !getJoinedModeratorConference(jitsiApi.value)) return
  customToolbar.value?.endMeetingForAll()
}

defineExpose({ requestLeave, requestCloseFromShell, setFullscreenState, setFullscreenControlsVisible })

onMounted(() => {
  if (props.mode === 'desktop') sharingRecordingWindow.__cloudmeetRecording = sharingRecordingControl
  // Data-channel notifications are an acceleration, not the only recovery path.
  meetingSubjectRefreshTimer = window.setInterval(() => { void refreshMeetingSubject() }, 10_000)
  startMeetingStageResizeObserver()
  window.addEventListener('message', handleDesktopShellMessage)
  if (props.mode === 'desktop' && window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-request-fullscreen-state' }, '*')
    requestDesktopSettings()
  }
})

onBeforeUnmount(() => {
  if (sharingRecordingWindow.__cloudmeetRecording === sharingRecordingControl) delete sharingRecordingWindow.__cloudmeetRecording
  if (meetingSubjectRefreshTimer !== undefined) window.clearInterval(meetingSubjectRefreshTimer)
  window.removeEventListener('message', handleDesktopShellMessage)
  recordingTranscodes.clear()
  stopMeetingStageResizeObserver()
  clearJitsiWindowResizeRefreshTimers()
  void stopLocalRecording({ silent: true })
  rejectDesktopRecordingRequests()
  stopThemeChange()
  clearMeetingRuntimeState()
  closeShellCloseMenu()
  clearCloseFallback()
  setBannerLogoFile(null)
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})
</script>

<template>
  <main
    ref="meetingStageRoot"
    class="meeting-stage"
    :class="{
      'meeting-stage--fullscreen': fullscreen,
      'meeting-stage--toolbar-visible': fullscreen && fullscreenToolbarVisible,
      'meeting-stage--android': androidEmbed,
      'meeting-light': androidEmbed || meetingTheme === 'light',
    }"
  >
    <DesktopInviteDialog
      v-if="desktopInviteOpen && localModerator"
      :room-name="props.roomName"
      :subject="displaySubject"
      :password="password"
      @close="desktopInviteOpen = false"
    />
    <!-- 加入门：无本会话（直接打开分享链接的参会人）时，先收集昵称/可选密码；
         有密码时交给 JitsiFrame 自动解锁，无密码时直接进入公开会议。 -->
    <div v-if="needsJoin && !errorMsg" class="gate-panel">
      <div class="gate-card">
        <div class="gate-card__hud">
          <span>JOIN&nbsp;MEETING&nbsp;//&nbsp;SECURED</span>
          <span class="gate-card__hud-right">PASSWORD&nbsp;OPTIONAL</span>
        </div>
        <h2 class="gate-card__title">加入会议</h2>
        <p class="gate-card__desc">如果邀请信息包含密码，请填写后进入；无密码会议可直接加入</p>
        <div class="gate-card__room">
          <div class="gate-card__room-label">会议号</div>
          <div class="gate-card__room-value">{{ formatMeetingId(roomName) }}</div>
        </div>
        <!-- 只有 prejoin 关闭时系统才需要收集昵称；启用 prejoin 时由 Jitsi 自己的"用户名 + 加入"页收集 -->
        <div v-if="!PREJOIN_ENABLED" class="field gate-card__field">
          <label for="gate-name">你的昵称<span class="req">*</span></label>
          <input id="gate-name" v-model="gateName" type="text" maxlength="20" placeholder="你的姓名 / 昵称" @keyup.enter="submitJoin" />
        </div>
        <div class="field gate-card__field">
          <label for="gate-pwd">密码（可选）</label>
          <div class="pwd-row">
            <input
              id="gate-pwd"
              v-model="joinPassword"
              :type="joinVisible ? 'text' : 'password'"
              maxlength="16"
              placeholder="有密码时填写"
              @keyup.enter="submitJoin"
            />
            <button class="btn btn-ghost pwd-eye" type="button" @click="joinVisible = !joinVisible" :title="joinVisible ? '隐藏密码' : '显示密码'">
              {{ joinVisible ? '🙈' : '👁' }}
            </button>
          </div>
        </div>
        <div class="gate-card__actions">
          <button class="btn btn-primary gate-card__join" :disabled="joinChecking || (!PREJOIN_ENABLED && !gateName.trim())" @click="submitJoin">
            {{ joinChecking ? '校验中…' : '加入会议' }}
          </button>
          <button v-if="mode === 'web'" class="btn btn-ghost" @click="goHome">返回首页</button>
        </div>
        <div v-if="mode !== 'web' || canHostJoin" class="gate-card__host">
          <button class="gate-card__host-toggle" type="button" @click="showHostJoin = !showHostJoin">
            {{ showHostJoin ? '▾' : '▸' }} 以主持人身份加入？
          </button>
          <div v-if="showHostJoin" class="field gate-card__field">
            <label for="gate-hostkey">主持人密钥</label>
            <input
              id="gate-hostkey"
              :value="gateHostKey"
              type="text"
              maxlength="19"
              autocomplete="off"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              @input="onGateHostKeyInput"
              @keyup.enter="submitJoin"
            />
            <p class="hint">凭预创建时生成的主持人密钥，以主持人身份进入（换 JWT，与进场顺序无关）</p>
          </div>
        </div>
      </div>
    </div>
    <div
      v-if="showMeetingSubjectBanner"
      class="meeting-subject-banner"
      role="status"
      aria-label="会议主题"
      :style="{ top: `${mode === 'desktop' && fullscreen && fullscreenToolbarVisible ? fullscreenTitlebarHeight + 12 : 12}px`, color: meetingBanner.color, backgroundColor: meetingBanner.bgColor || 'transparent', fontSize: `${meetingBanner.fontSize}px`, fontFamily: meetingBanner.fontFamily || 'inherit' }"
    >
      <img v-if="meetingBanner.logoUrl" :src="meetingBanner.logoUrl" alt="会议会标" />
      <span>{{ meetingBanner.text }}</span>
    </div>
    <JitsiFrame
      v-if="!needsJoin && !errorMsg && status !== 'left' && status !== 'kicked' && tokenReady && joinCheckReady && !expired"
      ref="jitsiFrame"
      class="meeting-stage__jitsi"
      :room-name="roomName"
      :subject="displaySubject"
      :display-name="displayName"
      :password="password"
      :jwt="hostToken ?? undefined"
      :theme="meetingTheme"
      :preserve-on-room-switch="preserveJitsiRoomSwitch"
      @joined="onJoined"
      @left="onLeft"
      @connection-lost="onConnectionLost"
      @conference-ended="onConferenceEnded"
      @kicked="onKicked"
      @error="onError"
      @reload-error="showStageToast"
    />
    <!-- 服务端签发令牌（成功或失败）期间显示加载态 -->
    <div v-else-if="!errorMsg && status !== 'left' && status !== 'kicked' && !expired" class="gate-panel">
      <div class="gate-card gate-card--waiting">
        <div class="spinner-wait"></div>
        <p>{{ waitingText }}</p>
      </div>
    </div>
    <div v-else-if="!errorMsg && status === 'kicked'" class="kicked-panel">
      <div class="kicked-panel__icon">
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </div>
      <h2 class="kicked-panel__title">你已被移出会议</h2>
      <p class="kicked-panel__desc">
        {{ mode === 'web' ? '主持人已移除你的参会权限，即将返回首页…' : '主持人已移除你的参会权限' }}
      </p>
      <div class="kicked-panel__actions">
        <button v-if="mode === 'web'" class="btn btn-primary" @click="goHome">立即返回首页</button>
        <button v-else class="btn btn-primary" @click="closeWindow">关闭窗口</button>
      </div>
    </div>
    <div v-else-if="!errorMsg && mode === 'web' && expired" class="ended-panel">
      <div class="ended-panel__icon">
        <svg
          width="46"
          height="46"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 8v4l2.5 2.5" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <h2 class="ended-panel__title">会议已结束</h2>
      <p class="ended-panel__desc">该会议已于 {{ endTimeText }} 结束，不再允许进入</p>
      <div class="ended-panel__actions">
        <button class="btn btn-primary" @click="goHome">回到首页</button>
      </div>
    </div>
    <div v-else-if="!errorMsg && mode === 'web' && status === 'left'" class="ended-panel">
      <div class="ended-panel__icon">
        <svg
          width="46"
          height="46"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4.5 12.5c5.5-4.5 9.5-4.5 15 0" />
          <path d="M2.5 9.5c7-5.5 12-5.5 19 0" />
          <path d="M6.5 15.5c3.7-3 5.3-3 9 0" />
          <path d="M12 18.5v.01" />
        </svg>
      </div>
      <h2 class="ended-panel__title">会议已结束</h2>
      <p class="ended-panel__desc">你已退出会议 {{ formatMeetingId(roomName) }}</p>
      <div class="ended-panel__actions">
        <button class="btn btn-primary" @click="goHome">回到首页</button>
      </div>
    </div>
    <div v-else class="error-panel">
      <div class="error-panel__code">⚠</div>
      <p>{{ errorMsg }}</p>
      <div class="error-panel__actions">
        <button class="btn btn-ghost" @click="reloadPage">重新加载</button>
        <button v-if="mode === 'desktop'" class="btn btn-primary" @click="closeWindow">关闭窗口</button>
      </div>
    </div>
    <!-- 轮询布局：左槽固定主持人、右槽轮播勾选组员；覆盖在 iframe 上、工具栏之下，无页码/网格。 -->
    <div v-if="status === 'joined' && activeMeetingLayout === 'polling'" ref="pollingLayoutRoot" class="meeting-stage__polling" :style="pollingCardStyle">
      <div ref="pollingLeftSlot" class="polling-slot" @dblclick="openParticipantMainView(pollingHostId)">
        <div v-if="!pollingHostId" class="polling-slot__placeholder">等待主持人</div>
        <PollingParticipantInfo :api="jitsiApi" :participant-id="pollingHostId" :has-video="pollingLeftHasVideo" />
      </div>
      <div ref="pollingRightSlot" class="polling-slot" @dblclick="openParticipantMainView(pollingRightParticipantId)">
        <div v-if="!pollingRightParticipantId" class="polling-slot__placeholder">{{ pollingRightPlaceholder }}</div>
        <PollingParticipantInfo :api="jitsiApi" :participant-id="pollingRightParticipantId" :has-video="pollingRightHasVideo" />
      </div>
    </div>
    <AndroidVideoStrip
      v-if="androidEmbed && status === 'joined' && jitsiApi"
      :api="jitsiApi"
      :local-participant-id="localParticipantId"
      :top-inset="androidToolbarHeight"
      @main-changed="onAndroidMainParticipantChanged"
    />
    <!-- toolbar 槽位放在条件链之后作为无条件兄弟节点：初始化即占住高度，入会后不遮挡内容 -->
    <span v-if="status === 'joined' && jitsiApi" class="meeting-role" role="status" aria-live="polite">{{ meetingRoleLabel }}</span>
    <div class="meeting-stage__toolbar-slot">
      <CustomToolbar
        v-if="status === 'joined' && jitsiApi"
        ref="customToolbar"
        :api="jitsiApi"
        :initial-moderator="localModerator"
        :local-participant-id="localParticipantId"
        :banner-visible="bannerVisible"
        :recording-available="hostMediaControlsVisible"
        :recording="localRecording"
        :recording-busy="localRecordingBusy"
        :tile-polling-visible="hostMediaControlsVisible"
        :tile-polling-available="tilePollingControlAvailable"
        :tile-polling-enabled="tilePollingEnabled"
        @invite="inviteFromToolbar"
        @hangup="onHangupFromToolbar"
        @end-for-all="onEndForAll"
        @banner-settings="openBannerPanel"
        @recording-toggle="toggleLocalRecording"
        @tile-polling-toggle="toggleTilePolling"
      />
    </div>
    <div v-if="reclaimDialogOpen" class="transfer-dialog-layer" @click.self="!reclaimBusy && (reclaimDialogOpen = false)">
      <section class="transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="reclaim-dialog-title">
        <h3 id="reclaim-dialog-title">收回主持人</h3>
        <p>确定使用本机创建者凭据收回主持权限吗？当前主持人将失去权限，未完成的转让也会被替换。密钥领取并确认前，会议管理操作保持锁定。</p>
        <div class="transfer-dialog__actions">
          <button class="btn btn-ghost" type="button" :disabled="reclaimBusy" @click="reclaimDialogOpen = false">取消</button>
          <button class="btn btn-primary" type="button" :disabled="reclaimBusy || transferBusy" @click="confirmHostReclaim">
            {{ reclaimBusy ? '收回处理中…' : '确认收回／重试' }}
          </button>
        </div>
      </section>
    </div>
    <div v-if="transferTarget" class="transfer-dialog-layer" @click.self="!transferBusy && (transferTarget = null)">
      <section class="transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-dialog-title">
        <h3 id="transfer-dialog-title">转让主持人</h3>
        <p>确定将主持权限交给“{{ transferTarget.name }}”吗？转让后你将成为普通参会者，创建者仍可按凭据收回。</p>
        <div class="transfer-dialog__actions">
          <button class="btn btn-ghost" type="button" :disabled="transferBusy" @click="transferTarget = null">取消</button>
          <button class="btn btn-primary" type="button" :disabled="transferBusy" @click="confirmHostTransfer">
            {{ transferBusy ? '转让中…' : '确认转让' }}
          </button>
        </div>
      </section>
    </div>
    <PollingGroupDialog
      v-if="pollingDialogOpen"
      :api="jitsiApi"
      :running="tilePollingEnabled"
      :moderator-id="pollingHostId"
      :initial-selected-ids="pollingGroupIds"
      :group-configured="pollingGroupConfigured"
      :variant="mode === 'desktop' ? 'desktop' : 'web'"
      @confirm="onPollingDialogConfirm"
      @stop="onPollingDialogStop"
      @cancel="onPollingDialogCancel"
    />
    <div
      v-if="bannerPanelOpen"
      class="banner-editor-layer"
      @click.self="closeBannerPanel"
    >
      <section class="banner-editor" role="dialog" aria-modal="true" aria-labelledby="banner-editor-title" @click.stop>
        <header class="banner-editor__head">
          <h3 id="banner-editor-title">会议主题（电子屏）</h3>
          <button class="banner-editor__close" type="button" title="关闭" @click="closeBannerPanel">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div class="banner-editor__body">
          <label class="banner-editor__toggle">
            <input v-model="bannerDraftVisible" type="checkbox" />
            <span>显示电子屏</span>
          </label>
          <div class="banner-editor__field">
            <label for="meeting-banner-text">会议主题</label>
            <textarea
              id="meeting-banner-text"
              :value="bannerDraftText"
              rows="3"
              placeholder="请输入会议主题，保存后全员同步"
              @input="handleBannerTextInput"
            ></textarea>
            <span class="banner-editor__count">{{ bannerDraftText.length }}/80</span>
          </div>
          <div class="banner-editor__field">
            <label>会标图片</label>
            <div class="banner-editor__logo-row">
              <img v-if="bannerLogoPreview" class="banner-editor__logo-preview" :src="bannerLogoPreview" alt="会标预览" />
              <span v-else class="banner-editor__logo-empty">未设置会标</span>
              <div class="banner-editor__logo-actions">
                <label class="btn btn-ghost banner-editor__logo-upload">
                  上传图片
                  <input type="file" :accept="BANNER_LOGO_ACCEPT" hidden @change="handleBannerLogoInput" />
                </label>
                <button v-if="bannerLogoPreview" class="btn btn-ghost" type="button" @click="removeBannerLogo">移除</button>
                <button class="btn btn-ghost" type="button" @click="toggleBannerLogoLibrary">
                  {{ bannerLogoLibraryOpen ? '收起会标库' : '从已上传选择' }}
                </button>
              </div>
            </div>
            <div v-if="bannerLogoLibraryOpen" class="banner-editor__logo-library">
              <p v-if="bannerLogoLibraryLoading" class="banner-editor__logo-library-tip">正在读取会标库…</p>
              <p v-else-if="!bannerLogoLibraryList.length" class="banner-editor__logo-library-tip">还没有已上传的会标，先上传一张吧</p>
              <div v-else class="banner-editor__logo-grid">
                <div
                  v-for="item in bannerLogoLibraryList"
                  :key="item.url"
                  class="banner-editor__logo-item"
                  :class="{ 'banner-editor__logo-item--active': !bannerLogoFile && bannerDraftLogoUrl === item.url }"
                  :title="item.name"
                  @click="pickBannerLogoFromLibrary(item.url)"
                >
                  <img :src="item.url" :alt="item.name" loading="lazy" />
                  <button
                    class="banner-editor__logo-item-del"
                    type="button"
                    title="从会标库删除"
                    @click.stop="deleteBannerLogoFromLibrary(item)"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
            <span v-if="bannerLogoError" class="banner-editor__logo-error">{{ bannerLogoError }}</span>
            <span class="hint">PNG / JPG / SVG / WebP，不超过 2MB；与文字并排显示在电子屏左侧</span>
          </div>
          <div class="banner-editor__field">
            <label for="meeting-banner-font-size">字号大小</label>
            <div class="banner-editor__size-row">
              <input
                id="meeting-banner-font-size"
                class="banner-editor__range"
                type="range"
                :min="BANNER_FONT_SIZE_MIN"
                :max="BANNER_FONT_SIZE_MAX"
                :value="bannerDraftFontSize"
                @input="handleBannerFontSizeInput"
              />
              <input
                class="banner-editor__number"
                type="number"
                :min="BANNER_FONT_SIZE_MIN"
                :max="BANNER_FONT_SIZE_MAX"
                :value="bannerDraftFontSize"
                @input="handleBannerFontSizeInput"
              />
            </div>
          </div>
          <div class="banner-editor__field">
            <label for="meeting-banner-font-family">字体</label>
            <select id="meeting-banner-font-family" v-model="bannerDraftFontFamily" class="banner-editor__select">
              <option v-for="option in BANNER_FONT_OPTIONS" :key="option.label" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </div>
          <div class="banner-editor__field">
            <label>文字颜色</label>
            <div class="banner-editor__swatches">
              <button
                v-for="preset in BANNER_COLOR_PRESETS"
                :key="preset"
                type="button"
                class="banner-editor__swatch"
                :class="{ 'banner-editor__swatch--active': bannerDraftColor === preset }"
                :style="{ background: preset }"
                :title="preset"
                @click="bannerDraftColor = preset"
              ></button>
              <input
                v-model="bannerDraftColor"
                type="color"
                class="banner-editor__color-input"
                title="自定义颜色"
              />
            </div>
          </div>
          <div class="banner-editor__field">
            <label>背景色</label>
            <div class="banner-editor__swatches">
              <button
                type="button"
                class="banner-editor__swatch banner-editor__swatch--none"
                :class="{ 'banner-editor__swatch--active': bannerDraftBgColor === '' }"
                title="无色（透明）"
                @click="bannerDraftBgColor = ''"
              >无</button>
              <button
                v-for="preset in BANNER_BG_PRESETS"
                :key="preset"
                type="button"
                class="banner-editor__swatch"
                :class="{ 'banner-editor__swatch--active': bannerDraftBgColor === preset }"
                :style="{ background: preset }"
                :title="preset"
                @click="bannerDraftBgColor = preset"
              ></button>
              <input
                type="color"
                class="banner-editor__color-input"
                title="自定义背景色"
                :value="bannerDraftBgColor || '#070C14'"
                @input="bannerDraftBgColor = ($event.target as HTMLInputElement).value.toUpperCase()"
              />
            </div>
          </div>
          <div
            class="banner-editor__preview"
            :style="{
              fontSize: `${bannerDraftFontSize}px`,
              color: bannerDraftColor,
              fontFamily: bannerDraftFontFamily || undefined,
              background: bannerDraftBgColor || 'transparent',
            }"
          >
            <img v-if="bannerLogoPreview" class="banner-editor__preview-logo" :src="bannerLogoPreview" alt="" />
            <span>{{ bannerDraftText.trim() || '电子屏预览' }}</span>
          </div>
        </div>
        <footer class="banner-editor__foot">
          <button class="btn btn-ghost" type="button" @click="hideBanner">关闭电子屏</button>
          <button class="btn btn-ghost" type="button" @click="closeBannerPanel">取消</button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="(bannerDraftVisible && !bannerDraftText.trim() && !bannerLogoPreview) || bannerLogoSaving"
            @click="saveBannerPanel"
          >
            {{ bannerLogoSaving ? '上传会标中…' : '保存' }}
          </button>
        </footer>
      </section>
    </div>
    <div
      v-if="shellCloseMenuOpen"
      class="shell-close-menu-layer"
      @click.self="closeShellCloseMenu"
    >
      <div
        class="shell-close-menu"
        :style="androidEmbed ? {} : { top: `${shellCloseMenuTop}px`, right: `${shellCloseMenuRight}px` }"
        @click.stop
      >
        <button
          v-if="shellCloseMenuCanEndForAll"
          class="shell-close-menu__item shell-close-menu__item--primary"
          type="button"
          @click="endForAllFromShellCloseMenu"
        >
          全员结束会议
        </button>
        <button class="shell-close-menu__item" type="button" @click="leaveFromShellCloseMenu">离开会议</button>
        <button v-if="androidEmbed" class="shell-close-menu__item shell-close-menu__item--cancel" type="button" @click="closeShellCloseMenu">取消</button>
      </div>
    </div>
    <!-- 等分网格分页器：严格网格成员超出一页时悬浮在会议区底部，支持手动翻页（首尾循环）。 -->
    <div v-if="strictGridPagerVisible" class="meeting-stage__grid-pager">
      <button
        class="meeting-stage__grid-pager-btn"
        type="button"
        title="上一页"
        @click="goToStrictGridPage(strictGridPage - 1)"
      >
        ‹
      </button>
      <span class="meeting-stage__grid-pager-label">{{ strictGridPage + 1 }}/{{ strictGridPageCount }}</span>
      <button
        class="meeting-stage__grid-pager-btn"
        type="button"
        title="下一页"
        @click="goToStrictGridPage(strictGridPage + 1)"
      >
        ›
      </button>
    </div>
    <div v-if="toastText" class="meeting-stage__copied-toast">{{ toastText }}</div>
  </main>
</template>

<style scoped>
.meeting-subject-banner {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  max-width: calc(100% - 32px);
  padding: 8px 20px;
  border-radius: 8px;
  overflow-wrap: anywhere;
  text-align: center;
  pointer-events: none;
}
.meeting-subject-banner img { max-width: 80px; height: 1.2em; object-fit: contain; }
.meeting-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-0);
}
.meeting-stage__jitsi {
  flex: 1 1 0;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.meeting-stage--android .meeting-stage__jitsi,
.meeting-stage--android .meeting-stage__jitsi :deep(.jitsi-frame),
.meeting-stage--android .meeting-stage__jitsi :deep(.jitsi-frame__box) {
  background: #05070b;
}
.meeting-stage__toolbar-slot {
  flex: 0 0 var(--custom-toolbar-height);
  height: var(--custom-toolbar-height);
  min-height: var(--custom-toolbar-height);
}
/* 轮询布局双槽：铺满会议区（留出底部自定义工具栏），盖在 Jitsi iframe 之上。 */
.meeting-stage__polling {
  position: absolute;
  top: 0;
  right: 0;
  bottom: var(--custom-toolbar-height);
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0;
  box-sizing: border-box;
  background: var(--bg-0);
}
/* 全屏工具栏浮动且隐藏时不占位，轮询层必须覆盖到底，避免露出底层 Jitsi 视频。 */
.meeting-stage--fullscreen .meeting-stage__polling {
  bottom: 0;
}
.polling-slot {
  position: relative;
  flex: 0 0 auto;
  width: var(--polling-card-width);
  height: var(--polling-card-height);
  min-width: 0;
  overflow: hidden;
  border-radius: 8px;
  background: transparent;
}
.polling-slot :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.polling-slot__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-low, #6b7889);
  font-size: 13px;
}
.meeting-role {
  /* 保留角色变化的读屏播报，不显示文字，也不占用会议区高度。 */
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.meeting-stage--fullscreen .meeting-stage__toolbar-slot {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  transform: translateY(100%);
  transition: transform 0.16s ease;
  pointer-events: none;
}
.meeting-stage--fullscreen.meeting-stage--toolbar-visible .meeting-stage__toolbar-slot {
  transform: translateY(0);
  pointer-events: auto;
}
.banner-editor-layer {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.28);
}
.transfer-dialog-layer {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.4);
}
.transfer-dialog {
  width: min(420px, calc(100vw - 32px));
  padding: 22px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--panel-solid);
  box-shadow: var(--shadow-card);
  color: var(--text-hi);
}
.transfer-dialog h3 { margin: 0 0 12px; font-size: 18px; }
.transfer-dialog p { margin: 0; line-height: 1.65; color: var(--text-low); }
.transfer-dialog__actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
.banner-editor {
  width: min(460px, calc(100vw - 32px));
  max-height: calc(100vh - 44px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel-solid);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.banner-editor__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
}
.banner-editor__head h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0;
}
.banner-editor__close {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-low);
  cursor: pointer;
}
.banner-editor__close:hover {
  background: var(--bg-1);
  color: var(--text-hi);
}
.banner-editor__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px;
  overflow-y: auto;
}
.banner-editor__toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  width: fit-content;
  color: var(--text-hi);
  font-size: 14px;
  cursor: pointer;
}
.banner-editor__toggle input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
}
.banner-editor__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.banner-editor__field label {
  color: var(--text-mid);
  font-size: 13px;
  font-weight: 600;
}
.banner-editor__field textarea,
.banner-editor__number {
  border: 1px solid var(--line-input);
  border-radius: 6px;
  background: var(--bg-1);
  color: var(--text-hi);
  outline: none;
}
.banner-editor__field textarea {
  width: 100%;
  min-height: 86px;
  resize: vertical;
  padding: 11px 12px;
  line-height: 1.5;
}
.banner-editor__field textarea:focus,
.banner-editor__number:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.banner-editor__count {
  align-self: flex-end;
  color: var(--text-low);
  font-size: 12px;
}
.banner-editor__size-row {
  display: grid;
  grid-template-columns: 1fr 78px;
  gap: 12px;
  align-items: center;
}
.banner-editor__range {
  width: 100%;
  accent-color: var(--accent);
}
.banner-editor__number {
  width: 78px;
  height: 38px;
  padding: 0 8px;
  text-align: center;
}
.banner-editor__select {
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--line-input);
  border-radius: 6px;
  background: var(--bg-1);
  color: var(--text-hi);
  outline: none;
  cursor: pointer;
}
.banner-editor__select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.banner-editor__swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.banner-editor__swatch {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.12s ease;
}
.banner-editor__swatch:hover {
  transform: scale(1.12);
}
.banner-editor__swatch--active {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.banner-editor__swatch--none {
  position: relative;
  overflow: hidden;
  background: var(--bg-1);
  color: var(--text-low);
  font-size: 11px;
  line-height: 1;
}
.banner-editor__swatch--none::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 2px;
  top: 50%;
  height: 1.5px;
  background: var(--text-low);
  transform: rotate(-45deg);
  pointer-events: none;
}
.banner-editor__color-input {
  width: 30px;
  height: 30px;
  padding: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--bg-1);
  cursor: pointer;
}
.banner-editor__logo-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.banner-editor__logo-preview {
  width: 72px;
  height: 48px;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-1);
}
.banner-editor__logo-empty {
  width: 72px;
  height: 48px;
  display: grid;
  place-items: center;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  color: var(--text-low);
  font-size: 12px;
}
.banner-editor__logo-actions {
  display: flex;
  gap: 8px;
}
.banner-editor__logo-upload {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
.banner-editor__logo-error {
  color: var(--danger);
  font-size: 12px;
}
.banner-editor__logo-library {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px;
  background: var(--bg-1);
}
.banner-editor__logo-library-tip {
  margin: 0;
  color: var(--text-low);
  font-size: 12.5px;
  text-align: center;
  padding: 12px 0;
}
.banner-editor__logo-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  max-height: 210px;
  overflow-y: auto;
}
.banner-editor__logo-item {
  position: relative;
  height: 64px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--bg-0);
  cursor: pointer;
  overflow: hidden;
}
.banner-editor__logo-item img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.banner-editor__logo-item:hover {
  border-color: var(--accent);
}
.banner-editor__logo-item--active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.banner-editor__logo-item-del {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 20px;
  height: 20px;
  display: none;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.banner-editor__logo-item:hover .banner-editor__logo-item-del {
  display: grid;
}
.banner-editor__logo-item-del:hover {
  background: var(--danger);
}
.banner-editor__preview-logo {
  height: 1.6em;
  max-width: 120px;
  object-fit: contain;
}
.banner-editor__preview {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(7, 12, 20, 0.78);
  color: #fff;
  font-weight: 800;
  line-height: 1.24;
  text-align: center;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.48);
}
.banner-editor__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
}
.banner-editor__foot .btn {
  min-width: 86px;
}
.banner-editor__foot .btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
/* 标题栏关闭按钮菜单：渲染在会议 iframe 顶部右侧，动作复用底部工具栏结束逻辑。 */
.shell-close-menu-layer {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: transparent;
}
.shell-close-menu {
  position: fixed;
  width: 190px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel-solid);
  box-shadow: var(--shadow-card);
}
.shell-close-menu__item {
  display: block;
  width: 100%;
  padding: 12px 0;
  border: 1px solid transparent;
  border-radius: 6px;
  font-family: inherit;
  font-size: 14.5px;
  font-weight: 500;
  letter-spacing: 0;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    background 0.15s ease;
}
.shell-close-menu__item:hover {
  filter: brightness(1.08);
}
.shell-close-menu__item--primary {
  background: #ee5c3f;
  border-color: #ee5c3f;
  color: #fff;
  font-weight: 600;
}
.shell-close-menu__item--primary:hover {
  background: #e84f30;
}
.shell-close-menu__item:not(.shell-close-menu__item--primary) {
  background: var(--bg-1);
  border-color: var(--line-strong);
  color: var(--text-hi);
}
.shell-close-menu__item:not(.shell-close-menu__item--primary):hover {
  background: var(--bg-2);
}
.meeting-stage--android .shell-close-menu-layer {
  z-index: 180;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 10px max(10px, env(safe-area-inset-bottom, 0px));
  background: rgba(15, 23, 42, 0.36);
  animation: shell-close-sheet-fade-in 0.16s ease-out both;
}
.meeting-stage--android .shell-close-menu {
  position: relative;
  width: min(100%, 420px);
  gap: 10px;
  padding: 10px 12px 12px;
  border-radius: 12px 12px 0 0;
  animation: shell-close-sheet-in 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.meeting-stage--android .shell-close-menu::before {
  content: '';
  align-self: center;
  width: 38px;
  height: 4px;
  margin: 0 0 4px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.45);
}
.meeting-stage--android .shell-close-menu__item {
  min-height: 50px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 16px;
}
.shell-close-menu__item--cancel {
  margin-top: 2px;
  font-weight: 600;
}
@keyframes shell-close-sheet-fade-in {
  from {
    opacity: 0;
  }
}
@keyframes shell-close-sheet-in {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}
/* 等分网格分页器：悬浮在会议区底部居中（避开底部工具栏），盖在 iframe 之上。 */
.meeting-stage__grid-pager {
  position: absolute;
  left: 50%;
  bottom: 88px;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(7, 12, 20, 0.72);
  border: 1px solid var(--line-strong);
  color: var(--text-hi);
  backdrop-filter: blur(10px);
  pointer-events: auto;
}
.meeting-stage__grid-pager-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.15s ease;
}
.meeting-stage__grid-pager-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}
.meeting-stage__grid-pager-label {
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
/* 页内反馈：悬浮在工具栏上方居中，不依赖 Jitsi 的展示通知。 */
.meeting-stage__copied-toast {
  position: fixed;
  left: 50%;
  bottom: 110px;
  transform: translateX(-50%);
  z-index: 80;
  background: var(--panel-solid);
  border: 1px solid var(--line-strong);
  color: var(--text-hi);
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 13.5px;
  max-width: min(520px, calc(100vw - 40px));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: var(--shadow-card);
  animation: toast-in 0.3s var(--ease-out) both;
  pointer-events: none;
}
.gate-panel {
  height: 100%;
  display: grid;
  place-items: center;
  background: radial-gradient(800px 420px at 50% 26%, rgba(14, 165, 233, 0.09), transparent 62%), var(--bg-0);
}
.gate-card {
  position: relative;
  width: min(420px, calc(100vw - 40px));
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 22px;
  padding: 30px 32px 30px;
  backdrop-filter: blur(16px);
  box-shadow: var(--shadow-card);
  animation: pop-in 0.3s var(--ease-out) both;
}
.gate-card::before,
.gate-card::after {
  content: '';
  position: absolute;
  width: 22px;
  height: 22px;
  pointer-events: none;
}
.gate-card::before {
  top: 11px;
  left: 11px;
  border-top: 2px solid var(--accent);
  border-left: 2px solid var(--accent);
  opacity: 0.7;
}
.gate-card::after {
  bottom: 11px;
  right: 11px;
  border-bottom: 2px solid var(--accent);
  border-right: 2px solid var(--accent);
  opacity: 0.7;
}
.gate-card__hud {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.2em;
  color: var(--text-low);
  margin-bottom: 22px;
}
.gate-card__hud-right {
  color: rgba(217, 119, 6, 0.85);
}
.gate-card__title {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.gate-card__desc {
  margin: 0 0 22px;
  font-size: 13.5px;
  color: var(--text-mid);
  line-height: 1.7;
}
.gate-card__room {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 16px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(14, 165, 233, 0.3);
  background: linear-gradient(180deg, rgba(14, 165, 233, 0.1), rgba(14, 165, 233, 0.03));
  margin-bottom: 18px;
}
.gate-card__room-label {
  font-size: 12.5px;
  color: var(--text-mid);
  flex-shrink: 0;
}
.gate-card__room-value {
  flex: 1;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.1em;
  color: var(--text-hi);
  font-variant-numeric: tabular-nums;
}
.gate-card__field {
  margin-bottom: 20px;
}
.req {
  color: var(--danger);
  margin-left: 2px;
}
.gate-card__field input {
  letter-spacing: 0.12em;
  font-family: var(--font-mono);
}
.pwd-row {
  display: flex;
  gap: 8px;
}
.pwd-row input {
  flex: 1;
}
.pwd-eye {
  padding: 0 14px;
}
.gate-card__actions {
  display: flex;
  gap: 10px;
}
.gate-card__join {
  flex: 1;
}
.gate-card__host {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.gate-card__host-toggle {
  background: none;
  border: none;
  color: var(--text-low);
  font-size: 12.5px;
  cursor: pointer;
  padding: 4px 0;
  transition: color 0.15s ease;
}
.gate-card__host-toggle:hover {
  color: var(--accent);
}
.gate-card__host .gate-card__field {
  margin-top: 12px;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-low);
  line-height: 1.7;
}
.gate-card--waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  color: var(--text-mid);
  font-size: 14px;
}
.spinner-wait {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 3px solid rgba(148, 163, 184, 0.2);
  border-top-color: var(--accent);
  animation: gate-spin 0.8s linear infinite;
}
@keyframes gate-spin {
  to {
    transform: rotate(360deg);
  }
}
.error-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-mid);
}
.error-panel__code {
  font-size: 40px;
}
.error-panel__actions {
  display: flex;
  gap: 12px;
}
.ended-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: radial-gradient(800px 400px at 50% 30%, rgba(14, 165, 233, 0.08), transparent 60%), var(--bg-0);
}
.ended-panel__icon {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--text-low);
  background: rgba(148, 163, 184, 0.06);
  border: 1px solid var(--line);
  margin-bottom: 12px;
}
.ended-panel__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ended-panel__desc {
  margin: 0 0 26px;
  font-size: 13.5px;
  color: var(--text-mid);
  font-variant-numeric: tabular-nums;
}
.ended-panel__actions {
  display: flex;
  gap: 12px;
}
.kicked-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: radial-gradient(800px 400px at 50% 30%, rgba(229, 90, 88, 0.16), transparent 60%), var(--bg-0);
}
.kicked-panel__icon {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--danger);
  background: rgba(229, 90, 88, 0.12);
  border: 1px solid rgba(229, 90, 88, 0.35);
  margin-bottom: 12px;
  animation: kicked-pulse 1.6s ease-in-out infinite;
}
.kicked-panel__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.kicked-panel__desc {
  margin: 0 0 26px;
  font-size: 13.5px;
  color: var(--text-mid);
}
.kicked-panel__actions {
  display: flex;
  gap: 12px;
}
@keyframes kicked-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(229, 90, 88, 0.25);
  }
  50% {
    box-shadow: 0 0 0 14px rgba(229, 90, 88, 0);
  }
}
</style>
