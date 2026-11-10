<script setup lang="ts">
import { reactive, watch } from 'vue'
import { PREJOIN_ENABLED, generateMeetingId, generatePassword } from '../utils/jitsi'
import { getUser } from '../stores/user'

const props = withDefaults(defineProps<{ open: boolean; variant?: 'web' | 'desktop' }>(), {
  variant: 'web',
})
const emit = defineEmits<{
  close: []
  create: [payload: { roomName: string; subject: string; password: string; displayName: string }]
}>()

const isDesktop = () => props.variant === 'desktop'

const form = reactive({
  subject: '',
  displayName: '',
  password: '',
  passwordVisible: false,
})

// 打开弹窗时把已设置的用户名预填到昵称（可修改），避免重复输入
watch(
  () => props.open,
  (open) => {
    if (open) {
      // 快速会议每次都是新的临时会议，主题输入框不能沿用上一次关闭弹窗前的内容。
      form.subject = ''
      // 每次打开都读取最新用户名，保证设置面板改名后默认昵称立即生效。
      form.displayName = getUser()?.name ?? ''
    }
  },
)

const subjectId = 'create-subject'
const nameId = 'create-displayname'
const passwordId = 'create-password'

function rollPassword(): void {
  form.password = generatePassword(6)
}

function submit(): void {
  if (!PREJOIN_ENABLED && !form.displayName.trim()) {
    return
  }
  const roomName = generateMeetingId()
  const subject = form.subject.trim() || '我的会议'
  // 密码允许留空：留空时主持人不会下发房间密码，会议按无密码房间创建。
  emit('create', {
    roomName,
    subject,
    password: form.password.trim(),
    displayName: form.displayName.trim(),
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" :class="{ 'overlay--desktop': isDesktop() }">
      <div class="modal" :class="{ 'modal--desktop': isDesktop() }" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <div class="modal-head">
          <h2 class="modal-title" id="create-title">创建会议</h2>
          <button class="modal-close" aria-label="关闭" @click="emit('close')">✕</button>
        </div>
        <div class="modal-body">
          <div class="field" style="margin-bottom: 18px">
            <label :for="subjectId">{{ isDesktop() ? '主题' : '会议主题（可选）' }}</label>
            <input :id="subjectId" v-model="form.subject" type="text" maxlength="40" placeholder="例如：项目周会" @keyup.enter="submit" />
          </div>
          <!-- 只有 prejoin 关闭时系统才需要收集昵称；启用 prejoin 时由 Jitsi 自己的"用户名 + 加入"页收集 -->
          <div v-if="!PREJOIN_ENABLED" class="field" style="margin-bottom: 18px">
            <label :for="nameId">{{ isDesktop() ? '昵称' : '你的昵称（进入会议后显示）' }}<span class="req">*</span></label>
            <input :id="nameId" v-model="form.displayName" type="text" maxlength="20" placeholder="你的姓名 / 昵称" @keyup.enter="submit" />
            <p class="hint">必填，参会人列表中将以此显示</p>
          </div>
          <div class="field">
            <label :for="passwordId">{{ isDesktop() ? '密码' : '会议密码（可选）' }}</label>
            <div class="pwd-row">
              <input
                :id="passwordId"
                v-model="form.password"
                :type="form.passwordVisible ? 'text' : 'password'"
                maxlength="16"
                :placeholder="isDesktop() ? '6 位数字，可留空' : '留空则不设置密码'"
                @keyup.enter="submit"
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
            <p class="hint">留空可创建无密码会议；点击“随机”可生成有密码会议</p>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="emit('close')">取消</button>
          <button class="btn btn-primary" :disabled="!PREJOIN_ENABLED && !form.displayName.trim()" @click="submit">创建并进入</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pwd-row {
  display: flex;
  gap: 8px;
}
.pwd-row input {
  flex: 1;
}
.pwd-roll,
.pwd-eye {
  padding: 0 14px;
  white-space: nowrap;
}
.hint {
  font-size: 12px;
  color: var(--text-low);
}
.req {
  color: var(--danger);
  margin-left: 2px;
}
</style>
