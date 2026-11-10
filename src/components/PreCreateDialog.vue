<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { PREJOIN_ENABLED, generateMeetingId, generateNumericPassword } from '../utils/jitsi'
import { generateHostKey } from '../utils/hostKey'
import { getUser } from '../stores/user'

const props = withDefaults(defineProps<{ open: boolean; variant?: 'web' | 'desktop' }>(), {
  variant: 'web',
})
const emit = defineEmits<{
  close: []
  schedule: [
    payload: {
      roomName: string
      subject: string
      date: string
      time: string
      durationMin: number
      password: string
      displayName: string
      hostKey: string
      join: boolean
    },
  ]
}>()

const form = reactive({
  subject: '',
  displayName: '',
  date: '',
  time: '',
  durationMin: 60,
  passwordEnabled: false,
  password: '',
  passwordVisible: false,
})

// 主持人密钥：打开弹窗时生成一次（与会议号绑定，预定后随会议记录保存）
const hostKey = ref('')
const copied = ref(false)
const openSelect = ref<'time' | 'duration' | null>(null)
let copyTimer: number | undefined

const subjectId = 'precreate-subject'
const nameId = 'precreate-displayname'
const dateId = 'precreate-date'
const timeId = 'precreate-time'
const pwdId = 'precreate-pwd'
const durationId = 'precreate-duration'

const timeOptions = Array.from({ length: 96 }, (_, index) => {
  const minutes = index * 15
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

const durationOptions = [
  {
    value: 15,
    label: '15分钟',
  },
  {
    value: 30,
    label: '30分钟',
  },
  {
    value: 45,
    label: '45分钟',
  },
  {
    value: 60,
    label: '1小时',
  },
  {
    value: 120,
    label: '2小时',
  },
  {
    value: 180,
    label: '3小时',
  },
  {
    value: 240,
    label: '4小时',
  },
  {
    value: 300,
    label: '5小时',
  },
]

const canSubmit = computed(
  () =>
    (!form.passwordEnabled || !!form.password.trim()) &&
    !!form.date &&
    !!form.time &&
    form.durationMin >= 15 &&
    (!PREJOIN_ENABLED ? !!form.displayName.trim() : true),
)
const selectedDurationLabel = computed(() => durationOptions.find((option) => option.value === form.durationMin)?.label ?? '1小时')

/** 默认开始时间取下一刻钟；跨天时同步把日期推进到第二天。 */
function getDefaultScheduleStart(now: Date): { date: string; time: string } {
  const start = new Date(now)
  const nextQuarter = Math.ceil((start.getMinutes() + 1) / 15) * 15
  start.setMinutes(nextQuarter, 0, 0)
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
  const time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
  return { date, time }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      hostKey.value = generateHostKey()
      copied.value = false
      // 每次打开都读取最新用户名，保证预定会议默认昵称跟随设置面板。
      form.displayName = getUser()?.name ?? ''
      const start = getDefaultScheduleStart(new Date())
      form.date = start.date
      form.time = start.time
      form.durationMin = 60
      form.passwordEnabled = false
      form.passwordVisible = false
      openSelect.value = null
      if (!form.password) {
        form.password = generateNumericPassword(6)
      }
    }
  },
)

function rollPassword(): void {
  form.password = generateNumericPassword(6)
}

/** 切换自绘下拉面板，保证桌面端下拉高度和箭头位置不再受原生控件影响。 */
function toggleSelect(type: 'time' | 'duration'): void {
  openSelect.value = openSelect.value === type ? null : type
}

/** 点击表单其它区域时收起下拉面板，避免多个浮层同时停留。 */
function closeSelect(): void {
  openSelect.value = null
}

/** 选择开始时间后立即收起面板，时间选项固定按 15 分钟粒度生成。 */
function selectTime(time: string): void {
  form.time = time
  closeSelect()
}

/** 选择会议时长后立即收起面板，最长时长由 durationOptions 控制在 5 小时。 */
function selectDuration(durationMin: number): void {
  form.durationMin = durationMin
  closeSelect()
}

/** 勾选入会密码时自动补一个随机密码，让用户不用多点一次随机。 */
function onPasswordEnabledChange(): void {
  if (form.passwordEnabled) {
    rollPassword()
  } else {
    form.password = ''
  }
}

async function copyHostKey(): Promise<void> {
  try {
    await navigator.clipboard.writeText(hostKey.value)
    copied.value = true
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => (copied.value = false), 2000)
  } catch {
    /* 剪贴板不可用时忽略 */
  }
}

function submit(join: boolean): void {
  if (!canSubmit.value) {
    return
  }
  const roomName = generateMeetingId()
  emit('schedule', {
    roomName,
    subject: form.subject.trim() || '我的会议',
    date: form.date,
    time: form.time,
    durationMin: form.durationMin,
    password: form.passwordEnabled ? form.password.trim() : '',
    displayName: form.displayName.trim(),
    hostKey: hostKey.value,
    join,
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" :class="{ 'overlay--desktop': props.variant === 'desktop' }">
      <div
        class="modal"
        :class="{ 'modal--desktop': props.variant === 'desktop' }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="precreate-title"
        @click="closeSelect"
      >
        <div class="modal-head">
          <h2 class="modal-title" id="precreate-title">预定会议</h2>
          <button class="modal-close" aria-label="关闭" @click="emit('close')">✕</button>
        </div>
        <div class="modal-body" :class="{ 'modal-body--select-open': openSelect }">
          <div class="field" style="margin-bottom: 18px">
            <label :for="subjectId">{{ props.variant === 'desktop' ? '主题' : '会议主题（可选）' }}</label>
            <input :id="subjectId" v-model="form.subject" type="text" maxlength="40" placeholder="例如：项目周会" @keyup.enter="submit(true)" />
          </div>
          <!-- 只有 prejoin 关闭时系统才需要收集昵称；启用 prejoin 时由 Jitsi 自己的"用户名 + 加入"页收集 -->
          <div v-if="!PREJOIN_ENABLED" class="field" style="margin-bottom: 18px">
            <label :for="nameId">{{ props.variant === 'desktop' ? '昵称' : '你的昵称（进入会议后显示）' }}<span class="req">*</span></label>
            <input :id="nameId" v-model="form.displayName" type="text" maxlength="20" placeholder="你的姓名 / 昵称" @keyup.enter="submit(true)" />
          </div>
          <div class="field" style="margin-bottom: 18px">
            <label>{{ props.variant === 'desktop' ? '开始' : '会议时间' }}</label>
            <div class="dt-row">
              <input :id="dateId" v-model="form.date" type="date" />
              <div class="select-field select-field--time" @click.stop>
                <button
                  :id="timeId"
                  class="select-trigger"
                  :class="{ 'is-open': openSelect === 'time' }"
                  type="button"
                  aria-label="开始时间"
                  :aria-expanded="openSelect === 'time'"
                  @click="toggleSelect('time')"
                >
                  <span>{{ form.time }}</span>
                  <i aria-hidden="true"></i>
                </button>
                <div v-if="openSelect === 'time'" class="select-menu select-menu--time" role="listbox">
                  <button
                    v-for="time in timeOptions"
                    :key="time"
                    class="select-option"
                    :class="{ 'is-selected': time === form.time }"
                    type="button"
                    role="option"
                    :aria-selected="time === form.time"
                    @click="selectTime(time)"
                  >
                    {{ time }}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="field" style="margin-bottom: 18px">
            <label :for="durationId">{{ props.variant === 'desktop' ? '时长' : '会议时长（分钟）' }}</label>
            <div class="select-field" @click.stop>
              <button
                :id="durationId"
                class="select-trigger"
                :class="{ 'is-open': openSelect === 'duration' }"
                type="button"
                :aria-expanded="openSelect === 'duration'"
                @click="toggleSelect('duration')"
              >
                <span>{{ selectedDurationLabel }}</span>
                <i aria-hidden="true"></i>
              </button>
              <div v-if="openSelect === 'duration'" class="select-menu select-menu--duration" role="listbox">
                <button
                  v-for="option in durationOptions"
                  :key="option.value"
                  class="select-option"
                  :class="{ 'is-selected': option.value === form.durationMin }"
                  type="button"
                  role="option"
                  :aria-selected="option.value === form.durationMin"
                  @click="selectDuration(option.value)"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </div>
          <div class="field password-field" style="margin-bottom: 18px">
            <label>{{ props.variant === 'desktop' ? '安全' : '会议密码' }}</label>
            <div class="check-row">
              <input v-model="form.passwordEnabled" type="checkbox" @change="onPasswordEnabledChange" />
              <span>入会密码</span>
            </div>
            <div v-if="form.passwordEnabled" class="pwd-row password-detail">
              <input
                :id="pwdId"
                v-model="form.password"
                :type="form.passwordVisible ? 'text' : 'password'"
                maxlength="16"
                placeholder="6 位数字"
                @keyup.enter="submit(true)"
              />
              <button class="btn btn-ghost pwd-roll" type="button" @click="rollPassword" title="随机生成密码">随机</button>
              <button
                class="btn btn-ghost pwd-eye"
                type="button"
                @click="form.passwordVisible = !form.passwordVisible"
                :title="form.passwordVisible ? '隐藏密码' : '显示密码'"
              >
                {{ form.passwordVisible ? '🙈' : '👁' }}
              </button>
            </div>
          </div>
          <div class="field">
            <label>{{ props.variant === 'desktop' ? '密钥' : '主持人密钥（务必妥善保管，泄露等于主持人权限）' }}</label>
            <div class="host-key-row">
              <code class="host-key">{{ hostKey }}</code>
              <button class="btn btn-ghost host-key-copy" type="button" @click="copyHostKey">
                {{ copied ? '已复制 ✓' : '复制' }}
              </button>
            </div>
            <p class="hint">凭此密钥以主持人身份进入该会议（"我的预定"会自动使用；分享给他人后，对方在加入会议时填写密钥同样可以成为主持人）</p>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="emit('close')">取消</button>
          <button class="btn btn-secondary" :disabled="!canSubmit" @click="submit(false)">预定</button>
          <button class="btn btn-primary" :disabled="!canSubmit" @click="submit(true)">预定并加入</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dt-row {
  display: flex;
  gap: 8px;
}
.dt-row input,
.select-field {
  flex: 1;
}
.select-field {
  position: relative;
  min-width: 0;
}
.select-trigger {
  width: 100%;
  height: 47px;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: rgba(7, 10, 15, 0.6);
  color: var(--text-hi);
  font-family: inherit;
  font-size: 15px;
  text-align: left;
  padding: 0 34px 0 14px;
  cursor: pointer;
  outline: none;
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}
.select-trigger:focus,
.select-trigger.is-open {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.select-trigger i {
  position: absolute;
  right: 13px;
  top: 50%;
  width: 0;
  height: 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-top: 5px solid var(--accent);
  transform: translateY(-50%);
}
.select-trigger.is-open i {
  border-top: none;
  border-bottom: 5px solid var(--accent);
}
.select-menu {
  position: absolute;
  z-index: 5;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 220px;
  padding: 6px 0;
  overflow-y: auto;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel-solid);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.34);
}
.select-menu--time {
  height: 200px;
  max-height: 200px;
}
.select-menu--duration {
  max-height: none;
  overflow-y: visible;
}
.select-option {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--text-hi);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.select-option:hover,
.select-option.is-selected {
  background: rgba(35, 133, 232, 0.2);
  color: var(--text-hi);
}
.check-row {
  display: inline-flex !important;
  align-items: center !important;
  gap: 8px;
  min-height: 32px;
  margin: 0 !important;
  color: var(--text-hi) !important;
  font-size: 14px !important;
  font-weight: 500 !important;
  letter-spacing: 0 !important;
}
.check-row input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: #2385e8;
  cursor: pointer;
}
.pwd-row {
  display: flex;
  gap: 8px;
}
.pwd-row input {
  flex: 1;
}
.password-detail {
  grid-column: 2;
}
.pwd-roll,
.pwd-eye {
  padding: 0 14px;
  white-space: nowrap;
}
.host-key-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.host-key {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 10px;
  border-radius: var(--radius-md);
  border: 1px dashed rgba(56, 189, 248, 0.45);
  background: rgba(56, 189, 248, 0.06);
  font-family: var(--font-mono);
  font-size: 15px;
  letter-spacing: 0.08em;
  color: var(--accent);
  user-select: all;
}
.host-key-copy {
  padding: 0 16px;
  white-space: nowrap;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-low);
  line-height: 1.7;
}
.req {
  color: var(--danger);
  margin-left: 2px;
}

.overlay--desktop {
  align-items: center;
  justify-content: center;
  padding: 18px 20px;
  background: rgba(0, 0, 0, 0.38);
  backdrop-filter: none;
}

.modal--desktop {
  width: min(444px, calc(100vw - 40px));
  max-height: 600px;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  border-color: var(--line-strong);
  background: var(--panel-solid);
  box-shadow: var(--shadow-card);
  overflow: visible;
}

.modal--desktop .modal-head {
  flex: 0 0 auto;
  padding: 22px 24px 12px;
}

.modal--desktop .modal-title {
  font-size: 22px;
  color: var(--text-hi);
}

.modal--desktop .modal-close {
  position: absolute;
  right: 8px;
  top: 8px;
  color: var(--text-low);
}

.modal--desktop .modal-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px 24px 16px;
  overflow-y: auto;
}

.modal--desktop .modal-body--select-open {
  overflow-y: visible;
}

.modal--desktop .modal-foot {
  flex: 0 0 auto;
  padding: 16px 24px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: var(--panel-solid);
}

.modal--desktop .field {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  margin-bottom: 12px !important;
}

.modal--desktop .field label {
  min-height: 34px;
  display: flex;
  align-items: center;
  margin: 0;
  color: var(--text-hi);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0;
}

.modal--desktop .field input,
.modal--desktop .select-trigger {
  height: 34px;
  border-radius: 4px;
  background-color: var(--bg-1);
  color: var(--text-hi);
  padding-top: 0;
  padding-bottom: 0;
  font-size: 14px;
}

.modal--desktop .field input:focus,
.modal--desktop .select-trigger:focus,
.modal--desktop .select-trigger.is-open {
  border-color: #2588ff;
  box-shadow: 0 0 0 1px #2588ff;
}

.modal--desktop .select-trigger i {
  right: 12px;
}

.modal--desktop .select-menu {
  background: var(--panel-solid);
  border-color: rgba(255, 255, 255, 0.18);
}

.modal--desktop .dt-row,
.modal--desktop .pwd-row,
.modal--desktop .host-key-row {
  min-width: 0;
}

.modal--desktop .dt-row {
  gap: 8px;
}

.modal--desktop .hint {
  grid-column: 2;
  margin-top: -4px;
  color: var(--text-low);
  line-height: 1.45;
}

.modal--desktop .password-detail {
  margin-top: -4px;
}

.modal--desktop .check-row input {
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 3px;
}

.modal--desktop .pwd-roll,
.modal--desktop .pwd-eye,
.modal--desktop .host-key-copy {
  min-height: 34px;
  height: 34px;
  border-radius: 4px;
  padding: 0 12px;
}

.modal--desktop .host-key {
  min-height: 34px;
  border-radius: 4px;
  justify-content: flex-start;
  padding: 7px 10px;
  font-size: 13px;
  letter-spacing: 0.04em;
}

.modal--desktop .modal-foot .btn {
  height: 40px;
  min-width: 96px;
  border-radius: 4px;
  padding: 0 20px;
  font-size: 14px;
  font-weight: 500;
}

.modal--desktop .modal-foot .btn-primary {
  min-width: 126px;
  background: #2385e8;
  color: var(--text-hi);
  box-shadow: none;
}

.modal--desktop .modal-foot .btn-secondary {
  color: var(--text-hi);
  border-color: rgba(35, 133, 232, 0.55);
  background: rgba(35, 133, 232, 0.14);
}

.modal--desktop .modal-foot .btn-ghost {
  color: var(--text-hi);
  background: rgba(255, 255, 255, 0.06);
}
</style>
