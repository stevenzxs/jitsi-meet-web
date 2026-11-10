<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { JitsiDeviceMap, JitsiMeetExternalAPI } from '../types/jitsi'
import { getCameraState } from '../utils/cameraState'

const props = defineProps<{
  api: JitsiMeetExternalAPI | null
   /** 由父组件读取 Jitsi 实际角色，不可传本地 host 标记或 JWT 存在状态。 */
  initialModerator?: boolean
  /** 本地参与者 id（videoConferenceJoined 提供），用于过滤 participantRoleChanged，只看自己的角色变化。 */
  localParticipantId?: string
  /** 本地用户电子屏是否正在展示，用于工具栏按钮高亮。 */
  bannerVisible?: boolean
  /** 桌面端本地录屏入口。 */
  recordingAvailable?: boolean
  recording?: boolean
  recordingBusy?: boolean
  /** 桌面端视频轮询入口。 */
  tilePollingVisible?: boolean
  tilePollingAvailable?: boolean
  tilePollingEnabled?: boolean
}>()

const emit = defineEmits<{
  invite: []
  hangup: []
  'end-for-all': []
  'banner-settings': []
  'recording-toggle': []
  'tile-polling-toggle': []
  'moderator-change': [moderator: boolean]
}>()

const androidEmbed =
  typeof window !== 'undefined' &&
  (new URLSearchParams(window.location.search).get('android') === '1' || document.documentElement.classList.contains('android-embed'))
const audioMuted = ref(true)
const cameraState = shallowRef<ReturnType<typeof getCameraState> | null>(null)
const videoMuted = computed(() => cameraState.value?.muted.value ?? true)
const cameraFeedback = ref('')
let cameraFeedbackTimer: number | undefined
const screenSharing = ref(false)
// 暂停共享态：推流已停止但共享会话未结束（桌面壳悬浮条可恢复/彻底停止）。
const sharePaused = ref(false)
const chatOpen = ref(false)
const participantsOpen = ref(false)
const participantCount = ref(0)
const moderator = ref(props.initialModerator ?? false)
const endMenuOpen = ref(false)
const mobileMoreOpen = ref(false)
const contentSharingParticipantIds = ref<string[]>([])
const screenShareBlockedByOther = computed(() => {
  if (screenSharing.value) return false
  return getRemoteSharingParticipantIds().length > 0
})
// 音频/视频的设备选择面板：'audio' = 麦克风 + 扬声器；'video' = 摄像头
const devicePanel = ref<'audio' | 'video' | null>(null)
const devices = ref<JitsiDeviceMap>({})
const selectedAudioInput = ref('')
const selectedAudioOutput = ref('')
const selectedVideoInput = ref('')

// Android 端音频路由（外放/蓝牙/听筒/有线）由原生 AudioManager 管理，
// WebView 的 enumerateDevices 枚举不到输出设备，只能通过 shell 桥向原生查询。
type AudioRoute = { id: string; kind: string; label: string }
const audioRoutes = ref<AudioRoute[]>([])
const selectedAudioRoute = ref('')

let apiRef: JitsiMeetExternalAPI | null = null
let listenerCleanups: Array<() => void> = []
let mediaStateSyncTimers: number[] = []
let mediaStateSyncSequence = 0
let audioUnavailable = false
// 暂停意图标记：区分"暂停导致的停止"与"用户主动停止"，后者要清掉暂停态。
let pauseRequested = false
// 新共享（切换源）流程：停止旧共享后自动重新发起，桌面壳随之重新弹出源选择器。
let pendingSwitchRestart = false
let switchRestartTimer: number | undefined

function setModerator(value: boolean): void {
  const nextModerator = Boolean(value)
  if (moderator.value === nextModerator) return
  moderator.value = nextModerator
  emit('moderator-change', nextModerator)
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

/**
 * 归一化 Jitsi 共享屏幕参与者事件。
 * 不同版本的 External API 事件和查询返回结构不完全一致，这里统一转成参与者 id 数组。
 */
function normalizeContentSharingParticipants(payload: unknown): string[] {
  const value =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown[] }).data)
        ? (payload as { data: unknown[] }).data
        : payload && typeof payload === 'object' && Array.isArray((payload as { sharingParticipantIds?: unknown[] }).sharingParticipantIds)
          ? (payload as { sharingParticipantIds: unknown[] }).sharingParticipantIds
          : []
  return value.map((id) => String(id)).filter(Boolean)
}

/**
 * 取出非本地用户的屏幕共享者。
 * localParticipantId 还没准备好时不能判断归属，避免误把自己的共享当作别人共享。
 */
function getRemoteSharingParticipantIds(): string[] {
  if (!props.localParticipantId) return []
  return contentSharingParticipantIds.value.filter((id) => id !== props.localParticipantId)
}

/**
 * 同步当前共享屏幕的参与者列表。
 * Jitsi 的 screenSharingStatusChanged 只表示本地状态，是否已有别人共享必须另读全局列表。
 */
async function syncContentSharingParticipants(): Promise<void> {
  try {
    const result = await apiRef?.getContentSharingParticipants()
    contentSharingParticipantIds.value = normalizeContentSharingParticipants(result)
    stopLocalScreenShareIfNeeded()
  } catch {
    /* 低版本 Jitsi 无该方法时只能依赖实时事件。 */
  }
}

/**
 * 强制一次只允许一个用户共享屏幕。
 * 如果本地通过快捷键或 Jitsi 内部入口绕过按钮，在发现已有其他共享者后立即停止本地共享。
 */
function stopLocalScreenShareIfNeeded(): void {
  if (!screenSharing.value || getRemoteSharingParticipantIds().length === 0) return
  apiRef?.executeCommand('toggleShareScreen')
}

function cleanupListeners(): void {
  listenerCleanups.forEach((fn) => {
    try {
      fn()
    } catch {
      /* External API may already be disposed while the toolbar is unmounting. */
    }
  })
  listenerCleanups = []
}

function notifyShellFullscreenToggleAvailability(): void {
  if (!androidEmbed || window.parent === window) return
  const enabled = !chatOpen.value && !participantsOpen.value && !mobileMoreOpen.value
  window.parent.postMessage({ type: 'cloudmeet-fullscreen-toggle-availability', enabled }, '*')
}

function normalizeMuteStatus(event: unknown): boolean {
  return typeof event === 'object' && event !== null ? Boolean((event as { muted?: boolean }).muted) : Boolean(event)
}

function normalizeAvailability(event: unknown): boolean | undefined {
  if (typeof event === 'boolean') return event
  if (!event || typeof event !== 'object') return undefined
  const value = (event as { available?: unknown; isAvailable?: unknown }).available ?? (event as { isAvailable?: unknown }).isAvailable
  return typeof value === 'boolean' ? value : undefined
}

function clearMediaStateSyncTimers(): void {
  mediaStateSyncTimers.forEach((timer) => window.clearTimeout(timer))
  mediaStateSyncTimers = []
}

async function syncMediaState(): Promise<void> {
  const api = apiRef
  if (!api) return
  const sequence = ++mediaStateSyncSequence
  const [audioResult] = await Promise.allSettled([api.isAudioMuted(), cameraState.value?.sync()])
  if (sequence !== mediaStateSyncSequence || api !== apiRef) return
  if (audioResult.status === 'fulfilled') {
    audioMuted.value = audioUnavailable || Boolean(audioResult.value)
  }
}

function scheduleMediaStateSync(delay = 0): void {
  if (delay <= 0) {
    void syncMediaState()
    return
  }
  const timer = window.setTimeout(() => {
    mediaStateSyncTimers = mediaStateSyncTimers.filter((activeTimer) => activeTimer !== timer)
    void syncMediaState()
  }, delay)
  mediaStateSyncTimers.push(timer)
}

function scheduleForegroundMediaStateSync(): void {
  scheduleMediaStateSync()
  scheduleMediaStateSync(250)
  scheduleMediaStateSync(1000)
}

function handleForegroundMediaStateSync(): void {
  scheduleForegroundMediaStateSync()
}

function handleVisibilityMediaStateSync(): void {
  if (document.visibilityState === 'visible') {
    scheduleForegroundMediaStateSync()
  }
}

/**
 * 向桌面/Android 壳上报本地屏幕共享状态（含暂停态）。
 * 桌面壳在共享"整个屏幕"时会最小化会议窗口并显示悬浮控制条，需要靠该消息知道共享何时结束；
 * 共享开始不依赖该消息（壳在授权共享源时已知类型），但结束/暂停/恢复必须上报，否则悬浮条与绿框无法正确刷新。
 */
function notifyShellScreenShareState(active: boolean): void {
  if (window.parent === window) return
  window.parent.postMessage({ type: 'cloudmeet-screen-share-state', active: Boolean(active), paused: sharePaused.value }, '*')
}

function handleShellMediaStateMessage(event: MessageEvent): void {
  const data = event.data as { type?: string } | null
  if (data?.type === 'cloudmeet-app-foreground' || data?.type === 'cloudmeet-media-state-refresh') {
    scheduleForegroundMediaStateSync()
  }
  if (data?.type === 'cloudmeet-stop-screen-share' && event.source === window.parent) {
    // 桌面壳悬浮控制条的"停止共享"按钮。
    if (sharePaused.value) {
      // 暂停态下推流已停止，这里只退出暂停会话并上报最终停止态（active:false, paused:false）。
      sharePaused.value = false
      pauseRequested = false
      pendingSwitchRestart = false
      notifyShellScreenShareState(false)
    } else if (screenSharing.value) {
      // 只在本地确实共享中时响应。
      apiRef?.executeCommand('toggleShareScreen')
    }
  }
  if (data?.type === 'cloudmeet-pause-screen-share' && event.source === window.parent) {
    // 悬浮条"暂停共享"：停止推流但保留共享会话；壳端已记住共享源，恢复时免选择器直接授权。
    if (screenSharing.value && !sharePaused.value) {
      pauseRequested = true
      sharePaused.value = true
      apiRef?.executeCommand('toggleShareScreen')
    }
  }
  if (data?.type === 'cloudmeet-resume-screen-share' && event.source === window.parent) {
    // 悬浮条"恢复共享"：重新发起共享，桌面壳自动授权上一次的源，不弹选择器。
    if (sharePaused.value && !screenSharing.value) {
      sharePaused.value = false
      apiRef?.executeCommand('toggleShareScreen')
    }
  }
  if (data?.type === 'cloudmeet-switch-screen-share' && event.source === window.parent) {
    // 悬浮条"新共享"：先停止当前共享，待停止事件落地后自动重新发起，壳随之弹出源选择器。
    if (screenSharing.value && !sharePaused.value && !pendingSwitchRestart) {
      pendingSwitchRestart = true
      apiRef?.executeCommand('toggleShareScreen')
      // 兜底：停止事件丢失时超时后直接重启，避免共享卡死在停止态。
      switchRestartTimer = window.setTimeout(() => {
        if (pendingSwitchRestart && !sharePaused.value && !screenSharing.value) {
          pendingSwitchRestart = false
          apiRef?.executeCommand('toggleShareScreen')
        }
      }, 1500)
    }
  }
  if (data?.type === 'cloudmeet-camera-unavailable' && androidEmbed && event.source === window.parent) {
    console.log('[Camera] Received cloudmeet-camera-unavailable from Android, timestamp:', new Date().toISOString())
    cameraState.value?.unavailable()
  }
  if (data?.type === 'cloudmeet-audio-routes' && androidEmbed && event.source === window.parent) {
    const payload = data as { routes?: unknown; selected?: unknown }
    audioRoutes.value = Array.isArray(payload.routes) ? (payload.routes as AudioRoute[]) : []
    selectedAudioRoute.value = typeof payload.selected === 'string' ? payload.selected : ''
  }
}

function setupListeners(api: JitsiMeetExternalAPI): void {
  cleanupListeners()

  const on = (event: string, handler: (...args: unknown[]) => void) => {
    api.addListener(event, handler)
    listenerCleanups.push(() => api.removeListener(event, handler))
  }

  // 注意：Jitsi External API 的事件名是 audioMuteStatusChanged / videoMuteStatusChanged，
  // 写错（如 audioMuteChanged）会收不到状态事件，按钮图标和文字无法联动。
  on('audioMuteStatusChanged', (event: unknown) => {
    audioMuted.value = normalizeMuteStatus(event)
    scheduleMediaStateSync(250)
  })

  on('micError', () => {
    audioUnavailable = true
    audioMuted.value = true
    scheduleMediaStateSync(120)
    scheduleMediaStateSync(800)
  })

  on('audioAvailabilityChanged', (event: unknown) => {
    const available = normalizeAvailability(event)
    if (available !== undefined) {
      audioUnavailable = !available
    }
    if (available === false) {
      audioMuted.value = true
    }
    scheduleMediaStateSync(120)
    scheduleMediaStateSync(800)
  })

  on('screenSharingStatusChanged', (status: unknown) => {
    const sharing = typeof status === 'boolean' ? status : Boolean(status && typeof status === 'object' && (status as { on?: boolean }).on)
    if (!sharing) {
      // 非暂停请求导致的停止（用户主动停止/被踢/他人抢占）要清掉暂停态，避免状态残留。
      // 注意不能清 pendingSwitchRestart：切换流程正是靠停止事件落地后自动重启。
      if (!pauseRequested) {
        sharePaused.value = false
      }
      pauseRequested = false
    }
    screenSharing.value = sharing
    // 新共享流程：旧共享停止事件落地后立即重新发起，桌面壳随之弹出源选择器。
    if (!sharing && pendingSwitchRestart && !sharePaused.value) {
      pendingSwitchRestart = false
      if (switchRestartTimer) {
        window.clearTimeout(switchRestartTimer)
        switchRestartTimer = undefined
      }
      apiRef?.executeCommand('toggleShareScreen')
    }
    notifyShellScreenShareState(screenSharing.value)
    if (screenSharing.value) {
      stopLocalScreenShareIfNeeded()
      void syncContentSharingParticipants()
    }
  })

  on('contentSharingParticipantsChanged', (event: unknown) => {
    contentSharingParticipantIds.value = normalizeContentSharingParticipants(event)
    stopLocalScreenShareIfNeeded()
  })

  on('participantJoined', () => {
    participantCount.value++
  })

  on('participantLeft', () => {
    participantCount.value = Math.max(0, participantCount.value - 1)
  })

  // 面板真实状态同步：用户在 Jitsi 面板右上角 X 关闭时，本地开关状态也要跟随还原。
  on('participantsPaneToggled', (event: unknown) => {
    if (event && typeof event === 'object') {
      const open = (event as { open?: boolean }).open
      if (typeof open === 'boolean') {
        participantsOpen.value = open
      } else {
        participantsOpen.value = !participantsOpen.value
      }
    }
    notifyShellFullscreenToggleAvailability()
  })

  on('chatUpdated', (event: unknown) => {
    if (event && typeof event === 'object') {
      const isOpen = (event as { isOpen?: boolean }).isOpen
      if (typeof isOpen === 'boolean') {
        chatOpen.value = isOpen
      }
    }
    notifyShellFullscreenToggleAvailability()
  })

  // 主持人角色跟随：只关心自己的人角色变化（别人被提升/降级不影响本地"结束会议"按钮的显示）。
  on('participantRoleChanged', (participantId: unknown, role: unknown) => {
    const change = normalizeRoleChange(participantId, role)
    if (!props.localParticipantId || !change.participantId || change.participantId !== String(props.localParticipantId)) {
      return
    }
    setModerator(change.role === 'moderator')
  })

  // 设备插拔时刷新选择面板（新版本用 deviceListChanged；旧版本按输入/输出分事件）。
  on('deviceListChanged', () => {
    void loadDevices()
  })
  on('audioDeviceListChanged', () => {
    void loadDevices()
  })
  on('videoDeviceListChanged', () => {
    void loadDevices()
  })
}

/** 拉取当前可用设备列表；首次加载时默认选中第一项（通常为"系统默认"），保证 ✓ 与电平条落在在用设备上。 */
async function loadDevices(): Promise<void> {
  try {
    const list = await apiRef?.getAvailableDevices()
    devices.value = {
      audioInput: list?.audioInput ?? [],
      audioOutput: list?.audioOutput ?? [],
      videoInput: list?.videoInput ?? [],
    }
    if (!selectedAudioInput.value && devices.value.audioInput?.length) {
      selectedAudioInput.value = devices.value.audioInput[0].deviceId ?? ''
    }
    if (!selectedAudioOutput.value && devices.value.audioOutput?.length) {
      selectedAudioOutput.value = devices.value.audioOutput[0].deviceId ?? ''
    }
    if (!selectedVideoInput.value && devices.value.videoInput?.length) {
      selectedVideoInput.value = devices.value.videoInput[0].deviceId ?? ''
    }
  } catch {
    /* 低版本 Jitsi 无该方法时忽略 */
  }
}

/** 打开/收起设备选择面板（打开时同步拉取一次设备列表）。 */
function toggleDevicePanel(kind: 'audio' | 'video'): void {
  devicePanel.value = devicePanel.value === kind ? null : kind
  if (devicePanel.value) {
    void loadDevices()
  }
}

/** 设备选择是 External API 方法，不属于 executeCommand 支持的命令。 */
async function selectDevice(kind: 'audioInput' | 'audioOutput' | 'videoInput', deviceId: string): Promise<void> {
  const api = apiRef
  if (!api) return
  const label = devices.value[kind]?.find((device) => device.deviceId === deviceId)?.label ?? ''
  console.log('[Camera] selectDevice called:', { kind, deviceId, label, timestamp: new Date().toISOString() })
  try {
    if (kind === 'audioInput') await api.setAudioInputDevice(label, deviceId)
    if (kind === 'audioOutput') await api.setAudioOutputDevice(label, deviceId)
    if (kind === 'videoInput') {
      // 切换摄像头前清除已锁存的失败状态，否则新摄像头会被旧 failed 状态直接 mute 掉
      cameraState.value?.resetFailure()
      console.log('[Camera] Calling setVideoInputDevice...')
      await api.setVideoInputDevice(label, deviceId)
      console.log('[Camera] setVideoInputDevice completed successfully')
    }
    if (api !== apiRef) return
    if (kind === 'audioInput') selectedAudioInput.value = deviceId
    if (kind === 'audioOutput') selectedAudioOutput.value = deviceId
    if (kind === 'videoInput') selectedVideoInput.value = deviceId
    devicePanel.value = null
  } catch (error) {
    console.error('[Camera] selectDevice failed:', error)
    if (api !== apiRef) return
    if (kind === 'videoInput') {
      console.log('[Camera] Calling cameraState.unavailable()')
      cameraState.value?.unavailable()
    }
    /* 音频输出设备切换错误在低版本 Jitsi 可能因方法不存在而抛出；忽略即可，
       setAudioOutputDevice 在低版本 Jitsi 无该方法时忽略 */
  }
}

/**
 * 入会时同步当前人数：videoConferenceJoined 对本组件已错过，且入场前的参会人
 * 不会重复触发 participantJoined，所以直接读 Jitsi 维护的参与者列表初始化。
 */
function syncParticipantCount(): void {
  try {
    participantCount.value = apiRef?.getParticipantsInfo().length ?? 0
  } catch {
    /* 低版本 Jitsi 无该方法时忽略 */
  }
}

watch(
  () => props.api,
  (newApi) => {
    if (newApi) {
      apiRef = newApi
      audioUnavailable = false
      cameraState.value = getCameraState(newApi)
      setModerator(props.initialModerator ?? false)
      setupListeners(apiRef)
      scheduleMediaStateSync()
      scheduleMediaStateSync(200)
      scheduleMediaStateSync(800)
      notifyShellFullscreenToggleAvailability()
      // 挂载时 Jitsi 可能仍在派发入场前的 participant-joined，稍后延迟再读一次保证数量准确。
      window.setTimeout(syncParticipantCount, 200)
      window.setTimeout(syncParticipantCount, 800)
      // 屏幕共享状态可能早于工具栏挂载存在，入场后补读一次全局共享者列表。
      window.setTimeout(() => void syncContentSharingParticipants(), 200)
      window.setTimeout(() => void syncContentSharingParticipants(), 800)
    } else {
      clearMediaStateSyncTimers()
      mediaStateSyncSequence++
      cleanupListeners()
      apiRef = null
      audioUnavailable = false
      cameraState.value = null
      audioMuted.value = true
      screenSharing.value = false
      chatOpen.value = false
      participantsOpen.value = false
      participantCount.value = 0
      setModerator(props.initialModerator ?? false)
      endMenuOpen.value = false
      contentSharingParticipantIds.value = []
      devicePanel.value = null
      devices.value = {}
      selectedAudioInput.value = ''
      selectedAudioOutput.value = ''
      selectedVideoInput.value = ''
      notifyShellFullscreenToggleAvailability()
    }
  },
  { immediate: true },
)

function toggleAudio(): void {
  audioUnavailable = false
  apiRef?.executeCommand('toggleAudio')
  scheduleMediaStateSync(160)
  scheduleMediaStateSync(700)
}

function toggleVideo(): void {
  if (androidEmbed && videoMuted.value) {
    cameraFeedback.value = '正在开启摄像头…'
    if (cameraFeedbackTimer !== undefined) window.clearTimeout(cameraFeedbackTimer)
    cameraFeedbackTimer = window.setTimeout(() => {
      cameraFeedbackTimer = undefined
      cameraFeedback.value = videoMuted.value ? '摄像头未能开启，请重试或切换摄像头' : ''
    }, 3000)
  } else {
    if (cameraFeedbackTimer !== undefined) window.clearTimeout(cameraFeedbackTimer)
    cameraFeedbackTimer = undefined
    cameraFeedback.value = ''
  }
  void cameraState.value?.toggle()
  scheduleMediaStateSync(160)
  scheduleMediaStateSync(700)
}

watch(videoMuted, (muted) => {
  if (!muted) {
    if (cameraFeedbackTimer !== undefined) window.clearTimeout(cameraFeedbackTimer)
    cameraFeedbackTimer = undefined
    cameraFeedback.value = ''
  }
})

function toggleScreenShare(): void {
  if (screenShareBlockedByOther.value) return
  if (androidEmbed && window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-android-share-menu' }, '*')
    return
  }
  // 暂停态下从会议内按钮重新发起共享：视为全新共享（壳会弹选择器），先退出暂停态。
  if (sharePaused.value && !screenSharing.value) {
    sharePaused.value = false
    pauseRequested = false
  }
  // 注意：External API 命令名是 toggleShareScreen（toggle-share-screen），不是 toggleScreenShare。
  apiRef?.executeCommand('toggleShareScreen')
}

function toggleChat(): void {
  mobileMoreOpen.value = false
  apiRef?.executeCommand('toggleChat')
  chatOpen.value = !chatOpen.value
  notifyShellFullscreenToggleAvailability()
}

function toggleMobileMore(): void {
  mobileMoreOpen.value = !mobileMoreOpen.value
  if (mobileMoreOpen.value) {
    endMenuOpen.value = false
    devicePanel.value = null
    void loadDevices()
    requestAudioRoutes()
  }
  notifyShellFullscreenToggleAvailability()
}

function closeMobileMore(): void {
  mobileMoreOpen.value = false
  notifyShellFullscreenToggleAvailability()
}

function switchMobileCamera(deviceId: string): void {
  console.log('[Camera] switchMobileCamera called:', { deviceId, timestamp: new Date().toISOString() })
  void selectDevice('videoInput', deviceId)
  mobileMoreOpen.value = false
  notifyShellFullscreenToggleAvailability()
}

function getMobileCameraLabel(device: { label?: string }, index: number): string {
  const label = String(device.label || '').trim()
  const normalized = label.toLowerCase()
  if (/front|前置|selfie|user/.test(normalized)) return '前置摄像头'
  if (/back|rear|后置|environment/.test(normalized)) return '后置摄像头'
  return label || `摄像头 ${index + 1}`
}

function requestAudioRoutes(): void {
  if (!androidEmbed || window.parent === window) return
  window.parent.postMessage({ type: 'cloudmeet-audio-routes-get' }, '*')
}

function selectAudioRoute(route: AudioRoute): void {
  selectedAudioRoute.value = route.id
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-audio-route-set', id: route.id }, '*')
  }
  mobileMoreOpen.value = false
  notifyShellFullscreenToggleAvailability()
}

function toggleParticipants(): void {
  // toggle-participants-pane 必须传布尔参数：true=打开、false=关闭；
  // 不传参会默认走 closeParticipantsPane，导致面板永远打不开。
  participantsOpen.value = !participantsOpen.value
  apiRef?.executeCommand('toggleParticipantsPane', participantsOpen.value)
  notifyShellFullscreenToggleAvailability()
}

function handleInvite(): void {
  if (!moderator.value) return
  emit('invite')
}

function handleBannerSettings(): void {
  if (!moderator.value) return
  endMenuOpen.value = false
  devicePanel.value = null
  emit('banner-settings')
}

function handleRecordingToggle(): void {
  endMenuOpen.value = false
  devicePanel.value = null
  emit('recording-toggle')
}

function handleTilePollingToggle(): void {
  endMenuOpen.value = false
  devicePanel.value = null
  emit('tile-polling-toggle')
}

function toggleEndMenu(): void {
  // 弹窗中点击任意选项后关闭；再次点击结束会议按钮也可收起。
  endMenuOpen.value = !endMenuOpen.value
}

/** 关闭工具栏上的浮层，供标题栏关闭菜单打开前收起底部已有菜单。 */
function closeFloatingMenus(): void {
  endMenuOpen.value = false
  devicePanel.value = null
}

function leaveMeeting(): void {
  endMenuOpen.value = false
  emit('hangup')
}

/** 由父组件统一校验业务凭据并发起房间结束，工具栏不提前关闭任何参会端。 */
function endMeetingForAll(): void {
  if (!moderator.value) return
  endMenuOpen.value = false
  emit('end-for-all')
}

watch(() => props.initialModerator, value => setModerator(Boolean(props.api && value)))

// 点击弹窗外区域收起（结束菜单与设备选择面板）。
function handleDocumentClick(event: MouseEvent): void {
  const target = event.target as Element | null
  // target 可能是 SVG 内部节点或非 Element（如文本节点），统一向上找最外层可判定元素。
  const origin = target && typeof (target as { closest?: unknown }).closest === 'function' ? target : target ? (target.parentElement ?? null) : null
  const menu = document.querySelector('.end-menu')
  const inMenu = origin ? Boolean(menu?.contains(origin)) : false
  const inTrigger = origin?.closest('.end-trigger')
  const inDevicePop = origin ? Boolean(origin.closest('.device-pop')) : false
  const inDeviceCaret = origin ? Boolean(origin.closest('.toolbar-split__caret')) : false
  // Android 的更多抽屉由遮罩层自行处理关闭，避免 WebView 合成 click 时被全局监听立即收起。
  const inMobileMore = origin ? Boolean(origin.closest('.mobile-more-layer')) : false
  if (!inMenu && !inTrigger && !inDevicePop && !inDeviceCaret && !inMobileMore) {
    endMenuOpen.value = false
    devicePanel.value = null
  }
}

document.addEventListener('click', handleDocumentClick)

function cleanupDocumentListener(): void {
  document.removeEventListener('click', handleDocumentClick)
}

/** 暴露结束动作给桌面标题栏关闭菜单复用，避免两处入口出现行为分叉。 */
function isModerator(): boolean {
  return moderator.value
}

defineExpose({ closeFloatingMenus, endMeetingForAll, isModerator, leaveMeeting, syncMediaState })

onMounted(() => {
  window.addEventListener('focus', handleForegroundMediaStateSync)
  window.addEventListener('pageshow', handleForegroundMediaStateSync)
  window.addEventListener('message', handleShellMediaStateMessage)
  document.addEventListener('visibilitychange', handleVisibilityMediaStateSync)
})

onBeforeUnmount(() => {
  if (cameraFeedbackTimer !== undefined) window.clearTimeout(cameraFeedbackTimer)
  window.removeEventListener('focus', handleForegroundMediaStateSync)
  window.removeEventListener('pageshow', handleForegroundMediaStateSync)
  window.removeEventListener('message', handleShellMediaStateMessage)
  document.removeEventListener('visibilitychange', handleVisibilityMediaStateSync)
  clearMediaStateSyncTimers()
  cleanupDocumentListener()
  cleanupListeners()
})
</script>

<template>
  <div class="custom-toolbar">
    <!-- 静音：未静音=正常麦克风+蓝色高亮"静音"；已静音=斜杠麦克风+红色"取消静音"。
         右侧小箭头打开设备选择（麦克风/扬声器），选择弹窗固定在按钮正上方。 -->
    <div class="toolbar-split">
      <button
        class="toolbar-btn"
        :class="audioMuted ? 'toolbar-btn--muted' : 'toolbar-btn--on'"
        :title="audioMuted ? '取消静音' : '静音'"
        @click="toggleAudio"
      >
        <svg
          v-if="!audioMuted"
          class="toolbar-btn__icon"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="9" y="2" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v4" />
        </svg>
        <svg
          v-else
          class="toolbar-btn__icon"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="9" y="2" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <path d="M12 18v4" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </svg>
        <span class="toolbar-btn__label">{{ audioMuted ? '取消静音' : '静音' }}</span>
      </button>
      <button
        v-if="!androidEmbed"
        class="toolbar-split__caret"
        :class="{ 'toolbar-split__caret--open': devicePanel === 'audio' }"
        type="button"
        title="切换音频设备"
        aria-label="切换音频设备"
        @click.stop="toggleDevicePanel('audio')"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      <div v-if="devicePanel === 'audio'" class="device-pop" @click.stop>
        <div class="device-pop__group">
          <svg class="device-pop__group-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v4" />
          </svg>
          <span>麦克风</span>
        </div>
        <button
          v-for="d in devices.audioInput ?? []"
          :key="'mic-' + (d.deviceId || '')"
          class="device-pop__item"
          :class="{ 'device-pop__item--active': selectedAudioInput === d.deviceId }"
          type="button"
          @click="selectDevice('audioInput', d.deviceId ?? '')"
        >
          <span class="device-pop__accent"></span>
          <span class="device-pop__check">{{ selectedAudioInput === d.deviceId ? '✓' : '' }}</span>
          <span class="device-pop__label">{{ d.label || '未知麦克风' }}</span>
        </button>
        <div class="device-pop__group">
          <svg class="device-pop__group-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
          <span>扬声器</span>
        </div>
        <button
          v-for="d in devices.audioOutput ?? []"
          :key="'out-' + (d.deviceId || '')"
          class="device-pop__item"
          :class="{ 'device-pop__item--active': selectedAudioOutput === d.deviceId }"
          type="button"
          @click="selectDevice('audioOutput', d.deviceId ?? '')"
        >
          <span class="device-pop__accent"></span>
          <span class="device-pop__check">{{ selectedAudioOutput === d.deviceId ? '✓' : '' }}</span>
          <span class="device-pop__label">{{ d.label || '未知扬声器' }}</span>
        </button>
        <p v-if="!devices.audioInput?.length && !devices.audioOutput?.length" class="device-pop__empty">未检测到音频设备</p>
      </div>
    </div>

    <!-- 开启视频：开启=正常摄像头+蓝色高亮"关闭视频"；关闭=斜杠摄像头+红色"开启视频"。
         右侧小箭头打开摄像头设备选择弹窗。 -->
    <div class="toolbar-split">
      <button
        class="toolbar-btn"
        :class="videoMuted ? 'toolbar-btn--muted' : 'toolbar-btn--on'"
        :title="videoMuted ? '开启视频' : '关闭视频'"
        @click="toggleVideo"
      >
        <svg
          v-if="!videoMuted"
          class="toolbar-btn__icon"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="6" width="12" height="12" rx="2" />
          <path d="M14 10l6-3v10l-6-3" />
        </svg>
        <svg
          v-else
          class="toolbar-btn__icon"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="6" width="12" height="12" rx="2" />
          <path d="M14 10l6-3v10l-6-3" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </svg>
        <span class="toolbar-btn__label">{{ videoMuted ? '开启视频' : '关闭视频' }}</span>
      </button>
      <button
        v-if="!androidEmbed"
        class="toolbar-split__caret"
        :class="{ 'toolbar-split__caret--open': devicePanel === 'video' }"
        type="button"
        title="切换摄像头"
        aria-label="切换摄像头"
        @click.stop="toggleDevicePanel('video')"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 15 12 9 18 15" />
        </svg>
      </button>
      <div v-if="devicePanel === 'video'" class="device-pop" @click.stop>
        <div class="device-pop__group">
          <svg class="device-pop__group-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="6" width="12" height="12" rx="2" />
            <path d="M14 10l6-3v10l-6-3" />
          </svg>
          <span>摄像头</span>
        </div>
        <button
          v-for="d in devices.videoInput ?? []"
          :key="'cam-' + (d.deviceId || '')"
          class="device-pop__item"
          :class="{ 'device-pop__item--active': selectedVideoInput === d.deviceId }"
          type="button"
          @click="selectDevice('videoInput', d.deviceId ?? '')"
        >
          <span class="device-pop__accent"></span>
          <span class="device-pop__check">{{ selectedVideoInput === d.deviceId ? '✓' : '' }}</span>
          <span class="device-pop__label">{{ d.label || '未知摄像头' }}</span>
        </button>
        <p v-if="!devices.videoInput?.length" class="device-pop__empty">未检测到摄像头</p>
      </div>
    </div>

    <!-- 共享屏幕：共享中=蓝色高亮"停止共享" -->
    <button
      v-if="!androidEmbed"
      class="toolbar-btn"
      :class="{ 'toolbar-btn--on': screenSharing }"
      :disabled="screenShareBlockedByOther"
      :title="screenShareBlockedByOther ? '已有用户正在共享屏幕' : screenSharing ? '停止共享' : '共享屏幕'"
      @click="toggleScreenShare"
    >
      <svg
        class="toolbar-btn__icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
      </svg>
      <span class="toolbar-btn__label">{{ screenSharing ? '停止共享' : '共享屏幕' }}</span>
    </button>

    <button v-if="moderator" class="toolbar-btn" title="邀请" @click="handleInvite">
      <svg
        class="toolbar-btn__icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </svg>
      <span class="toolbar-btn__label">邀请</span>
    </button>

    <button class="toolbar-btn" :class="{ 'toolbar-btn--on': participantsOpen }" title="成员" @click="toggleParticipants">
      <svg
        class="toolbar-btn__icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span class="toolbar-btn__label">成员({{ participantCount }})</span>
    </button>

    <button class="toolbar-btn" :class="{ 'toolbar-btn--on': chatOpen }" title="聊天" @click="toggleChat">
      <svg
        class="toolbar-btn__icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span class="toolbar-btn__label">聊天</span>
    </button>

    <Teleport v-if="androidEmbed" to="body">
      <div
        v-if="mobileMoreOpen"
        class="mobile-more-layer"
        @pointerdown.stop
        @touchstart.stop
        @click.self="closeMobileMore"
      >
        <div class="mobile-more-sheet" role="dialog" aria-modal="true" aria-label="更多功能">
          <div class="mobile-more-sheet__grabber"></div>
          <div class="mobile-more-sheet__header">
            <span>更多</span>
            <button
              class="mobile-more-sheet__close"
              type="button"
              aria-label="关闭"
              @pointerdown.stop
              @touchstart.stop
              @click.stop="closeMobileMore"
            >×</button>
          </div>
          <div class="mobile-more-sheet__section-title">摄像头</div>
          <div v-if="devices.videoInput?.length" class="mobile-more-camera-list">
            <button
              v-for="(device, index) in devices.videoInput ?? []"
              :key="device.deviceId"
              class="mobile-more-camera-item"
              :class="{ 'mobile-more-camera-item--active': selectedVideoInput === device.deviceId }"
              type="button"
              @pointerdown.stop
              @touchstart.stop
              @click.stop="switchMobileCamera(device.deviceId || '')"
            >
              <svg class="mobile-more-camera-item__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 10l4.5-2.5A1 1 0 0 1 21 8.4v7.2a1 1 0 0 1-1.5.9L15 14" />
                <rect x="3" y="6" width="12" height="12" rx="2" />
              </svg>
              <span>{{ getMobileCameraLabel(device, index) }}</span>
              <span v-if="selectedVideoInput === device.deviceId" class="mobile-more-camera-item__check">✓</span>
            </button>
          </div>
          <div v-else class="mobile-more-sheet__empty">暂无可用摄像头</div>
          <div class="mobile-more-sheet__section-title">音频设备</div>
          <div v-if="audioRoutes.length" class="mobile-more-camera-list">
            <button
              v-for="route in audioRoutes"
              :key="route.id"
              class="mobile-more-camera-item"
              :class="{ 'mobile-more-camera-item--active': selectedAudioRoute === route.id }"
              type="button"
              @pointerdown.stop
              @touchstart.stop
              @click.stop="selectAudioRoute(route)"
            >
              <svg v-if="route.kind === 'bluetooth'" class="mobile-more-camera-item__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />
              </svg>
              <svg v-else class="mobile-more-camera-item__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
              <span>{{ route.label }}</span>
              <span v-if="selectedAudioRoute === route.id" class="mobile-more-camera-item__check">✓</span>
            </button>
          </div>
          <div v-else class="mobile-more-sheet__empty">暂无可用音频设备</div>
        </div>
      </div>
    </Teleport>

    <button
      v-if="androidEmbed"
      class="toolbar-btn mobile-more-trigger"
      :class="{ 'toolbar-btn--on': mobileMoreOpen }"
      title="更多"
      type="button"
      @pointerdown.stop
      @touchstart.stop
      @click.stop="toggleMobileMore"
    >
      <svg class="toolbar-btn__icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="19" cy="12" r="2" />
      </svg>
      <span class="toolbar-btn__label">更多</span>
    </button>

    <button
      v-if="!androidEmbed && moderator"
      class="toolbar-btn"
      :class="{ 'toolbar-btn--on': bannerVisible }"
      :title="bannerVisible ? '编辑电子屏' : '设置电子屏'"
      @click="handleBannerSettings"
    >
      <svg
        class="toolbar-btn__icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 9h10" />
        <path d="M7 13h6" />
      </svg>
      <span class="toolbar-btn__label">电子屏</span>
    </button>

    <button
      v-if="!androidEmbed && recordingAvailable"
      class="toolbar-btn"
      :class="{ 'toolbar-btn--recording': recording }"
      :disabled="recordingBusy"
      :title="recording ? '结束录制' : '录屏'"
      @click="handleRecordingToggle"
    >
      <svg
        class="toolbar-btn__icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      </svg>
      <span class="toolbar-btn__label">{{ recording ? '结束录制' : '录屏' }}</span>
    </button>

    <button
      v-if="!androidEmbed && tilePollingVisible"
      class="toolbar-btn"
      :class="{ 'toolbar-btn--on': tilePollingEnabled }"
      :disabled="!tilePollingAvailable"
      :title="tilePollingEnabled ? '关闭轮询' : tilePollingAvailable ? '轮询' : '请在设置中开启轮询时间'"
      @click="handleTilePollingToggle"
    >
      <svg
        class="toolbar-btn__icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 12a9 9 0 0 0-15.3-6.4" />
        <polyline points="3 5 5.7 5.6 6.3 3" />
        <path d="M3 12a9 9 0 0 0 15.3 6.4" />
        <polyline points="21 19 18.3 18.4 17.7 21" />
      </svg>
      <span class="toolbar-btn__label">{{ tilePollingEnabled ? '关闭轮询' : '轮询' }}</span>
    </button>

    <!-- 结束会议：Android 端使用底部抽屉，桌面端保留按钮上方小菜单。 -->
    <div class="end-trigger-wrap">
      <Teleport v-if="androidEmbed" to="body">
        <div v-if="endMenuOpen" class="end-menu-layer" @click.self="closeFloatingMenus">
          <div class="end-menu end-menu--sheet" role="dialog" aria-modal="true" aria-label="结束会议">
            <div class="end-menu__grabber"></div>
            <button v-if="moderator" class="end-menu__item end-menu__item--primary" @click="endMeetingForAll">全员结束会议</button>
            <button class="end-menu__item" @click="leaveMeeting">离开会议</button>
            <button class="end-menu__item end-menu__item--cancel" @click="closeFloatingMenus">取消</button>
          </div>
        </div>
      </Teleport>
      <div v-else-if="endMenuOpen" class="end-menu">
        <button v-if="moderator" class="end-menu__item end-menu__item--primary" @click="endMeetingForAll">全员结束会议</button>
        <button class="end-menu__item" @click="leaveMeeting">离开会议</button>
      </div>
      <button
        v-if="!androidEmbed"
        class="toolbar-btn toolbar-btn--hangup end-trigger"
        :class="{ 'toolbar-btn--end-open': endMenuOpen }"
        :title="endMenuOpen ? '取消' : '结束会议'"
        @click="toggleEndMenu"
      >
        <svg
          v-if="!endMenuOpen"
          class="toolbar-btn__icon"
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        <span class="toolbar-btn__label">{{ endMenuOpen ? '取消' : '结束会议' }}</span>
      </button>
    </div>
    <Teleport to="body">
      <span v-if="androidEmbed && cameraFeedback" class="camera-feedback" role="status">{{ cameraFeedback }}</span>
    </Teleport>
  </div>
</template>

<style scoped>
.custom-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  /* 固定总高：结束会议按钮弹窗切换时图标会消失，若容器高度由内容撑起会抖动，这里锁定不变 */
  height: var(--custom-toolbar-height);
  padding: 0 12px;
  background: var(--toolbar-bg);
  backdrop-filter: blur(16px);
  border-top: 1px solid var(--line);
  flex-shrink: 0;
  z-index: 20;
}

.toolbar-btn {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 70px;
  padding: 9px 12px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--text-mid);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.toolbar-btn:hover {
  background: rgba(148, 163, 184, 0.12);
  color: var(--text-hi);
}

/* 他人正在共享屏幕时，本地共享入口禁用；停止自己的共享仍保持可点击。 */
.toolbar-btn:disabled {
  color: var(--text-low);
  cursor: not-allowed;
  opacity: 0.52;
}

.toolbar-btn:disabled:hover {
  background: transparent;
  color: var(--text-low);
}

/* 开启状态：蓝色高亮 */
.toolbar-btn--on {
  color: var(--accent);
}

.toolbar-btn--on:hover {
  background: rgba(56, 189, 248, 0.12);
}

/* 静音/关闭状态：图标红色斜杠、文字白色 */
.toolbar-btn--muted {
  color: var(--danger);
}

.toolbar-btn--muted .toolbar-btn__label {
  color: var(--text-hi);
}

.toolbar-btn--recording {
  color: var(--danger);
}

.toolbar-btn--recording:hover {
  background: rgba(239, 68, 68, 0.13);
}

.toolbar-btn__icon {
  flex-shrink: 0;
  /* 图标只是视觉元素：不接收指针事件，点击一律由按钮本体承接，
     避免 SVG 内部 path/polyline 作为 event.target 时 closest 判定意外失效 */
  pointer-events: none;
}

.toolbar-btn__label {
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
  line-height: 1;
}

/* 音频/视频分体按钮：主按钮（静音/开关）+ 右上角小箭头（设备选择） */
.toolbar-split {
  position: relative;
  display: flex;
  align-items: stretch;
}

.camera-feedback {
  position: fixed;
  bottom: calc(var(--custom-toolbar-height) + 12px);
  left: 50%;
  z-index: 90;
  width: max-content;
  max-width: min(300px, 80vw);
  transform: translateX(-50%);
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(24, 33, 48, .92);
  color: #fff;
  font-size: 12px;
  text-align: center;
  white-space: nowrap;
  pointer-events: none;
}

/* 小箭头悬浮在按钮右上角，独立点击区域（不触达主按钮的切换） */
.toolbar-split__caret {
  position: absolute;
  top: 4px;
  right: 5px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-low);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.toolbar-split__caret:hover {
  background: rgba(148, 163, 184, 0.12);
  color: var(--text-hi);
}

.toolbar-split__caret--open {
  color: var(--accent);
}

/* 设备选择弹窗：固定在按钮正上方，与 Jitsi 原生弹出同构：
   分组标题带图标、选中项左侧蓝条 + ✓、在用音频设备行带绿色脉冲电平条。 */
.device-pop {
  position: absolute;
  bottom: calc(100% + 14px);
  left: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-height: 340px;
  overflow-y: auto;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--panel-solid);
  box-shadow: var(--shadow-card);
  user-select: none;
}

.device-pop__group {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 16px 7px;
  color: var(--text-hi);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0;
}

.device-pop__group-icon {
  color: var(--text-low);
}

.device-pop__group + .device-pop__group {
  margin-top: 8px;
  border-top: 1px solid var(--line);
}

.device-pop__item {
  position: relative;
  width: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px 7px 20px;
  border: none;
  background: transparent;
  color: var(--text-mid);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
}

.device-pop__item:hover {
  background: rgba(148, 163, 184, 0.1);
  color: var(--text-hi);
}

/* 选中项：左侧 3px 蓝色竖条 + 浅蓝背景 + ✓ */
.device-pop__item--active {
  background: var(--accent-soft);
  color: var(--text-hi);
}

.device-pop__accent {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: transparent;
}

.device-pop__item--active .device-pop__accent {
  background: var(--accent);
}

.device-pop__check {
  flex: 0 0 auto;
  width: 16px;
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

.device-pop__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 13px;
}

.device-pop__empty {
  margin: 8px 16px;
  color: var(--text-low);
  font-size: 12.5px;
}

/* 结束会议容器：弹窗与按钮同容器，确保弹窗固定在按钮正上方 */
.end-trigger-wrap {
  position: relative;
  margin-left: 10px;
}

/* 结束会议按钮：透明底，红色图标+红色文字（参考样式） */
/* Keep the full selector inside :global: trailing descendants are dropped by the SFC compiler. */
:global(html.android-embed .mobile-more-trigger) {
  min-width: 62px;
}

:global(html.android-embed .mobile-more-layer) {
  position: fixed;
  inset: 0;
  z-index: 180;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 10px max(10px, env(safe-area-inset-bottom, 0px));
  background: rgba(15, 23, 42, 0.36);
}

:global(html.android-embed .mobile-more-sheet) {
  width: min(100%, 420px);
  padding: 10px 14px 16px;
  border-radius: 14px 14px 0 0;
  background: var(--panel-solid);
  box-shadow: 0 -14px 40px rgba(0, 0, 0, 0.42);
  animation: toolbar-more-sheet-in 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
}

:global(html.android-embed .mobile-more-sheet__grabber) {
  width: 38px;
  height: 4px;
  margin: 0 auto 10px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.45);
}

:global(html.android-embed .mobile-more-sheet__header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 42px;
  color: var(--text-hi);
  font-size: 16px;
  font-weight: 700;
}

:global(html.android-embed .mobile-more-sheet__close) {
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-mid);
  font-size: 24px;
  line-height: 1;
}

:global(html.android-embed .mobile-more-sheet__section-title) {
  margin: 8px 0;
  color: var(--text-low);
  font-size: 12px;
}

:global(html.android-embed .mobile-more-camera-list) {
  display: grid;
  gap: 8px;
}

:global(html.android-embed .mobile-more-camera-item) {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-1);
  color: var(--text-hi);
  font: inherit;
  text-align: left;
}

:global(html.android-embed .mobile-more-camera-item--active) {
  border-color: rgba(33, 197, 93, 0.7);
  background: var(--accent-soft);
  color: var(--accent);
}

:global(html.android-embed .mobile-more-camera-item__icon) {
  flex: 0 0 auto;
  margin-right: 10px;
}

:global(html.android-embed .mobile-more-camera-item__check) {
  margin-left: auto;
  font-size: 18px;
}

:global(html.android-embed .mobile-more-sheet__empty) {
  padding: 18px 0 8px;
  color: var(--text-low);
  font-size: 13px;
  text-align: center;
}

@keyframes toolbar-more-sheet-in {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

.toolbar-btn--hangup {
  min-width: 92px;
  background: transparent;
  color: var(--danger);
}

.toolbar-btn--hangup:hover {
  background: rgba(229, 72, 77, 0.12);
  color: var(--danger);
}

/* 弹窗打开时按钮变"取消"，加红色外框 */
.toolbar-btn--hangup.toolbar-btn--end-open {
  border: 1.5px solid var(--danger);
}

/* "取消"/"结束会议"文字比普通按钮更大更醒目 */
.toolbar-btn--hangup .toolbar-btn__label {
  font-size: 14px;
  font-weight: 700;
}

/* 结束会议弹窗：红/描边选项，从按钮正上方弹出 */
.end-menu {
  position: absolute;
  bottom: calc(100% + 12px);
  left: 50%;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 190px;
  padding: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel-solid);
  box-shadow: var(--shadow-card);
}

/* 无动画瞬时出现，点击后立即响应 */
.end-menu {
  transform: translateX(-50%);
}

.end-menu-layer {
  position: fixed;
  inset: 0;
  z-index: 180;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 10px max(10px, env(safe-area-inset-bottom, 0px));
  background: rgba(15, 23, 42, 0.36);
  animation: toolbar-end-sheet-fade-in 0.16s ease-out both;
}

.end-menu.end-menu--sheet {
  position: relative;
  left: auto;
  right: auto;
  bottom: auto;
  width: min(100%, 420px);
  gap: 10px;
  padding: 10px 12px 12px;
  border-radius: 12px 12px 0 0;
  transform: none;
  animation: toolbar-end-sheet-in 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.end-menu__grabber {
  align-self: center;
  width: 38px;
  height: 4px;
  margin: 0 0 4px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.45);
}

.end-menu.end-menu--sheet .end-menu__item {
  min-height: 50px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 16px;
}

.end-menu__item {
  display: block;
  width: 100%;
  padding: 12px 0;
  border: 1px solid transparent;
  border-radius: 6px;
  font-family: inherit;
  font-size: 14.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    background 0.15s ease;
}

.end-menu__item:hover {
  filter: brightness(1.08);
}

/* 全员结束会议：红色实底 */
.end-menu__item--primary {
  background: #ee5c3f;
  border-color: #ee5c3f;
  color: #fff;
  font-weight: 600;
}

.end-menu__item--primary:hover {
  background: #e84f30;
}

/* 离开会议：描边透明底，浅色/深色自适应 */
.end-menu__item:not(.end-menu__item--primary) {
  background: var(--bg-1);
  border-color: var(--line-strong);
  color: var(--text-hi);
}

.end-menu__item:not(.end-menu__item--primary):hover {
  background: var(--bg-2);
}

.end-menu__item--cancel {
  margin-top: 2px;
  font-weight: 600;
}

@keyframes toolbar-end-sheet-fade-in {
  from {
    opacity: 0;
  }
}

@keyframes toolbar-end-sheet-in {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}
</style>
