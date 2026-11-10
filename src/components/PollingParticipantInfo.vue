<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { JitsiMeetExternalAPI } from '../types/jitsi'
import { getPollingParticipantInfo, type PollingParticipantInfo } from '../utils/pollingLayout'

const props = defineProps<{ api: JitsiMeetExternalAPI | null; participantId: string; hasVideo: boolean }>()
const info = ref<PollingParticipantInfo | null>(null)
const root = ref<HTMLElement | null>(null)
const avatarSize = ref(120)
const badgeStyle = ref<Record<string, string>>({})
const nameStyle = ref<Record<string, string>>({})
let resize: ResizeObserver | undefined

onMounted(() => {
  const slot = root.value?.parentElement
  if (!slot) return
  // Jitsi Thumbnail._getAvatarSize(): min(height / 2, width - 30, 200).
  const update = () => { avatarSize.value = Math.max(0, Math.min(slot.clientHeight / 2, slot.clientWidth - 30, 200)) }
  resize = new ResizeObserver(update)
  resize.observe(slot)
  update()
})
onBeforeUnmount(() => resize?.disconnect())

// 状态订阅独立于轮询计时器，暂停轮询也继续跟随静音、改名和角色变化。
watch(() => [props.api, props.participantId] as const, ([api, id], _, onCleanup) => {
  info.value = null
  const refresh = () => {
    info.value = getPollingParticipantInfo(api, id)
    try {
      const frame = api?.getIFrame()?.contentWindow
      if (!frame) return
      const nativeBadge = frame.document.querySelector<HTMLElement>('.bottom-indicators')
      const nativeName = nativeBadge?.querySelector<HTMLElement>('.displayName')
      // 姓名使用原生 labelBold 排版；不要把字重应用到 SVG 状态图标。
      const nativeTypography = nativeName ? frame.getComputedStyle(nativeName) : null
      nameStyle.value = nativeTypography ? {
        fontFamily: nativeTypography.fontFamily,
        fontWeight: nativeTypography.fontWeight,
        fontSize: nativeTypography.fontSize,
        lineHeight: nativeTypography.lineHeight,
        letterSpacing: nativeTypography.letterSpacing,
      } : {}
      const light = frame.getComputedStyle(frame.document.documentElement).colorScheme === 'light'
      badgeStyle.value = {
        backgroundColor: nativeBadge ? frame.getComputedStyle(nativeBadge).backgroundColor : light ? '#edf2f8' : '#242424',
        color: nativeName ? frame.getComputedStyle(nativeName).color : light ? '#16202e' : '#ffffff',
      }
    } catch { /* iframe 不可读时使用外层主题变量 */ }
  }
  refresh()
  if (!api || !id) return
  try {
    const frame = api.getIFrame()?.contentWindow as Window & {
      APP?: { store?: { subscribe?: (listener: () => void) => () => void } }
    }
    const unsubscribe = frame?.APP?.store?.subscribe?.(refresh)
    if (unsubscribe) onCleanup(unsubscribe)
    const themeObserver = new MutationObserver(refresh)
    themeObserver.observe(frame.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    onCleanup(() => themeObserver.disconnect())
  } catch { /* 同源状态不可读时不显示过期信息 */ }
}, { immediate: true })
</script>

<template>
  <div ref="root" class="polling-card-details">
    <template v-if="info">
      <div v-if="!hasVideo" class="polling-card-avatar" :aria-label="`${info.displayName}，摄像头已关闭`"
        :style="{ width: `${avatarSize}px`, height: `${avatarSize}px`, fontSize: `${avatarSize * 0.4}px`, backgroundColor: info.avatar.color }">
        {{ info.avatar.initials }}
      </div>
      <div class="polling-card-bottom">
        <div class="polling-participant-info" :style="badgeStyle">
          <!-- 与 Jitsi AudioMutedIndicator / ModeratorIndicator 的 SVG 和 16px 尺寸一致。 -->
          <span v-if="info.audioMuted === true" class="polling-card-indicator" title="已静音" aria-label="已静音">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M16.5 6.44V6a4.5 4.5 0 1 0-9 0v6c0 .972.308 1.872.832 2.607L7.26 15.68A5.974 5.974 0 0 1 6 12v-1.5a.75.75 0 0 0-1.5 0V12c0 1.801.635 3.454 1.693 4.747L3.22 19.72a.75.75 0 1 0 1.06 1.06l16.5-16.5a.75.75 0 0 0-1.06-1.06L16.5 6.44ZM15 7.94V6a3 3 0 1 0-6 0v6c0 .556.151 1.077.415 1.524L15 7.939Z" />
              <path d="M9.79 17.58A6 6 0 0 0 18 12v-1.5a.75.75 0 0 1 1.5 0V12a7.501 7.501 0 0 1-6.75 7.463v2.287a.75.75 0 0 1-1.5 0v-2.287a7.452 7.452 0 0 1-2.188-.56c-.465-.199-.541-.799-.183-1.156.237-.238.6-.29.911-.167Z M15.75 11.25A.75.75 0 0 0 15 12a3 3 0 0 1-3 3 .75.75 0 0 0 0 1.5 4.5 4.5 0 0 0 4.5-4.5.75.75 0 0 0-.75-.75Z" />
            </svg>
          </span>
          <span v-if="info.showModerator" class="polling-card-indicator" title="主持人" aria-label="主持人">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true">
              <path d="M4.5 3h15A1.5 1.5 0 0 1 21 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3Zm-3 1.5a3 3 0 0 1 3-3h15a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3h-15a3 3 0 0 1-3-3v-15ZM8.718 7H6.3v10.91h1.896v-7.512h.102l3.014 7.48h1.417l3.015-7.464h.101v7.495h1.897V7h-2.419l-3.238 7.905h-.128L8.718 7Z" />
            </svg>
          </span>
          <span class="polling-card-name" :style="nameStyle" :title="info.displayName">{{ info.displayName }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.polling-card-details { position: absolute; inset: 0; pointer-events: none; }
.polling-card-avatar {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  font-weight: 600;
}
/* 对齐 Jitsi Thumbnail 的 tile-view-mode 底部容器和 indicatorsBackground。 */
.polling-card-bottom { position: absolute; left: 0; bottom: 0; width: 100%; padding: 16px; box-sizing: border-box; display: flex; }
.polling-participant-info {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--bg-2);
  color: var(--text-hi);
  font-size: 14px;
  line-height: 20px;
}
.polling-card-indicator { display: flex; flex: 0 0 auto; pointer-events: auto; }
.polling-card-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
