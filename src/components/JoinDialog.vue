<script setup lang="ts">
import { reactive, watch } from 'vue'
import { PREJOIN_ENABLED, formatMeetingId, sanitizeMeetingId } from '../utils/jitsi'
import { getUser } from '../stores/user'

const props = withDefaults(defineProps<{ open: boolean; initialRoom?: string; variant?: 'web' | 'desktop'; loading?: boolean }>(), {
  variant: 'web',
  loading: false,
})
const emit = defineEmits<{
  close: []
  clearError: []
  join: [payload: { roomName: string; password: string; displayName: string; hostKey: string }]
}>()

const isDesktop = () => props.variant === 'desktop'

const HOST_KEY_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/

const form = reactive({
  roomName: '',
  displayName: '',
  password: '',
  hostKey: '',
  passwordVisible: false,
  hostKeyTouched: false,
})

const roomId = 'join-room'
const nameId = 'join-displayname'
const pwdId = 'join-pwd'
const hostKeyId = 'join-hostkey'

// 每次打开弹窗都重置一次临时入会字段；只有快速加入转入时才使用 initialRoom 预填会议号。
// 昵称仍优先使用桌面端保存的用户信息，避免用户重复输入自己的名字。
watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.roomName = props.initialRoom ? sanitizeMeetingId(props.initialRoom, 9) : ''
    // 每次打开都读取最新用户名，避免设置面板修改昵称后仍显示旧值。
    form.displayName = getUser()?.name ?? ''
    form.password = ''
    form.passwordVisible = false
    form.hostKey = ''
    form.hostKeyTouched = false
  },
)

// 手输会议号：必须读输入框的值，而不是 form.roomName（否则状态永远为空，加入按钮永远禁用）
function onRoomInput(event: Event): void {
  emit('clearError')
  form.roomName = sanitizeMeetingId((event.target as HTMLInputElement).value, 9)
}

/** 用户修改密码时清除上一次校验提示，避免新输入仍关联旧错误。 */
function onPasswordInput(): void {
  emit('clearError')
}

// 主持人密钥：只保留合法字符并按 XXXX-XXXX-XXXX-XXXX 分组
function onHostKeyInput(event: Event): void {
  emit('clearError')
  const raw = (event.target as HTMLInputElement).value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, '')
    .slice(0, 16)
  form.hostKey = raw.match(/.{4}/g)?.join('-') ?? ''
  form.hostKeyTouched = true
}

function hostKeyInvalid(): boolean {
  return form.hostKeyTouched && form.hostKey.length > 0 && !HOST_KEY_RE.test(form.hostKey)
}

function submit(): void {
  if (props.loading) return
  const roomName = form.roomName.trim()
  if (roomName.length !== 9 || !form.displayName.trim() || hostKeyInvalid()) {
    return
  }
  // prejoin 关闭时昵称由这里收集且必填（进入会议后在参会人列表中显示）
  emit('join', {
    roomName,
    password: form.password.trim(),
    displayName: form.displayName.trim(),
    hostKey: form.hostKey.trim(),
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" :class="{ 'overlay--desktop': isDesktop() }">
      <div class="modal" :class="{ 'modal--desktop': isDesktop() }" role="dialog" aria-modal="true" aria-labelledby="join-title">
        <div class="modal-head">
          <h2 class="modal-title" id="join-title">加入会议</h2>
          <button class="modal-close" aria-label="关闭" @click="emit('close')">✕</button>
        </div>
        <div class="modal-body">
          <div class="field" style="margin-bottom: 18px">
            <label :for="roomId">会议号</label>
            <input
              :id="roomId"
              :value="formatMeetingId(form.roomName)"
              type="text"
              inputmode="numeric"
              placeholder="请输入 9 位会议号"
              @input="onRoomInput"
              @keyup.enter="submit"
            />
            <p class="hint">会议号可从邀请信息中复制，共 9 位数字</p>
          </div>
          <!-- 只有 prejoin 关闭时系统才需要收集昵称；启用 prejoin 时由 Jitsi 自己的"用户名 + 加入"页收集 -->
          <div v-if="!PREJOIN_ENABLED" class="field" style="margin-bottom: 18px">
            <label :for="nameId">{{ isDesktop() ? '昵称' : '你的昵称（进入会议后显示）' }}<span class="req">*</span></label>
            <input :id="nameId" v-model="form.displayName" type="text" maxlength="20" placeholder="你的姓名 / 昵称" @keyup.enter="submit" />
            <p class="hint">必填，参会人列表中将以此显示</p>
          </div>
          <div class="field">
            <label :for="pwdId">{{ isDesktop() ? '密码' : '密码（选填，有密码的会议必填）' }}</label>
            <div class="pwd-row">
              <input
                :id="pwdId"
                v-model="form.password"
                :type="form.passwordVisible ? 'text' : 'password'"
                placeholder="会议密码"
                @input="onPasswordInput"
                @keyup.enter="submit"
              />
              <button
                class="btn btn-ghost pwd-eye"
                type="button"
                @click="form.passwordVisible = !form.passwordVisible"
                :title="form.passwordVisible ? '隐藏密码' : '显示密码'"
              >
                {{ form.passwordVisible ? '🙈' : '👁' }}
              </button>
            </div>
            <p class="hint">选填，会议有密码时需要输入</p>
          </div>
          <div class="field host-key-field">
            <label :for="hostKeyId">密钥</label>
            <input
              :id="hostKeyId"
              :value="form.hostKey"
              type="text"
              maxlength="19"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autocomplete="off"
              :aria-invalid="hostKeyInvalid()"
              @input="onHostKeyInput"
              @keyup.enter="submit"
            />
            <p class="hint" :class="{ 'hint--error': hostKeyInvalid() }">
              {{ hostKeyInvalid() ? '密钥格式为 XXXX-XXXX-XXXX-XXXX，请检查输入' : '选填，填写后以主持人身份加入' }}
            </p>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" :disabled="props.loading" @click="emit('close')">取消</button>
          <button
            class="btn btn-primary"
            :disabled="props.loading || form.roomName.length !== 9 || (!PREJOIN_ENABLED && !form.displayName.trim()) || hostKeyInvalid()"
            @click="submit"
          >
            <span v-if="props.loading" class="btn-spinner" aria-hidden="true"></span>
            <span>{{ props.loading ? '校验中…' : '加入会议' }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.host-key-field {
  margin-bottom: 0;
}

.hint--error {
  color: #f87171 !important;
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
.hint {
  font-size: 12px;
  color: var(--text-low);
}
.req {
  color: var(--danger);
  margin-left: 2px;
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.btn-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(4, 18, 29, 0.25);
  border-top-color: currentColor;
  animation: btn-spin 0.8s linear infinite;
}
@keyframes btn-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
