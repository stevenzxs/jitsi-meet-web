<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { buildDesktopMeetingLink, formatMeetingId, sanitizeMeetingId } from '../utils/jitsi'

const route = useRoute()
const router = useRouter()

const hasTriedDesktop = ref(false)

const rawRoom = computed(() => String(route.query.room ?? ''))
const roomName = computed(() => sanitizeMeetingId(rawRoom.value, 9))
const subject = computed(() => String(route.query.subject ?? '').trim())
const desktopLink = computed(() => buildDesktopMeetingLink(roomName.value, subject.value))
const invalidInvite = computed(() => roomName.value.length !== 9)

/** 分享链接只允许走桌面客户端：浏览器打开邀请页后立即尝试唤起自定义协议，不提供 Web 入会入口。 */
function openDesktopApp(): void {
  if (invalidInvite.value) {
    router.replace('/')
    return
  }
  hasTriedDesktop.value = true
  window.location.href = desktopLink.value
}

onMounted(openDesktopApp)
</script>

<template>
  <main class="invite-page">
    <div class="invite-card">
      <div class="invite-card__hud">CLOUDMEET&nbsp;//&nbsp;INVITE</div>
      <h1 class="invite-card__title">正在打开桌面端</h1>
      <p class="invite-card__desc">
        {{ subject || '云会议邀请' }}
      </p>
      <div class="invite-card__room">
        <span>会议号</span>
        <strong>{{ formatMeetingId(roomName) || '无效邀请' }}</strong>
      </div>
      <p class="invite-card__hint">
        {{ hasTriedDesktop ? '已请求打开桌面客户端；如果浏览器拦截或你取消了系统弹窗，请点击下方按钮重新唤起。' : '会议需要使用桌面客户端加入。' }}
      </p>
      <div class="invite-card__actions">
        <a class="btn btn-primary" :href="desktopLink" @click="hasTriedDesktop = true">重新打开桌面端</a>
      </div>
    </div>
  </main>
</template>

<style scoped>
.invite-page {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 28px;
  background: radial-gradient(760px 420px at 50% 24%, rgba(56, 189, 248, 0.11), transparent 62%), var(--bg-0);
}

.invite-card {
  width: min(440px, 100%);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--panel);
  box-shadow: var(--shadow-card);
  padding: 30px;
  text-align: center;
}

.invite-card__hud {
  margin-bottom: 18px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.22em;
  color: var(--text-low);
}

.invite-card__title {
  margin: 0 0 10px;
  font-family: var(--font-display);
  font-size: 26px;
}

.invite-card__desc,
.invite-card__hint {
  margin: 0;
  color: var(--text-mid);
  line-height: 1.7;
}

.invite-card__room {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 22px 0;
  padding: 14px 16px;
  border: 1px solid rgba(56, 189, 248, 0.3);
  border-radius: var(--radius-md);
  background: rgba(56, 189, 248, 0.08);
}

.invite-card__room span {
  flex-shrink: 0;
  font-size: 12.5px;
  color: var(--text-mid);
}

.invite-card__room strong {
  min-width: 0;
  font-family: var(--font-display);
  font-size: 24px;
  letter-spacing: 0.1em;
  font-variant-numeric: tabular-nums;
}

.invite-card__actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  margin-top: 22px;
}

.invite-card__actions a {
  text-decoration: none;
}

@media (max-width: 520px) {
  .invite-card__actions {
    flex-direction: column;
  }
}
</style>
