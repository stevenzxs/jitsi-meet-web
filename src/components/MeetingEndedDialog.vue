<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    durationSeconds?: number
  }>(),
  { durationSeconds: 0 },
)

const emit = defineEmits<{ close: [] }>()
const remainingSeconds = ref(5)
let countdownTimer: number | undefined

function clearCountdown(): void {
  if (countdownTimer !== undefined) {
    window.clearInterval(countdownTimer)
    countdownTimer = undefined
  }
}

/** 打开通知时启动 5 秒倒计时，倒计时结束后自动关闭，避免首页长期停留在遮罩层。 */
function startCountdown(): void {
  clearCountdown()
  remainingSeconds.value = 5
  countdownTimer = window.setInterval(() => {
    remainingSeconds.value -= 1
    if (remainingSeconds.value <= 0) {
      clearCountdown()
      emit('close')
    }
  }, 1000)
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      startCountdown()
    } else {
      clearCountdown()
    }
  },
  { immediate: true },
)

onBeforeUnmount(clearCountdown)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="meeting-ended-overlay" role="alertdialog" aria-modal="true" aria-labelledby="meeting-ended-title">
      <section class="meeting-ended-dialog">
        <h2 id="meeting-ended-title">主持人已结束会议</h2>
        <p class="meeting-ended-dialog__duration">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 7.5v5l3 1.8" />
          </svg>
          本次您共参会{{ Math.max(0, Math.round(props.durationSeconds)) }}秒
        </p>
        <button class="meeting-ended-dialog__confirm" type="button" @click="emit('close')">
          我知道了（{{ remainingSeconds }}s）
        </button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.meeting-ended-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: grid;
  place-items: center;
  background: rgba(15, 23, 42, 0.48);
}

.meeting-ended-dialog {
  width: min(630px, calc(100vw - 40px));
  min-height: 198px;
  box-sizing: border-box;
  padding: 28px 24px 18px;
  border: 1px solid rgba(148, 163, 184, 0.26);
  border-radius: 10px;
  background: var(--panel-solid, #ffffff);
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.28);
}

.meeting-ended-dialog h2 {
  margin: 22px 0 14px;
  color: var(--text-hi, #172033);
  font-size: 28px;
  font-weight: 600;
  line-height: 1.25;
}

.meeting-ended-dialog__duration {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0;
  color: var(--text-mid, #64748b);
  font-size: 16px;
}

.meeting-ended-dialog__duration svg {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
}

.meeting-ended-dialog__confirm {
  display: block;
  min-width: 165px;
  margin: 30px 0 0 auto;
  padding: 11px 18px;
  border: 0;
  border-radius: 8px;
  background: #1265ef;
  color: #ffffff;
  font: inherit;
  font-size: 16px;
  cursor: pointer;
}

.meeting-ended-dialog__confirm:hover {
  background: #0d57d5;
}
</style>
