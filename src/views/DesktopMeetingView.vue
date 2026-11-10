<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import MeetingStage from '../components/MeetingStage.vue'
import { getSession, saveSession, getMeetingCredentials, getPendingHostTransfer } from '../stores/meeting'
import { PREJOIN_ENABLED } from '../utils/jitsi'
import { createAndroidCredentialGate } from '../utils/androidCredentialGate.js'

const router = useRouter()
const route = useRoute()
const stage = ref<InstanceType<typeof MeetingStage> | null>(null)

const props = defineProps<{
  roomName: string
  subject?: string
}>()

const nativeCredentialEntry = route.query.android === '1' && route.query.credentialBridge === '1'
const credentialState = ref<'waiting' | 'ready' | 'error'>(nativeCredentialEntry ? 'waiting' : 'ready')
let credentialGate: ReturnType<typeof createAndroidCredentialGate> | undefined
let credentialSyncTimer = 0
let lastNativeHostKey = ''
function closeCredentialGate(): void {
  window.clearInterval(credentialSyncTimer)
  credentialGate?.close()
}
if (nativeCredentialEntry) {
  if (window.parent === window || location.pathname !== `/cm/desktop/meeting/${props.roomName}`) {
    credentialState.value = 'error'
  } else {
    credentialGate = createAndroidCredentialGate({
      parent: window.parent, room: props.roomName, path: location.pathname, storage: localStorage,
      getSession, saveSession,
      listen: (listener: (event: MessageEvent) => void) => {
        window.addEventListener('message', listener)
        return () => window.removeEventListener('message', listener)
      },
      schedule: (callback: () => void) => {
        const timer = window.setTimeout(callback, 15000)
        return () => window.clearTimeout(timer)
      },
      onState: (state: 'waiting' | 'ready' | 'error', initialHostKey?: string) => {
        if (state === 'ready') lastNativeHostKey = initialHostKey ?? ''
        credentialState.value = state
      },
    })
    window.addEventListener('pagehide', closeCredentialGate)
    let previous = ''
    credentialSyncTimer = window.setInterval(() => {
      if (credentialState.value !== 'ready') return
      const pending = getPendingHostTransfer(props.roomName)
      const credentials = getMeetingCredentials(props.roomName)
      const key = pending?.hostKey ?? credentials?.hostKey ?? ''
      const state = { state: pending ? 'pending' as const : key ? 'candidate' as const : 'revoked' as const,
        hostKey: key, expectedHostKey: lastNativeHostKey, password: credentials?.password ?? '' }
      const snapshot = JSON.stringify(state)
      if (snapshot !== previous && credentialGate?.sync(state)) {
        previous = snapshot
        lastNativeHostKey = key
      }
    }, 250)
  }
}

/**
 * 桌面壳弹出加入窗口后，会把一次性入会信息附在 iframe URL 上。
 * 这里读取后马上写入现有会话存储，后续仍复用普通参会人的 MeetingStage 流程。
 */
function readDesktopJoinPayload(): { password: string; displayName: string; hostKey: string; endTime?: number } | null {
  if (nativeCredentialEntry) return null
  if (route.query.desktopJoin !== '1') return null
  const displayName = String(route.query.displayName ?? '').trim()
  const password = String(route.query.password ?? '').trim()
  const hostKey = String(route.query.hostKey ?? '').trim()
  const endTime = Number(route.query.endTime) || undefined
  if (!PREJOIN_ENABLED && !displayName) return null
  return { displayName, password, hostKey, endTime }
}

const desktopJoinPayload = readDesktopJoinPayload()
if (!getSession(props.roomName) && desktopJoinPayload) {
  saveSession({
    roomName: props.roomName,
    subject: props.subject || '',
    password: desktopJoinPayload.password,
    displayName: desktopJoinPayload.displayName,
    createdAt: Date.now(),
    host: !!desktopJoinPayload.hostKey,
    ...(desktopJoinPayload.hostKey ? { hostKey: desktopJoinPayload.hostKey } : {}),
    ...(desktopJoinPayload.endTime ? { endTime: desktopJoinPayload.endTime } : {}),
  })
  // 入会信息已经落到 sessionStorage，清理 query 避免密码长时间留在 iframe 地址中。
  void router.replace({
    name: 'desktop-meeting',
    params: { roomName: props.roomName },
    query: props.subject ? { subject: props.subject } : {},
  })
}

// MeetingStage 在电子屏文字更新后推送同一个当前主题，避免标题栏停留在初始会议名。
function updateWindowSubject(subject: string): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'cloudmeet-meeting-subject', subject }, '*')
  }
}

/** 桌面会议页的结束/被移出/错误面板没有"返回首页"语义，直接关闭本窗口。 */
function closeWindow(): void {
  window.parent.postMessage({ type: 'cloudmeet-close-window' }, '*')
}

function handleShellMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return
  const data = event.data as { type?: string; anchor?: { top?: number; right?: number }; fullscreen?: boolean; visible?: boolean; titlebarHeight?: number } | null
  if (data?.type === 'cloudmeet-window-close-request') {
    // 交由 MeetingStage 复用底部结束菜单或离会流程，避免桌面壳直接销毁 iframe。
    const handled = stage.value?.requestCloseFromShell(data.anchor)
    if (handled) {
      // 标题栏关闭按钮现在会先打开结束菜单；通知桌面壳取消兜底关闭，等待用户选择。
      window.parent.postMessage({ type: 'cloudmeet-window-close-deferred' }, '*')
    }
  } else if (data?.type === 'cloudmeet-fullscreen-changed') {
    stage.value?.setFullscreenState(Boolean(data.fullscreen))
  } else if (data?.type === 'cloudmeet-fullscreen-controls-visible') {
    stage.value?.setFullscreenControlsVisible(Boolean(data.visible), data.titlebarHeight)
  }
}

window.addEventListener('message', handleShellMessage)

onBeforeUnmount(() => {
  closeCredentialGate()
  window.removeEventListener('pagehide', closeCredentialGate)
  window.removeEventListener('message', handleShellMessage)
})
</script>

<template>
  <div class="meeting-page">
    <MeetingStage
      v-if="credentialState === 'ready'"
      ref="stage"
      :room-name="roomName"
      :subject="subject"
      mode="desktop"
      @close-window="closeWindow"
      @subject-changed="updateWindowSubject"
    />
    <div v-else class="credential-status" role="status">
      <p>{{ credentialState === 'waiting' ? '正在安全同步本机会议凭据…' : '本机会议凭据同步未完成，请退出后重试。未使用链接密钥降级入会。' }}</p>
      <button type="button" @click="closeWindow">退出</button>
    </div>
  </div>
</template>

<style scoped>
.credential-status {
  margin: auto;
  padding: 24px;
  max-width: 480px;
  text-align: center;
}
.meeting-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
</style>
