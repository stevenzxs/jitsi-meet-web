<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    alert?: boolean
    variant?: 'web' | 'desktop'
  }>(),
  { alert: false, variant: 'web' },
)
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const isDesktop = () => props.variant === 'desktop'
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" :class="{ 'overlay--desktop': isDesktop() }">
      <div
        class="modal"
        :class="{ 'modal--desktop modal--desktop--sm': isDesktop() }"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <div class="modal-head">
          <h3 class="modal-title" id="confirm-title">{{ title }}</h3>
          <button class="modal-close" aria-label="关闭" @click="emit('cancel')">✕</button>
        </div>
        <div class="modal-body">
          <p class="confirm-message">{{ message }}</p>
        </div>
        <div class="modal-foot">
          <button v-if="!props.alert" class="btn btn-ghost" @click="emit('cancel')">{{ cancelText ?? '取消' }}</button>
          <button class="btn" :class="props.alert ? 'btn-primary' : 'btn-danger'" @click="emit('confirm')">{{ confirmText ?? '确认' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-message {
  margin: 0;
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-mid);
}
</style>
