<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { JitsiMeetExternalAPI } from '../types/jitsi'
import { getPollingCandidates, getMeetingModeratorId, type PollingCandidate } from '../utils/pollingLayout'

const props = defineProps<{
  api: JitsiMeetExternalAPI | null
  /** 轮询是否正在运行（决定按钮组：开始轮询 / 保存设置＋停止轮询）。 */
  running: boolean
  /** 打开对话框时由父组件刷新好的当前主持人 id。 */
  moderatorId: string
  /** 已确认名单；空数组且 groupConfigured=false 表示首次打开。 */
  initialSelectedIds: string[]
  /** 名单是否已确认过（false=首次打开，默认全选在线非主持成员）。 */
  groupConfigured: boolean
  /** 视觉变体：desktop=跟随 Electron 外壳弹窗样式；默认 web。 */
  variant?: 'web' | 'desktop'
}>()

const isDesktop = () => props.variant === 'desktop'

const emit = defineEmits<{
  confirm: [ids: string[]]
  stop: []
  cancel: []
}>()

const loading = ref(true)
const loadError = ref('')
const hostName = ref('')
const candidates = ref<PollingCandidate[]>([])
// 草稿勾选：仅确认/开始时向外提交，取消无副作用。
const draftIds = ref<Set<string>>(new Set())

const selectedIds = computed(() =>
  candidates.value.filter((candidate) => draftIds.value.has(candidate.id)).map((candidate) => candidate.id),
)

function toggleCandidate(id: string): void {
  const next = new Set(draftIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  draftIds.value = next
}

onMounted(async () => {
  loading.value = true
  loadError.value = ''
  try {
    const moderatorId = props.moderatorId || getMeetingModeratorId(props.api)
    hostName.value = moderatorId
      ? (props.api?.getParticipantsInfo?.() ?? []).find(
          (participant) => String(participant.participantId || participant.id || '') === moderatorId,
        )?.displayName?.trim() || '主持人'
      : '主持人（未检测到）'
    candidates.value = await getPollingCandidates(props.api, moderatorId)
    if (!props.groupConfigured && !props.initialSelectedIds.length) {
      // 首次打开：默认勾选当时在线的非主持普通参会者。
      draftIds.value = new Set(candidates.value.map((candidate) => candidate.id))
    } else {
      const online = new Set(candidates.value.map((candidate) => candidate.id))
      draftIds.value = new Set(props.initialSelectedIds.filter((id) => online.has(id)))
    }
  } catch {
    loadError.value = '读取参会成员失败，请关闭后重试'
  } finally {
    loading.value = false
  }
})

function confirm(): void {
  emit('confirm', selectedIds.value)
}
</script>

<template>
  <div
    class="polling-dialog-layer"
    :class="{ 'polling-dialog-layer--desktop': isDesktop() }"
    @click.self="emit('cancel')"
  >
    <section
      class="polling-dialog"
      :class="{ 'polling-dialog--desktop': isDesktop() }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="polling-dialog-title"
      @click.stop
    >
      <header class="polling-dialog__head">
        <h3 id="polling-dialog-title">轮询设置</h3>
        <button class="polling-dialog__close" type="button" title="关闭" aria-label="关闭" @click="emit('cancel')">×</button>
      </header>

      <p class="polling-dialog__hint">左侧固定显示主持人视频；右侧按轮询时间逐个显示勾选的参会者。</p>

      <div class="polling-dialog__list">
        <div v-if="loading" class="polling-dialog__state">正在读取参会成员…</div>
        <div v-else-if="loadError" class="polling-dialog__state polling-dialog__state--error">{{ loadError }}</div>
        <template v-else>
          <div class="polling-dialog__row polling-dialog__row--host">
            <span class="polling-dialog__box polling-dialog__box--fixed">固定</span>
            <span class="polling-dialog__name">{{ hostName }}</span>
            <span class="polling-dialog__tag">左侧固定</span>
          </div>
          <label v-for="candidate in candidates" :key="candidate.id" class="polling-dialog__row">
            <input
              type="checkbox"
              :checked="draftIds.has(candidate.id)"
              @change="toggleCandidate(candidate.id)"
            />
            <span class="polling-dialog__name">{{ candidate.displayName }}</span>
            <span v-if="candidate.videoMuted" class="polling-dialog__muted">未开视频</span>
          </label>
          <div v-if="!candidates.length" class="polling-dialog__state">暂无可勾选的参会成员</div>
        </template>
      </div>

      <footer class="polling-dialog__actions">
        <template v-if="running">
          <button class="btn btn-ghost" type="button" @click="emit('stop')">停止轮询</button>
          <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
          <button class="btn btn-primary" type="button" :disabled="loading || Boolean(loadError)" @click="confirm">
            保存设置
          </button>
        </template>
        <template v-else>
          <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="loading || Boolean(loadError) || !selectedIds.length"
            @click="confirm"
          >
            开始轮询
          </button>
        </template>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.polling-dialog-layer {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(7, 12, 20, 0.55);
}

.polling-dialog {
  width: min(420px, calc(100vw - 48px));
  max-height: min(560px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: var(--panel-bg, #141c2b);
  border: 1px solid var(--line, rgba(148, 163, 184, 0.22));
  color: var(--text-hi, #e8eef8);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.polling-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px 10px;
}

.polling-dialog__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.polling-dialog__close {
  border: none;
  background: transparent;
  color: var(--text-mid, #9aa7ba);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 8px;
}

.polling-dialog__close:hover {
  background: rgba(148, 163, 184, 0.14);
  color: var(--text-hi, #e8eef8);
}

.polling-dialog__hint {
  margin: 0;
  padding: 0 18px 10px;
  font-size: 12px;
  color: var(--text-mid, #9aa7ba);
}

.polling-dialog__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.polling-dialog__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13.5px;
}

.polling-dialog__row:hover {
  background: rgba(148, 163, 184, 0.1);
}

.polling-dialog__row--host {
  cursor: default;
  color: var(--text-mid, #9aa7ba);
}

.polling-dialog__box {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  accent-color: var(--accent, #38bdf8);
}

.polling-dialog__box--fixed {
  width: auto;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(56, 189, 248, 0.14);
  color: var(--accent, #38bdf8);
}

.polling-dialog__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.polling-dialog__tag {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--accent, #38bdf8);
}

.polling-dialog__muted {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-low, #6b7889);
}

.polling-dialog__state {
  padding: 22px 10px;
  text-align: center;
  font-size: 13px;
  color: var(--text-mid, #9aa7ba);
}

.polling-dialog__state--error {
  color: var(--danger, #ef4444);
}

.polling-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--line, rgba(148, 163, 184, 0.16));
}

/* ---------- 桌面壳（Electron）变体：与外壳设置/布局弹窗视觉语言对齐 ---------- */

.polling-dialog-layer--desktop {
  background: var(--overlay-bg, rgba(15, 23, 42, 0.4));
}

.polling-dialog--desktop {
  /* 外壳主题色（深色主题下同样保持外壳蓝，与壳内弹窗一致） */
  --accent: #2385e8;
  width: min(440px, calc(100vw - 40px));
  border-radius: 8px;
  background: var(--panel-solid, #ffffff);
  border-color: var(--line-strong, rgba(15, 23, 42, 0.24));
  box-shadow: var(--shadow-card, 0 24px 60px -24px rgba(15, 23, 42, 0.24));
}

.polling-dialog--desktop .polling-dialog__head {
  padding: 14px 16px 8px;
  border-bottom: 1px solid var(--line, rgba(15, 23, 42, 0.12));
}

.polling-dialog--desktop .polling-dialog__head h3 {
  font-size: 16px;
}

.polling-dialog--desktop .polling-dialog__close {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  font-size: 18px;
  border-radius: 6px;
}

.polling-dialog--desktop .polling-dialog__hint {
  padding: 10px 16px 8px;
}

.polling-dialog--desktop .polling-dialog__list {
  padding: 4px 8px 10px;
}

.polling-dialog--desktop .polling-dialog__row {
  border-radius: 6px;
}

.polling-dialog--desktop .polling-dialog__box--fixed {
  background: rgba(35, 133, 232, 0.14);
}

.polling-dialog--desktop .polling-dialog__actions {
  padding: 12px 16px 14px;
}

.polling-dialog--desktop .polling-dialog__actions .btn {
  height: 40px;
  min-width: 96px;
  padding: 0 20px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
}

.polling-dialog--desktop .polling-dialog__actions .btn-primary {
  background: #2385e8;
  border-color: #2385e8;
  color: #fff;
  box-shadow: none;
}

.polling-dialog--desktop .polling-dialog__actions .btn-ghost {
  color: var(--text-hi, #16202e);
  border-color: var(--line-strong, rgba(15, 23, 42, 0.24));
  background: var(--bg-1, #eaeef4);
}
</style>
