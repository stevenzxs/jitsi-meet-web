<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { JitsiMeetExternalAPI } from '../types/jitsi'
import { JITSI_HOST, JITSI_SERVER, PREJOIN_ENABLED, buildInviteText, loadExternalApi, setApi } from '../utils/jitsi'
import { getCameraState, disposeCameraState } from '../utils/cameraState'
import { disabledDeviceNotifications } from '../utils/deviceNotifications'
import { buildJitsiCustomTheme } from '../utils/theme'
import type { ThemeMode } from '../utils/theme'
import { createSignalLossMonitor, isXmppRecovering } from '../utils/signalLoss'
import { HOST_TRANSFER_MENU_ID } from '../utils/hostTransferClient'
import { createRoomPasswordGuard } from '../utils/roomPassword'

type JitsiConferenceJoinedInfo = {
  id?: string
  participantId?: string
  displayName?: string
}

type JitsiConfigOverwrite = Record<string, unknown>

const ANDROID_WEBVIEW_VIDEO_HEIGHT = 720
const ANDROID_WEBVIEW_VIDEO_CODECS = ['VP8', 'H264'] as const
const ANDROID_WEBVIEW_LOG_LEVELS = ['warn', 'error', 'log'] as const
const ANDROID_WEBVIEW_DIAGNOSTIC_EVENTS = [
  'log',
  'errorOccurred',
  'cameraError',
  'micError',
  'videoAvailabilityChanged',
  'audioAvailabilityChanged',
  'p2pStatusChanged',
] as const

const props = withDefaults(
  defineProps<{
    roomName: string
    subject?: string
    password?: string
    displayName?: string
    preserveOnRoomSwitch?: boolean
    jwt?: string
    theme?: ThemeMode
  }>(),
  { subject: '', password: '', displayName: '', preserveOnRoomSwitch: false, jwt: '', theme: 'dark' },
)

const emit = defineEmits<{
  joined: [info: { participantId: string; displayName?: string }]
  passwordRequired: []
  left: []
  'conference-ended': []
  'connection-lost': []
  kicked: []
  error: [message: string]
  'reload-error': [message: string]
}>()

const container = ref<HTMLElement | null>(null)
const loading = ref(true)
const joined = ref(false)
const copied = ref(false)

let api: JitsiMeetExternalAPI | null = null
let passwordRetryTimer: number | undefined
let hostPasswordTimer: number | undefined
let copiedTimer: number | undefined
let leaveFallbackTimer: number | undefined
let leaveSettlementTimer: number | undefined
let themeSyncTimer: number | undefined
let themeSyncFrame: HTMLIFrameElement | null = null
let closing = false
let leaveRequested = false
let stopSignalMonitor: (() => void) | undefined

function watchSignalLoss(source: JitsiMeetExternalAPI): void {
  stopSignalMonitor?.()
  stopSignalMonitor = createSignalLossMonitor({
    now: () => performance.now(),
    schedule: tick => window.setInterval(tick, 1000),
    cancel: timer => window.clearInterval(timer),
    read: () => {
      if (api !== source || closing || leaveRequested) return null
      const frame = source.getIFrame()?.contentWindow as (Window & { APP?: any }) | null
      const app = frame?.APP
      const state = app?.store?.getState()?.['features/base/conference']
      const room = app?.conference?._room
      if (!room || state?.conference !== room) return null
      const connection = room.getConnection?.()?.xmpp?.connection
      return { conference: room, transitioning: Boolean(state.joining || state.leaving),
        connected: connection?.connected, recovering: isXmppRecovering(connection) }
    },
    onLost: () => {
      if (api !== source || closing || leaveRequested) return
      disposeApi()
      emit('connection-lost')
    },
  })
}
// 原生工具栏（含状态栏 inset）悬浮在 WebView 上方的实际高度，CSS px。
// 由壳层 cloudmeet-toolbar-height 消息驱动，用于下移 Jitsi 聊天/成员面板。
let shellToolbarHeightPx = 0

function normalizeJoinedInfo(info: JitsiConferenceJoinedInfo): { participantId: string; displayName?: string } {
  return {
    participantId: String(info.participantId || info.id || ''),
    displayName: info.displayName,
  }
}

function isAndroidEmbed(): boolean {
  const searchParams = new URLSearchParams(window.location.search)
  return searchParams.get('android') === '1' || document.documentElement.classList.contains('android-embed')
}

function buildAndroidWebViewConfigOverwrite(): JitsiConfigOverwrite {
  return {
    apiLogLevels: [...ANDROID_WEBVIEW_LOG_LEVELS],
    // The Android shell uses its own media-state indicators; avoid Jitsi's dominant-speaker
    // decoration being rendered around the video surface.
    hideDominantSpeakerBadge: true,
    disableSimulcast: true,
    maxFullResolutionParticipants: 1,
    p2p: {
      enabled: false,
      codecPreferenceOrder: [...ANDROID_WEBVIEW_VIDEO_CODECS],
      mobileCodecPreferenceOrder: [...ANDROID_WEBVIEW_VIDEO_CODECS],
    },
    resolution: ANDROID_WEBVIEW_VIDEO_HEIGHT,
    constraints: {
      video: {
        height: {
          ideal: ANDROID_WEBVIEW_VIDEO_HEIGHT,
          max: ANDROID_WEBVIEW_VIDEO_HEIGHT,
          min: 180,
        },
      },
    },
    videoQuality: {
      codecPreferenceOrder: [...ANDROID_WEBVIEW_VIDEO_CODECS],
      mobileCodecPreferenceOrder: [...ANDROID_WEBVIEW_VIDEO_CODECS],
      vp8: {
        scalabilityModeEnabled: false,
      },
      h264: {
        scalabilityModeEnabled: false,
      },
      vp9: {
        scalabilityModeEnabled: false,
        useKSVC: false,
        useSimulcast: false,
      },
      av1: {
        scalabilityModeEnabled: false,
        useKSVC: false,
        useSimulcast: false,
      },
    },
  }
}

function buildJitsiConfigOverwrite(): JitsiConfigOverwrite {
  return {
    // 服务端须按 MUC 角色授权（mod_muc_jwt_owner + ENABLE_AUTO_OWNER=false，部署时核验），
    // 前端必须按 presence 角色渲染；true 会让客户端按 token 猜角色，导致参会者面板角色显示错误
    enableUserRolesBasedOnToken: false,
    startWithAudioMuted: true,
    startWithVideoMuted: true,
    prejoinConfig: PREJOIN_ENABLED ? { enabled: true } : { enabled: false, hideDisplayName: true },
    disableProfile: true,
    disableRemoteMute: false,
    // stable/jitsi-meet_11146 ParticipantContextMenu shares this switch with the participant pane.
    // UI restriction only: server-side affiliation authorization must still be verified.
    remoteVideoMenu: {
      disableGrantModerator: true,
    },
    // Register once even for guests: a live promotion must not need an iframe
    // rebuild to gain the transfer action. The handler checks live authority.
    customParticipantMenuButtons: [{
      id: HOST_TRANSFER_MENU_ID,
      text: '设为主持人',
      icon: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l4 4 5-7 5 7 4-4-2 12H5L3 7z"/></svg>')}`,
    }],
    participantsPane: {
      hideModeratorSettingsTab: false,
      hideMoreActionsButton: false,
      hideMuteAllButton: false,
    },
    breakoutRooms: {
      hideAddRoomButton: false,
      hideAutoAssignButton: false,
      hideJoinRoomButton: false,
      hideModeratorSettingsTab: false,
      hideMoreActionsButton: false,
      hideMuteAllButton: false,
    },
    conferenceInfo: {
      alwaysVisible: [],
      autoHide: [],
    },
    hideConferenceSubject: true,
    // The meeting duration is rendered by the native/outer shell.
    hideConferenceTimer: true,
    connectionIndicators: {
      disabled: true,
      disableDetails: true,
    },
    // endpointTextMessageReceived depends on the Jitsi data channel.
    openBridgeChannel: 'datachannel',
    disableInviteFunctions: true,
    toolbarButtons: [],
    disabledNotifications: [...disabledDeviceNotifications],
    customTheme: buildJitsiCustomTheme(props.theme),
    welcomePage: {
      disabled: true,
    },
    ...(isAndroidEmbed() ? buildAndroidWebViewConfigOverwrite() : {}),
  }
}

function addAndroidWebViewDiagnostics(apiInstance: JitsiMeetExternalAPI): void {
  if (!isAndroidEmbed()) return
  ANDROID_WEBVIEW_DIAGNOSTIC_EVENTS.forEach((eventName) => {
    apiInstance.addListener(eventName, (...args: unknown[]) => {
      console.warn(`[Jitsi Android WebView] ${eventName}`, ...args)
    })
  })
}

async function copyMeetingInvite(): Promise<void> {
  const text = buildInviteText({
    subject: props.subject,
    roomName: props.roomName,
    password: props.password,
  })
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'readonly')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
  api?.executeCommand('showNotification', {
    title: '分享',
    description: '会议邀请已复制',
    timeout: 2600,
  })
  copied.value = true
  if (copiedTimer) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
  }, 1800)
}

function tryPassword(): void {
  if (!props.password || closing) return
  clearPasswordRetries()
  let sent = 0
  const send = () => {
    if (!closing && sent < 45) {
      api?.executeCommand('password', props.password)
      sent += 1
    }
  }
  send()
  passwordRetryTimer = window.setInterval(send, 1000)
}

function clearPasswordRetries(): void {
  if (passwordRetryTimer !== undefined) {
    window.clearInterval(passwordRetryTimer)
    passwordRetryTimer = undefined
  }
}

function ensureHostPassword(): void {
  if (!props.jwt || !props.password || closing) return
  const source = api
  const tick = createRoomPasswordGuard({
    deadline: performance.now() + 15000,
    read: () => {
      try {
        const frame = source?.getIFrame()?.contentWindow as (Window & { APP?: any }) | null
        const conference = frame?.APP?.store?.getState()?.['features/base/conference']?.conference
        return conference ? { moderator: conference.isModerator(), locked: conference.room?.locked === true } : undefined
      } catch { return undefined }
    },
    lock: () => source?.executeCommand('password', props.password),
    failed: () => emit('reload-error', '会议密码保护未能确认，请勿分享会议，重试进入或联系管理员'),
  })
  const check = () => {
    if (closing || source !== api || tick(performance.now())) {
      window.clearInterval(hostPasswordTimer)
      hostPasswordTimer = undefined
    }
  }
  window.clearInterval(hostPasswordTimer)
  hostPasswordTimer = window.setInterval(check, 200)
  check()
}

/**
 * 将外层主题标记同步到 Jitsi iframe。
 * custom.css 位于 iframe 内部，无法读取父页面的 data-theme；同源部署时直接设置根节点，
 * 跨域部署则通过 iframe 的 color-scheme 驱动 CSS light-dark() 变量取色。
 */
function syncIframeTheme(): void {
  if (themeSyncTimer !== undefined) {
    window.clearTimeout(themeSyncTimer)
    themeSyncTimer = undefined
  }

  const frame = api?.getIFrame() ?? container.value?.querySelector('iframe')
  if (!frame) {
    themeSyncTimer = window.setTimeout(syncIframeTheme, 100)
    return
  }

  // 跨域 iframe 不能直接改内部 DOM，但 iframe 元素的 color-scheme 会传递给内部 CSS。
  frame.style.colorScheme = props.theme
  frame.parentElement?.style.setProperty('color-scheme', props.theme)
  container.value?.style.setProperty('color-scheme', props.theme)

  if (themeSyncFrame !== frame) {
    themeSyncFrame?.removeEventListener('load', syncIframeTheme)
    themeSyncFrame = frame
    frame.addEventListener('load', syncIframeTheme)
  }

  try {
    // 同源时同步根节点标记，覆盖不支持 light-dark() 的浏览器和旧 Jitsi 页面。
    const root = frame.contentDocument?.documentElement
    root?.setAttribute('data-theme', props.theme)
    root?.style.setProperty('color-scheme', props.theme)
    frame.contentDocument?.body?.setAttribute('data-theme', props.theme)
    frame.contentDocument?.body?.style.setProperty('color-scheme', props.theme)
  } catch {
    // Jitsi 与业务站点跨域时无法访问 contentDocument，此时交给 iframe color-scheme 和 customTheme。
  }
}

function handleShellToolbarMessage(event: MessageEvent): void {
  if (!isAndroidEmbed() || event.source !== window.parent) return
  const data = event.data as { type?: string; height?: unknown } | null
  if (data?.type !== 'cloudmeet-toolbar-height') return
  const height = Number(data.height)
  const next = Number.isFinite(height) && height > 0 ? Math.round(height) : 0
  if (next === shellToolbarHeightPx) return
  shellToolbarHeightPx = next
  syncAndroidIframeLayout()
}

function syncAndroidIframeLayout(): void {
  if (!isAndroidEmbed()) return
  const frame = api?.getIFrame() ?? container.value?.querySelector('iframe')
  if (!frame) return
  try {
    const doc = frame.contentDocument
    if (!doc?.head) return
    const styleId = 'cloudmeet-android-iframe-layout'
    let style = doc.getElementById(styleId) as HTMLStyleElement | null
    if (!style) {
      style = doc.createElement('style')
      style.id = styleId
      doc.head.appendChild(style)
    }
    style.textContent = `
html, body, #root, #react, #videoconference_page, #layout_wrapper, #videospace,
#largeVideoBackgroundContainer, #largeVideoWrapper, #largeVideoContainer,
#sharedVideo, #remoteVideos {
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  outline: 0 !important;
}
#videoconference_page, #layout_wrapper, #videospace, #largeVideoWrapper,
#largeVideoContainer, #remoteVideos {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: none !important;
}
#filmstrip, #filmstripRemoteVideosContainer, .filmstrip {
  opacity: 0 !important;
  pointer-events: none !important;
}
body {
  overflow: hidden !important;
}
/* 聊天/投票/成员面板 top:0 全屏覆盖，会被悬浮的原生工具栏挡住标签栏，
   按原生工具栏实际高度下移；全屏（工具栏隐藏）时壳层推 0，自动复位 */
#sideToolbarContainer,
#participants-pane {
  top: ${shellToolbarHeightPx}px !important;
  bottom: 0 !important;
  height: auto !important;
}
`
  } catch {
    /* Cross-origin Jitsi deployments cannot be styled from the parent page. */
  }
}

function clearIframeThemeSync(): void {
  if (themeSyncTimer !== undefined) {
    window.clearTimeout(themeSyncTimer)
    themeSyncTimer = undefined
  }
  themeSyncFrame?.removeEventListener('load', syncIframeTheme)
  themeSyncFrame = null
}

function disposeApi(force = false): void {
  window.clearInterval(hostPasswordTimer)
  hostPasswordTimer = undefined
  stopSignalMonitor?.()
  stopSignalMonitor = undefined
  if (leaveSettlementTimer !== undefined) {
    window.clearTimeout(leaveSettlementTimer)
    leaveSettlementTimer = undefined
  }
  if (closing && !force) return
  closing = true
  if (leaveFallbackTimer !== undefined) {
    window.clearTimeout(leaveFallbackTimer)
    leaveFallbackTimer = undefined
  }
  clearPasswordRetries()
  clearIframeThemeSync()
  if (api) disposeCameraState(api)
  api?.removeAllListeners()
  api?.dispose()
  api = null
  setApi(null)
  if (container.value) {
    container.value.innerHTML = ''
  }
}

/** A room switch also emits left. Settle only a verified local leave, never a peer claim. */
function handleConferenceLeft(attempt = 0): void {
  if (!props.preserveOnRoomSwitch || leaveRequested) {
    disposeApi()
    emit('left')
    return
  }
  const source = api
  if (leaveSettlementTimer !== undefined) window.clearTimeout(leaveSettlementTimer)
  leaveSettlementTimer = window.setTimeout(() => {
    leaveSettlementTimer = undefined
    if (!source || source !== api || closing) return
    try {
      const frame = source.getIFrame()?.contentWindow as (Window & {
        APP?: {
          store?: { getState(): Record<string, any> }
          conference?: { _room?: { isJoined?(): boolean } }
        }
      }) | null
      const app = frame?.APP
      const conference = app?.store?.getState()?.['features/base/conference']
      if (!conference) return
      if (conference.joining || conference.leaving) {
        if (attempt < 20) handleConferenceLeft(attempt + 1)
        return
      }
      if (conference.conference) return
      if (app?.conference?._room?.isJoined?.() === true) return
    } catch {
      // Unknown/cross-origin state is not evidence of a completed leave.
      return
    }
    disposeApi()
    emit('left')
  }, 1500)
}

function requestLeave(): void {
  leaveRequested = true
  if (closing) {
    emit('left')
    return
  }
  if (!api) {
    emit('left')
    return
  }
  api.executeCommand('hangup')
  if (leaveFallbackTimer !== undefined) window.clearTimeout(leaveFallbackTimer)
  leaveFallbackTimer = window.setTimeout(() => {
    if (!closing) {
      disposeApi()
      emit('left')
    }
  }, 1300)
}

function handleUnload(event: Event): void {
  if ((event as PageTransitionEvent).persisted || closing) return
  // ExternalAPI.dispose only queues a postMessage; unloading immediately removes
  // its receiver. The deployed ChatRoom.doLeave sends unavailable and flushes
  // Strophe synchronously, specifically for the page-unload lifecycle.
  try {
    const frame = api?.getIFrame()?.contentWindow as (Window & {
      APP?: { conference?: { _room?: { room?: { doLeave?(): void } } } }
    }) | null
    frame?.APP?.conference?._room?.room?.doLeave?.()
  } catch { /* Unsupported/cross-origin iframe: never fabricate a successful leave. */ }
  disposeApi()
}

window.addEventListener('pagehide', handleUnload)
window.addEventListener('beforeunload', handleUnload)

function watchIframeNavigation(): void {
  if (props.preserveOnRoomSwitch) return
  const check = () => {
    const frame = container.value?.querySelector('iframe')
    if (!frame || closing) return
    try {
      const path = new URL(frame.src).pathname.replace(/^\//, '')
      if (path !== props.roomName) {
        disposeApi()
        emit('kicked')
        return
      }
    } catch {
      /* ignore */
    }
    window.setTimeout(check, 1500)
  }
  window.setTimeout(check, 800)
}

function hideLoadingAfterIframeLoad(): void {
  // prejoin 关闭时，iframe 文档 load 后 Jitsi 仍会先渲染自带的深色连接页，
  // 直到 videoConferenceJoined 才进入浅色会议界面。此时保留浅色加载遮罩，
  // 避免 iframe load → joined 之间出现黑屏窗口期（遮罩会在 joined 时关闭）。
  // prejoin 开启时必须按原逻辑在 load 后放开遮罩，否则会挡住 Jitsi 的入会交互页。
  if (PREJOIN_ENABLED) {
    const check = () => {
      const frame = container.value?.querySelector('iframe')
      if (frame) {
        frame.addEventListener('load', () => {
          loading.value = false
        })
      } else {
        window.setTimeout(check, 100)
      }
    }
    window.setTimeout(check, 50)
  }
}

async function init(): Promise<void> {
  const perfStart = performance.now()
  const perfMark = (label: string): void => {
    console.info(`[meeting-perf] jitsi ${label}`, `${Math.round(performance.now() - perfStart)}ms`)
  }
  perfMark('init-start')
  closing = false
  loading.value = true
  joined.value = false
  leaveRequested = false
  if (!JITSI_SERVER) {
    emit('error', '未配置 VITE_JITSI_SERVER，请检查 .env 文件')
    return
  }
  try {
    await loadExternalApi()
    perfMark('external-api-loaded')
  } catch (e) {
    emit('error', (e as Error).message)
    return
  }
  if (!container.value || !window.JitsiMeetExternalAPI) return

  api = new window.JitsiMeetExternalAPI(JITSI_HOST, {
    roomName: props.roomName,
    width: '100%',
    height: '100%',
    parentNode: container.value,
    configOverwrite: buildJitsiConfigOverwrite(),
    // 同时放在 External API 顶层，兼容把 customTheme 作为 API 选项读取的 Jitsi 版本。
    customTheme: buildJitsiCustomTheme(props.theme),
    interfaceConfigOverwrite: {
      SHOW_JITSI_WATERMARK: false,
      SHOW_WATERMARK_FOR_GUESTS: false,
      SHOW_BRAND_WATERMARK: false,
      DISABLE_JOIN_LEAVE_NOTIFICATIONS: false,
      CONNECTION_INDICATOR_DISABLED: true,
      CONNECTION_INDICATOR_AUTO_HIDE_ENABLED: true,
      CONNECTION_INDICATOR_AUTO_HIDE_TIMEOUT: 0,
      ...(isAndroidEmbed() ? { DISABLE_DOMINANT_SPEAKER_INDICATOR: true } : {}),
      MOBILE_APP_PROMO: false,
      APP_NAME: '云会议',
    },
    userInfo: { displayName: props.displayName || '参会者' },
    ...(props.jwt ? { jwt: props.jwt } : {}),
    lang: 'zh-CN',
  })
  perfMark('external-api-created')

  getCameraState(api)
  setApi(api)
  addAndroidWebViewDiagnostics(api)
  // iframe 创建后立即尝试同步；若页面尚未完成加载，load 监听会再次执行。
  syncIframeTheme()
  syncAndroidIframeLayout()
  window.addEventListener('message', handleShellToolbarMessage)
  window.setTimeout(syncAndroidIframeLayout, 800)
  window.setTimeout(syncAndroidIframeLayout, 1800)
  hideLoadingAfterIframeLoad()
  try {
    api.executeCommand('toggleToolbar', false)
  } catch {}

  api.addListener('videoConferenceJoined', (info: JitsiConferenceJoinedInfo) => {
    if (leaveSettlementTimer !== undefined) window.clearTimeout(leaveSettlementTimer)
    leaveSettlementTimer = undefined
    perfMark('video-conference-joined')
    const joinedInfo = normalizeJoinedInfo(info)
    leaveRequested = false
    joined.value = true
    if (api) watchSignalLoss(api)
    loading.value = false
    clearPasswordRetries()
    emit('joined', joinedInfo)
    ensureHostPassword()
  })

  api.addListener('passwordRequired', () => {
    tryPassword()
    emit('passwordRequired')
  })

  api.addListener('kickedOut', () => {
    disposeApi()
    emit('kicked')
  })

  // Endpoint text is not proof of room termination. Never dispose the iframe on a peer's claim.

  api.addListener('readyToClose', () => {
    disposeApi()
    emit('left')
  })

  api.addListener('videoConferenceLeft', () => handleConferenceLeft())

  watchIframeNavigation()
}

onMounted(init)

/**
 * 外层主题变化后重建 Jitsi iframe，让 customTheme 和服务端 custom.css 的主题分支重新生效。
 */
let reloadInProgress = false
async function reloadWithTheme(): Promise<void> {
  if (reloadInProgress) return
  reloadInProgress = true
  const source = api
  try {
    if (source) {
      // dispose() removes the iframe but does not await an XMPP/MUC leave.
      // Keep the old transport alive until Jitsi confirms its formal hangup.
      source.removeAllListeners()
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('旧会议连接离会未确认')), 15000)
        source.addListener('videoConferenceLeft', () => {
          window.clearTimeout(timer)
          resolve()
        })
        try { source.executeCommand('hangup') }
        catch (error) { window.clearTimeout(timer); reject(error) }
      })
      if (api !== source) return
    }
    disposeApi(true)
    await init()
  } catch {
    // Do not create a second session while the old owner's departure is unknown.
    console.warn('会议连接重建暂停：旧连接离会未确认，请重新进入会议')
    emit('reload-error', '旧会议连接离会未确认，已暂停重建以避免重复会话；请重新进入会议')
  } finally { reloadInProgress = false }
}

defineExpose({ requestLeave, getApi: () => api, copyMeetingInvite, reloadWithTheme })

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', handleUnload)
  window.removeEventListener('beforeunload', handleUnload)
  window.removeEventListener('message', handleShellToolbarMessage)
  if (copiedTimer) window.clearTimeout(copiedTimer)
  if (leaveFallbackTimer) window.clearTimeout(leaveFallbackTimer)
  clearPasswordRetries()
  disposeApi()
})
</script>

<template>
  <div class="jitsi-frame">
    <div ref="container" class="jitsi-frame__box"></div>
    <div v-if="loading" class="jitsi-frame__loading">
      <div class="spinner"></div>
      <p>正在进入会议…</p>
    </div>
    <div v-if="copied" class="jitsi-frame__toast">会议邀请已复制</div>
  </div>
</template>

<style scoped>
.jitsi-frame {
  position: relative;
  width: 100%;
  height: auto;
  margin: 0;
  padding: 0;
  border: 0;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-1);
  color-scheme: inherit;
}

.jitsi-frame__box {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  margin: 0;
  padding: 0;
  border: 0;
  background: var(--bg-1);
  color-scheme: inherit;
}
.jitsi-frame__box :deep(iframe) {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  background: var(--bg-1);
  color-scheme: inherit;
}
.jitsi-frame__loading {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-mid);
  font-size: 14px;
  letter-spacing: 0.04em;
  background: var(--bg-1);
}
.spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(148, 163, 184, 0.2);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
.jitsi-frame__toast {
  position: absolute;
  left: 50%;
  bottom: 92px;
  z-index: 30;
  transform: translateX(-50%);
  padding: 9px 16px;
  border: 1px solid rgba(52, 211, 153, 0.36);
  border-radius: 6px;
  background: rgba(7, 9, 13, 0.88);
  color: #d8ffef;
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 16px 34px rgba(0, 0, 0, 0.34);
  pointer-events: none;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
