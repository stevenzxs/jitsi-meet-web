<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { buildInviteText } from '../utils/jitsi'
import { copyInvitationText } from '../utils/invitationClipboard'

const props = defineProps<{ roomName: string; subject: string; password: string }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const status = ref('')
const copying = ref(false)
const inviteText = computed(() => buildInviteText({
  roomName: props.roomName, subject: props.subject, password: props.password,
}))
let previousFocus: HTMLElement | null = null

onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null
  dialog.value?.showModal()
})
onBeforeUnmount(() => {
  dialog.value?.close()
  previousFocus?.focus()
})

async function copyAll(): Promise<void> {
  if (copying.value) return
  copying.value = true
  status.value = ''
  try {
    await copyInvitationText(inviteText.value)
    status.value = '已复制全部邀请信息'
  } catch {
    status.value = '复制失败，请选中邀请内容手动复制'
  } finally {
    copying.value = false
  }
}
</script>

<template>
    <dialog ref="dialog" class="desktop-invite" aria-labelledby="desktop-invite-title" @cancel.prevent="emit('close')">
      <header class="desktop-invite__head">
        <h2 id="desktop-invite-title">邀请参加会议</h2>
        <button type="button" class="desktop-invite__close" aria-label="关闭邀请对话框" @click="emit('close')">✕</button>
      </header>
      <div class="desktop-invite__body">
        <pre class="desktop-invite__text" tabindex="0" aria-label="完整邀请内容">{{ inviteText }}</pre>
      </div>
      <footer class="desktop-invite__foot">
        <p role="status" aria-live="polite">{{ status }}</p>
        <button type="button" class="desktop-invite__copy" :disabled="copying" @click="copyAll">
          {{ copying ? '正在复制…' : '复制全部信息' }}
        </button>
      </footer>
    </dialog>
</template>

<style scoped>
.desktop-invite {
  width: min(520px, calc(100vw - 40px));
  max-height: calc(100dvh - 48px);
  box-sizing: border-box;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel-solid);
  color: var(--text-hi);
  box-shadow: var(--shadow-card);
}
.desktop-invite::backdrop { background: var(--overlay-bg); }
.desktop-invite__head { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--line); }
h2 { margin: 0; font-size: 18px; font-weight: 600; }
.desktop-invite__close { width: 36px; height: 36px; border: 0; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.desktop-invite__close:hover { background: var(--bg-2); }
.desktop-invite__body { padding: 20px 20px 0; }
.desktop-invite__text { margin: 0; padding: 16px; max-height: 45dvh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; font-size: 14px; line-height: 1.8; font-family: inherit; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; }
.desktop-invite__foot { padding: 12px 20px 20px; }
.desktop-invite__foot p { min-height: 22px; margin: 0 0 8px; font-size: 13px; color: var(--text-mid); }
.desktop-invite__copy { width: 100%; min-height: 42px; border: 0; border-radius: 6px; background: #2385e8; color: white; font-size: 14px; font-weight: 600; cursor: pointer; }
.desktop-invite__copy:hover { background: #1977d4; }
.desktop-invite__copy:disabled { opacity: .6; cursor: wait; }
button:focus-visible, pre:focus-visible { outline: 2px solid #82baff; outline-offset: 3px; }
</style>
