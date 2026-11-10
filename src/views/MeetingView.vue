<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import MeetingStage from '../components/MeetingStage.vue'
import ShareDialog from '../components/ShareDialog.vue'
import { getSession } from '../stores/meeting'

const router = useRouter()

const props = defineProps<{
  roomName: string
  subject?: string
}>()

const session = getSession(props.roomName)

const displaySubject = computed(() => props.subject || session?.subject || '我的会议')
const showShare = ref(false)
let kickTimer: number | undefined

function onKicked(): void {
  if (kickTimer) window.clearTimeout(kickTimer)
  kickTimer = window.setTimeout(() => {
    router.push('/')
  }, 4000)
}

function goHome(): void {
  if (kickTimer) window.clearTimeout(kickTimer)
  router.push('/')
}
</script>

<template>
  <div class="meeting-page">
    <MeetingStage :room-name="roomName" :subject="subject" @kicked="onKicked" @invite="showShare = true" @go-home="goHome" />
    <ShareDialog
      :open="showShare"
      :room-name="roomName"
      :subject="displaySubject"
      :password="getSession(roomName)?.password ?? ''"
      @close="showShare = false"
    />
  </div>
</template>

<style scoped>
.meeting-page {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
