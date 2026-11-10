<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import QRCode from 'qrcode'
import { buildInviteText, buildMeetingLink, formatMeetingId } from '../utils/jitsi'

const props = withDefaults(
  defineProps<{
    open: boolean
    roomName: string
    subject: string
    password: string
    variant?: 'web' | 'desktop'
  }>(),
  { variant: 'web' },
)

const emit = defineEmits<{ close: [] }>()

const isDesktop = () => props.variant === 'desktop'

const qrDataUrl = ref('')
const copied = ref('')

const meetingIdText = computed(() => formatMeetingId(props.roomName))
// 分享的"会议链接"指向【邀请中转页】，由中转页按平台唤起桌面端或回落到 Web 入会。
const link = computed(() => buildMeetingLink(props.roomName, props.subject))
// 邀请文案中的链接同样为前端地址，并根据是否设置密码生成不同加入提示
const inviteText = computed(() =>
  buildInviteText({
    subject: props.subject,
    roomName: props.roomName,
    password: props.password,
  }),
)

async function copy(text: string, key: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const el = document.createElement('textarea')
    el.value = text
    document.body.appendChild(el)
    el.select()
    document.execCommand('copy')
    el.remove()
  }
  copied.value = key
  setTimeout(() => (copied.value = ''), 1600)
}

onMounted(() => {
  QRCode.toDataURL(link.value, {
    width: 176,
    margin: 1,
    color: { dark: '#0c1017', light: '#f4f7fb' },
  }).then((url) => (qrDataUrl.value = url))
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" :class="{ 'overlay--desktop': isDesktop() }">
      <div class="modal" :class="{ 'modal--desktop': isDesktop() }" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div class="modal-head">
          <h2 class="modal-title" id="share-title">邀请参加会议</h2>
          <button class="modal-close" aria-label="关闭" @click="emit('close')">✕</button>
        </div>
        <div class="modal-body">
          <p class="subject">{{ subject || '我的会议' }}</p>

          <div class="id-box">
            <div class="id-box__label">会议号</div>
            <div class="id-box__value">{{ meetingIdText }}</div>
            <button class="btn btn-ghost id-box__copy" @click="copy(props.roomName, 'id')">
              {{ copied === 'id' ? '已复制 ✓' : '复制' }}
            </button>
          </div>

          <div v-if="password" class="pwd-box">
            <div class="pwd-box__label">密码</div>
            <div class="pwd-box__value">{{ password }}</div>
            <button class="btn btn-ghost pwd-box__copy" @click="copy(props.password, 'pwd')">
              {{ copied === 'pwd' ? '已复制 ✓' : '复制' }}
            </button>
          </div>
          <div v-else class="pwd-box pwd-box--empty">
            <div class="pwd-box__label">密码</div>
            <div class="pwd-box__value">未设置</div>
          </div>

          <div class="link-box">
            <div class="link-box__label">会议链接</div>
            <div class="link-box__row">
              <span class="link-box__value">{{ link }}</span>
              <button class="btn btn-ghost" @click="copy(link, 'link')">
                {{ copied === 'link' ? '已复制 ✓' : '复制' }}
              </button>
            </div>
          </div>

          <div class="invite-row">
            <div class="qr" v-if="qrDataUrl">
              <img :src="qrDataUrl" alt="会议链接二维码" />
              <span>扫码入会</span>
            </div>
            <button class="btn btn-primary invite-btn" @click="copy(inviteText, 'all')">
              {{ copied === 'all' ? '已复制邀请信息 ✓' : '复制完整邀请信息' }}
            </button>
          </div>

          <p class="tips">
            {{ password ? '参会人打开链接输入密码即可直接进入会议，或凭“会议号 + 密码”加入' : '参会人打开链接即可进入会议，或凭会议号加入' }}
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 桌面端：跟随"预定会议"弹窗的紧凑深色视觉 */
.modal--desktop .id-box,
.modal--desktop .pwd-box {
  border-radius: 4px;
  padding: 10px 12px;
  gap: 10px;
  margin-bottom: 10px;
}

.modal--desktop .id-box {
  border-color: rgba(35, 133, 232, 0.35);
  background: rgba(35, 133, 232, 0.1);
}

.modal--desktop .id-box__value {
  font-size: 22px;
}

.modal--desktop .link-box__value {
  border-radius: 4px;
  border-color: rgba(255, 255, 255, 0.16);
  background: var(--bg-1);
  color: #fff;
  padding: 8px 11px;
}

.modal--desktop .id-box__copy,
.modal--desktop .pwd-box__copy,
.modal--desktop .link-box__row .btn {
  min-height: 30px;
  padding: 0 12px;
  border-radius: 4px;
  font-size: 13px;
}

.modal--desktop .invite-btn {
  background: #2385e8;
  color: #fff;
  box-shadow: none;
  border-radius: 4px;
}

.modal--desktop .qr img {
  width: 84px;
  height: 84px;
  border-radius: 8px;
}

.modal--desktop .tips {
  color: var(--text-low);
}

.subject {
  margin: 0 0 16px;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-hi);
}
.id-box,
.pwd-box {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  margin-bottom: 12px;
}
.id-box {
  background: linear-gradient(180deg, rgba(56, 189, 248, 0.1), rgba(56, 189, 248, 0.03));
  border-color: rgba(56, 189, 248, 0.3);
}
.id-box__label,
.pwd-box__label {
  font-size: 12.5px;
  color: var(--text-mid);
  flex-shrink: 0;
}
.id-box__value {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--text-hi);
  flex: 1;
  font-variant-numeric: tabular-nums;
}
.pwd-box__value {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--warn);
  flex: 1;
}
.pwd-box--empty .pwd-box__value {
  letter-spacing: 0;
  color: var(--text-mid);
}
.id-box__copy,
.pwd-box__copy {
  padding: 8px 14px;
  font-size: 13px;
}
.link-box {
  margin-bottom: 14px;
}
.link-box__label {
  font-size: 12.5px;
  color: var(--text-mid);
  margin-bottom: 7px;
}
.link-box__row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.link-box__value {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-mid);
  word-break: break-all;
  background: rgba(7, 10, 15, 0.6);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.link-box__row .btn {
  padding: 10px 14px;
  font-size: 13px;
}
.invite-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.qr img {
  width: 88px;
  height: 88px;
  border-radius: 10px;
  background: #f4f7fb;
  padding: 4px;
}
.qr span {
  font-size: 11px;
  color: var(--text-low);
}
.invite-btn {
  flex: 1;
}
.tips {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--text-low);
}
</style>
