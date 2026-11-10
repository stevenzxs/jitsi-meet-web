<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import CreateDialog from '../components/CreateDialog.vue'
import JoinDialog from '../components/JoinDialog.vue'
import PreCreateDialog from '../components/PreCreateDialog.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ParticleBackground from '../components/ParticleBackground.vue'
import { listScheduled, saveSession } from '../stores/meeting'
import type { ScheduledMeeting } from '../stores/meeting'
import { cancelScheduledMeeting, createInstantMeeting, fetchScheduledMeetings, saveScheduledMeeting } from '../api/meetingApi'
import { generateHostKey } from '../utils/hostKey'
import { JITSI_SERVER, PREJOIN_ENABLED, buildInviteText, formatMeetingId, sanitizeMeetingId } from '../utils/jitsi'
import { getCreatorIds, getUser } from '../stores/user'

const router = useRouter()

const currentUser = getUser()

const showCreate = ref(false)
const showJoin = ref(false)
const showSchedule = ref(false)
const quickId = ref('')
// 快速加入时预填到"加入会议"窗口的会议号（prejoin 关闭时昵称必填，先转去填昵称+密码）
const joinInitRoom = ref('')
// 我的预定列表（localStorage），只展示当前用户创建的会议
const scheduled = ref<ScheduledMeeting[]>(
  currentUser ? listScheduled().filter((m) => getCreatorIds(currentUser).includes(m.creatorId ?? '')) : [],
)
const copiedRoom = ref('')
let copyTimer: number | undefined
// 取消预定确认框：点"取消会议"时弹出（替代原生 confirm）
const confirmTarget = ref<ScheduledMeeting | null>(null)

/** 从服务端刷新预定会议；后端不可用时 meetingApi 会回退到本机缓存 */
async function refreshScheduled(): Promise<void> {
  scheduled.value = await fetchScheduledMeetings(getCreatorIds(currentUser))
}

onMounted(() => {
  void refreshScheduled()
})

async function doCancelScheduled(): Promise<void> {
  if (!confirmTarget.value) return
  try {
    await cancelScheduledMeeting(confirmTarget.value.roomName, confirmTarget.value.creatorId || currentUser?.userId, confirmTarget.value.hostKey)
  } catch (error) {
    window.alert((error as Error).message || '取消会议失败，请稍后重试')
    return
  }
  confirmTarget.value = null
  await refreshScheduled()
}

// 创建会议：同步生成 hostKey，确保 auto-owner 关闭后仍能带 JWT 进入并获得主持人权限。
async function onCreate(payload: { roomName: string; subject: string; password: string; displayName: string }): Promise<void> {
  const hostKey = generateHostKey()
  await createInstantMeeting({
    roomName: payload.roomName,
    subject: payload.subject,
    password: payload.password,
    displayName: payload.displayName,
    hostKey,
    creatorId: currentUser?.userId ?? '',
  })
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
  router.push({ name: 'meeting', params: { roomName: payload.roomName } })
}

// 会议结束时间戳由创建/预定流程统一写入，避免不同入口重复推算产生偏差。
function endOf(m: ScheduledMeeting): number {
  return m.endTime
}

function isExpired(m: ScheduledMeeting): boolean {
  return Date.now() >= endOf(m)
}

function formatEndTime(m: ScheduledMeeting): string {
  const d = new Date(endOf(m))
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 预定会议：写入预定列表；join=true 时以主持人身份进入
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
    creatorId: currentUser?.userId ?? '',
    createdAt: Date.now(),
  }
  await saveScheduledMeeting(meeting)
  scheduled.value = listScheduled()
  showSchedule.value = false
  if (!payload.join) {
    void refreshScheduled()
    return // 仅预定：留在首页，稍后可从"我的预定会议"以主持人身份进入
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
  router.push({ name: 'meeting', params: { roomName: payload.roomName } })
  void refreshScheduled()
}

// 从预定列表进入会议：有 hostKey 时向服务端换取主持人 JWT，以主持人身份入会。
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
    endTime: endOf(m),
  })
  router.push({ name: 'meeting', params: { roomName: m.roomName } })
}

async function copyInvite(m: ScheduledMeeting): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildInviteText({ subject: m.subject, roomName: m.roomName, password: m.password }))
    copiedRoom.value = m.roomName
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copiedRoom.value = ''), 2000)
  } catch {
    /* 剪贴板不可用时忽略 */
  }
}

function cancelScheduled(m: ScheduledMeeting): void {
  confirmTarget.value = m
}

// 加入会议（首页"加入会议"窗口）：填了主持人密钥则以主持人身份进入（host: true + hostKey），否则为参会人
function onJoin(payload: { roomName: string; password: string; displayName: string; hostKey: string }): void {
  const hostKey = payload.hostKey.trim()
  saveSession({
    roomName: payload.roomName,
    subject: '',
    password: payload.password,
    displayName: payload.displayName,
    createdAt: Date.now(),
    host: !!hostKey,
    ...(hostKey ? { hostKey } : {}),
  })
  showJoin.value = false
  router.push({ name: 'meeting', params: { roomName: payload.roomName } })
}

function onQuickId(): void {
  quickId.value = sanitizeMeetingId(quickId.value, 9)
  if (quickId.value.length !== 9) {
    return
  }
  if (PREJOIN_ENABLED) {
    // prejoin 开启：昵称由 Jitsi 自己的 prejoin 页收集，可直接入会
    onJoin({ roomName: quickId.value, password: '', displayName: '', hostKey: '' })
  } else {
    // prejoin 关闭：昵称必填，快速加入转到"加入会议"窗口预填会议号，填昵称+密码后入会
    joinInitRoom.value = quickId.value
    showJoin.value = true
  }
}

const metrics = [
  { value: '99.99%', label: '服务可用性', sub: 'SLA · 自建节点' },
  { value: '≤100ms', label: '平均延迟', sub: '端到端实时传输' },
  { value: '4K', label: '超清画质', sub: '视频 · 屏幕共享' },
  { value: 'E2E', label: '端到端加密', sub: '数据不出内网' },
]
</script>

<template>
  <div class="home">
    <ParticleBackground />
    <div class="bg-grid"></div>
    <div class="bg-glow bg-glow--a"></div>
    <div class="bg-glow bg-glow--b"></div>
    <div class="bg-beam"></div>

    <header class="nav">
      <div class="brand">
        <div class="brand__mark"><span></span><span></span><span></span><span></span></div>
        <div class="brand__text">
          <div class="brand__name">云会议</div>
          <div class="brand__sub">CLOUDMEET · PRIVATE CORE</div>
        </div>
      </div>
      <div class="nav__right">
        <div class="chip" :title="JITSI_SERVER">
          <span class="chip__dot chip__dot--live"></span>
          <span class="chip__label">核心节点在线</span>
          <span class="chip__host">{{ JITSI_SERVER.replace(/^https?:\/\//, '') }}</span>
        </div>
        <div class="chip">
          <svg class="chip__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          <span class="chip__label">E2E 加密</span>
        </div>
      </div>
    </header>

    <main class="hero">
      <span class="hero__side" aria-hidden="true">CLOUDMEET&nbsp;//&nbsp;V3.0</span>

      <section class="hero__copy">
        <p class="hero__eyebrow">
          <span class="hero__eyebrow-line"></span>
          ENCRYPTED&nbsp;·&nbsp;PRIVATE&nbsp;·&nbsp;NO-CLIENT
          <span class="hero__cursor">▌</span>
        </p>
        <h1 class="hero__title">
          开启你的
          <span class="hero__accent">
            专属会议室
            <span class="hero__accent-bar"></span>
          </span>
        </h1>
        <p class="hero__desc">新一代企业级音视频会议平台。端到端加密 · 数据全程留在你的内网。 创建会议、设置密码、一键邀请。</p>
        <div class="hero__actions">
          <button class="btn btn-primary hero__create" @click="showCreate = true">
            <svg class="btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            创建会议
          </button>
          <button class="btn btn-ghost hero__schedule" @click="showSchedule = true">
            <svg
              class="btn__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d="M8 3v4M16 3v4M3 10h18" />
            </svg>
            预定会议
          </button>
          <button class="btn btn-ghost hero__join" @click="showJoin = true">
            <svg
              class="btn__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M15 12h6m0 0-3-3m3 3-3 3" />
              <path d="M4 18a8 8 0 0 1 8-8h4" />
            </svg>
            加入会议
          </button>
        </div>
        <ul class="hero__points">
          <li><span class="ok">✓</span> 浏览器即用，无需安装客户端</li>
          <li><span class="ok">✓</span> 会议密码保护，防止陌生人闯入</li>
          <li><span class="ok">✓</span> 屏幕共享 · 录制 · 聊天 · 白板</li>
        </ul>
      </section>

      <section class="hero__panel">
        <div class="orbit orbit--outer"></div>
        <div class="orbit orbit--inner"></div>
        <div class="quick-card">
          <div class="quick-card__hud">
            <span>QUICK&nbsp;START&nbsp;//&nbsp;01</span>
            <span class="quick-card__hud-right">NODE&nbsp;CONNECTED</span>
          </div>
          <div class="quick-card__top">
            <h2 class="quick-card__title">快速加入</h2>
            <div class="quick-card__qr" title="扫码进入会议">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <path d="M14 14h3v3h-3zM21 14v3M14 21h3v-3M21 17v4" />
              </svg>
            </div>
          </div>
          <p class="quick-card__desc">
            {{ PREJOIN_ENABLED ? '输入 9 位会议号，直接进入会议' : '输入 9 位会议号，填写昵称与密码后进入' }}
          </p>
          <div class="quick-card__row">
            <div class="field quick-card__field">
              <input
                v-model="quickId"
                type="text"
                inputmode="numeric"
                :placeholder="formatMeetingId('123456789')"
                @input="onQuickId"
                @keyup.enter="onQuickId"
              />
            </div>
            <button class="btn btn-primary" :disabled="quickId.length !== 9" @click="onQuickId">加入</button>
          </div>
          <div class="quick-card__divider">
            <span>或</span>
          </div>
          <button class="btn btn-ghost quick-card__open" @click="showJoin = true">打开加入窗口，输入密码</button>
        </div>
        <p class="hero__footnote">首次加入如遇摄像头 / 麦克风不可用，请在地址栏 🔒 中允许本站权限。</p>
      </section>
    </main>

    <section v-if="scheduled.length" class="scheduled">
      <div class="scheduled__head">
        <h3 class="scheduled__title">我的预定会议</h3>
        <span class="scheduled__hint">主持人凭已保存的主密钥以主持人身份进入；他人用邀请信息中的密码以参会人身份加入</span>
      </div>
      <div class="scheduled__grid">
        <div v-for="m in scheduled" :key="m.roomName" class="scheduled-card" :class="{ 'scheduled-card--expired': isExpired(m) }">
          <div class="scheduled-card__top">
            <div class="scheduled-card__title">{{ m.subject }}</div>
            <div class="scheduled-card__time">{{ m.date.slice(5).replace('-', '/') }} {{ m.time }} ~ {{ formatEndTime(m) }}</div>
          </div>
          <div class="scheduled-card__id">会议号 {{ formatMeetingId(m.roomName) }}</div>
          <div class="scheduled-card__actions">
            <button class="btn btn-primary scheduled-card__enter" :disabled="isExpired(m)" @click="enterScheduled(m)">
              {{ isExpired(m) ? '已结束' : '进入会议' }}
            </button>
            <button class="btn btn-ghost" @click="copyInvite(m)">
              {{ copiedRoom === m.roomName ? '已复制 ✓' : '复制邀请' }}
            </button>
            <button class="btn btn-ghost scheduled-card__cancel" @click="cancelScheduled(m)">取消</button>
          </div>
        </div>
      </div>
    </section>

    <section class="metrics">
      <div v-for="m in metrics" :key="m.label" class="metric">
        <div class="metric__value">{{ m.value }}</div>
        <div class="metric__label">{{ m.label }}</div>
        <div class="metric__sub">{{ m.sub }}</div>
      </div>
    </section>

    <CreateDialog :open="showCreate" @close="showCreate = false" @create="onCreate" />
    <JoinDialog :open="showJoin" :initial-room="joinInitRoom" @close="showJoin = false" @join="onJoin" />
    <PreCreateDialog :open="showSchedule" @close="showSchedule = false" @schedule="onSchedule" />

    <ConfirmDialog
      :open="!!confirmTarget"
      title="取消预定会议"
      :message="confirmTarget ? `确定取消「${confirmTarget.subject}」吗？取消后该会议不再出现在你的列表中，已保存的主持人入口也会随之失效。` : ''"
      confirm-text="确认取消"
      @confirm="doCancelScheduled"
      @cancel="confirmTarget = null"
    />
  </div>
</template>

<style scoped>
.home {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

/* ===== 背景 ===== */
.bg-grid {
  position: fixed;
  inset: 0;
  z-index: -2;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 163, 184, 0.05) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(ellipse 90% 75% at 50% 28%, black 35%, transparent 100%);
  pointer-events: none;
}
.bg-glow {
  position: fixed;
  border-radius: 50%;
  filter: blur(90px);
  z-index: -2;
  pointer-events: none;
}
.bg-glow--a {
  width: 560px;
  height: 560px;
  top: -160px;
  right: -80px;
  background: radial-gradient(circle, rgba(14, 165, 233, 0.16), transparent 65%);
  animation: glow-drift 11s ease-in-out infinite;
}
.bg-glow--b {
  width: 640px;
  height: 640px;
  bottom: -260px;
  left: -140px;
  background: radial-gradient(circle, rgba(59, 130, 246, 0.13), transparent 65%);
  animation: glow-drift 14s ease-in-out infinite reverse;
}
.bg-beam {
  position: fixed;
  inset: -20%;
  z-index: -2;
  pointer-events: none;
  background: linear-gradient(
    115deg,
    transparent 42%,
    rgba(56, 189, 248, 0.045) 47%,
    rgba(125, 211, 252, 0.07) 50%,
    rgba(56, 189, 248, 0.045) 53%,
    transparent 58%
  );
  animation: beam-sweep 9s ease-in-out infinite;
}

/* ===== 导航 ===== */
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 26px 44px;
  animation: rise 0.6s var(--ease-out) both;
}
.brand {
  display: flex;
  align-items: center;
  gap: 13px;
}
.brand__mark {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: linear-gradient(140deg, #0ea5e9, #38bdf8 55%, #7dd3fc);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 9px;
  box-shadow: 0 8px 22px -8px var(--accent-glow);
  animation: mark-pulse 3.4s ease-in-out infinite;
}
.brand__mark span {
  background: var(--panel-solid);
  border-radius: 4px;
}
.brand__name {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.04em;
}
.brand__sub {
  font-size: 10.5px;
  color: var(--text-low);
  margin-top: 3px;
  letter-spacing: 0.24em;
  font-family: var(--font-mono);
}
.nav__right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-mid);
  background: rgba(148, 163, 184, 0.06);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 8px 16px;
  letter-spacing: 0.03em;
}
.chip__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.chip__dot--live {
  background: var(--ok);
  box-shadow: 0 0 10px rgba(52, 211, 153, 0.9);
  animation: pulse 2.2s ease-in-out infinite;
}
.chip__icon {
  width: 13px;
  height: 13px;
  color: var(--ok);
  flex-shrink: 0;
}
.chip__host {
  color: var(--text-low);
  font-family: var(--font-mono);
  font-size: 11.5px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== 主区 ===== */
.hero {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(380px, 0.8fr);
  align-items: center;
  gap: 64px;
  padding: 24px 10vw 32px;
  max-width: 1360px;
  width: 100%;
  margin: 0 auto;
}
.hero__side {
  position: absolute;
  left: 2.2vw;
  top: 50%;
  transform: translateY(-50%) rotate(180deg);
  writing-mode: vertical-rl;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.5em;
  color: rgba(148, 163, 184, 0.28);
  user-select: none;
  animation: rise 0.9s var(--ease-out) 0.2s both;
}

.hero__copy {
  animation: rise 0.7s var(--ease-out) both;
}
.hero__eyebrow {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 24px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.28em;
  color: var(--accent);
}
.hero__eyebrow-line {
  width: 46px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent));
}
.hero__cursor {
  animation: blink 1.1s steps(2, start) infinite;
  font-weight: 400;
}
.hero__title {
  margin: 0 0 24px;
  font-family: var(--font-display);
  font-size: clamp(46px, 6.6vw, 84px);
  font-weight: 800;
  line-height: 1.14;
  letter-spacing: 0;
}
.hero__accent {
  color: transparent;
  background: linear-gradient(92deg, #7dd3fc, #38bdf8 30%, #818cf8 55%, #38bdf8 80%, #7dd3fc);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  position: relative;
  white-space: nowrap;
  filter: drop-shadow(0 0 28px rgba(56, 189, 248, 0.35));
  animation: hue-flow 7s linear infinite;
}
.hero__accent-bar {
  position: absolute;
  left: 0;
  bottom: 4px;
  height: 8px;
  width: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, rgba(56, 189, 248, 0.5), rgba(99, 102, 241, 0.5));
  z-index: -1;
  opacity: 0.32;
  animation: bar-scan 4.5s ease-in-out infinite;
}
.hero__desc {
  margin: 0 0 38px;
  max-width: 560px;
  font-size: 16.5px;
  line-height: 2;
  color: var(--text-mid);
  letter-spacing: 0.01em;
}
.hero__actions {
  display: flex;
  gap: 16px;
  align-items: center;
}
.btn__icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}
.hero__create {
  padding: 17px 34px;
  font-size: 16.5px;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  position: relative;
  overflow: hidden;
  border-radius: 12px;
}
.hero__create::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 30%, rgba(255, 255, 255, 0.45) 50%, transparent 70%);
  transform: translateX(-120%);
  animation: sheen 3.6s ease-in-out infinite;
}
.hero__join {
  padding: 17px 30px;
  font-size: 15.5px;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  backdrop-filter: blur(8px);
  border-radius: 12px;
}
.hero__schedule {
  padding: 17px 26px;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  backdrop-filter: blur(8px);
  border-radius: 12px;
}
.hero__points {
  list-style: none;
  margin: 40px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.hero__points li {
  font-size: 14px;
  color: var(--text-mid);
  display: flex;
  align-items: center;
  gap: 10px;
  letter-spacing: 0.02em;
}
.ok {
  color: var(--ok);
  font-weight: 700;
}

/* ===== 快速加入面板 ===== */
.hero__panel {
  position: relative;
  animation: rise 0.7s var(--ease-out) 0.12s both;
}
.orbit {
  position: absolute;
  border-radius: 50%;
  pointer-events: none;
}
.orbit--outer {
  width: 520px;
  height: 520px;
  right: -110px;
  top: -140px;
  border: 1px dashed rgba(56, 189, 248, 0.16);
  animation: spin 42s linear infinite;
}
.orbit--inner {
  width: 360px;
  height: 360px;
  right: -30px;
  top: -40px;
  border: 1px solid rgba(99, 102, 241, 0.14);
  border-top-color: rgba(125, 211, 252, 0.5);
  border-right-color: rgba(129, 140, 248, 0.4);
  animation: spin 26s linear infinite reverse;
}
.quick-card {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 24px;
  padding: 30px 32px 32px;
  backdrop-filter: blur(16px);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
/* HUD 四角括号 */
.quick-card::before,
.quick-card::after {
  content: '';
  position: absolute;
  width: 24px;
  height: 24px;
  pointer-events: none;
}
.quick-card::before {
  top: 12px;
  left: 12px;
  border-top: 2px solid var(--accent);
  border-left: 2px solid var(--accent);
  opacity: 0.7;
}
.quick-card::after {
  bottom: 12px;
  right: 12px;
  border-bottom: 2px solid var(--accent);
  border-right: 2px solid var(--accent);
  opacity: 0.7;
}
.quick-card__hud {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.2em;
  color: var(--text-low);
  margin-bottom: 22px;
}
.quick-card__hud-right {
  color: rgba(52, 211, 153, 0.75);
  animation: pulse 2.4s ease-in-out infinite;
}
.quick-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.quick-card__title {
  margin: 0 0 8px;
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.quick-card__qr {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(148, 163, 184, 0.05);
  color: var(--text-mid);
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    color 0.18s ease,
    border-color 0.18s ease;
}
.quick-card__qr svg {
  width: 20px;
  height: 20px;
}
.quick-card__qr:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.quick-card__desc {
  margin: 0 0 24px;
  font-size: 14px;
  color: var(--text-mid);
}
.quick-card__row {
  display: flex;
  gap: 10px;
}
.quick-card__field {
  flex: 1;
  position: relative;
}
.quick-card__row input {
  letter-spacing: 0.14em;
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: 600;
  text-align: center;
  padding: 14px 8px;
  background: var(--bg-2);
  border-color: var(--line-strong);
}
/* 输入聚焦扫描线 */
.quick-card__field::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  height: 1.5px;
  bottom: 0;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity: 0;
  pointer-events: none;
}
.quick-card__field:focus-within::after {
  opacity: 1;
  animation: scan 1.6s ease-in-out infinite;
}
.quick-card__row .btn {
  padding: 14px 24px;
}
.quick-card__divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 24px 0;
  color: var(--text-low);
  font-size: 12.5px;
}
.quick-card__divider::before,
.quick-card__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}
.quick-card__open {
  width: 100%;
}
.hero__footnote {
  margin: 20px 4px 0;
  font-size: 12.5px;
  color: var(--text-low);
  line-height: 1.7;
}

/* ===== 我的预定会议 ===== */
.scheduled {
  max-width: 1360px;
  width: 100%;
  margin: 0 auto;
  padding: 0 10vw 40px;
  animation: rise 0.7s var(--ease-out) 0.2s both;
}
.scheduled__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.scheduled__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.scheduled__hint {
  font-size: 12px;
  color: var(--text-low);
}
.scheduled__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.scheduled-card {
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  padding: 18px 20px;
  backdrop-filter: blur(12px);
  transition:
    border-color 0.2s ease,
    transform 0.2s var(--ease-out);
}
.scheduled-card:hover {
  transform: translateY(-3px);
  border-color: rgba(56, 189, 248, 0.45);
}
.scheduled-card__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.scheduled-card__title {
  font-family: var(--font-display);
  font-size: 15.5px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scheduled-card__time {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-low);
}
.scheduled-card__id {
  margin: 8px 0 14px;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-mid);
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}
.scheduled-card__actions {
  display: flex;
  gap: 8px;
}
.scheduled-card__enter {
  flex: 1;
  padding: 9px 14px;
}
.scheduled-card__enter:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.scheduled-card--expired .scheduled-card__title {
  color: var(--text-low);
}
.scheduled-card--expired {
  opacity: 0.65;
}
.scheduled-card__cancel {
  color: var(--danger);
}

/* ===== 能力指标带 ===== */
.metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  max-width: 1360px;
  width: 100%;
  margin: 0 auto;
  padding: 0 10vw 40px;
  animation: rise 0.7s var(--ease-out) 0.2s both;
}
.metric {
  position: relative;
  text-align: center;
  padding: 20px 12px 18px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--panel);
  backdrop-filter: blur(10px);
  overflow: hidden;
  transition:
    border-color 0.2s ease,
    transform 0.2s var(--ease-out),
    box-shadow 0.2s ease;
}
.metric::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 60%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(125, 211, 252, 0.6), transparent);
  opacity: 0.5;
}
.metric:hover {
  transform: translateY(-4px);
  border-color: rgba(56, 189, 248, 0.45);
  box-shadow: 0 16px 40px -20px var(--accent-glow);
}
.metric__value {
  font-family: var(--font-mono);
  font-size: 26px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: transparent;
  background: linear-gradient(180deg, #eaf6ff, #7dd3fc 65%, #38bdf8);
  -webkit-background-clip: text;
  background-clip: text;
  line-height: 1.2;
}
.metric__label {
  margin-top: 8px;
  font-family: var(--font-display);
  font-size: 14.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.metric__sub {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-low);
  letter-spacing: 0.06em;
}

/* ===== 动效 ===== */
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(22px);
  }
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes glow-drift {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(30px, -20px) scale(1.08);
  }
}
@keyframes beam-sweep {
  0%,
  100% {
    transform: translateX(-35%);
  }
  50% {
    transform: translateX(35%);
  }
}
@keyframes hue-flow {
  to {
    background-position: 250% 0;
  }
}
@keyframes bar-scan {
  0%,
  100% {
    transform: scaleX(0.6);
    opacity: 0.25;
  }
  50% {
    transform: scaleX(1);
    opacity: 0.5;
  }
}
@keyframes sheen {
  0%,
  55% {
    transform: translateX(-120%);
  }
  75%,
  100% {
    transform: translateX(120%);
  }
}
@keyframes scan {
  0% {
    transform: translateY(0);
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  85% {
    opacity: 1;
  }
  100% {
    transform: translateY(-26px);
    opacity: 0;
  }
}
@keyframes mark-pulse {
  0%,
  100% {
    box-shadow: 0 8px 22px -8px var(--accent-glow);
  }
  50% {
    box-shadow: 0 8px 30px -6px rgba(56, 189, 248, 0.55);
  }
}

@media (max-width: 900px) {
  .hero {
    grid-template-columns: 1fr;
    gap: 36px;
    padding: 24px 6vw 28px;
  }
  .nav {
    padding: 18px 20px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .metrics {
    grid-template-columns: repeat(2, 1fr);
    padding: 0 6vw 40px;
  }
  .chip__host {
    display: none;
  }
  .orbit {
    display: none;
  }
  .hero__side {
    display: none;
  }
}
</style>
