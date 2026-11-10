<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { JitsiMeetExternalAPI, JitsiParticipantInfo } from '../types/jitsi'

const props = defineProps<{
  api: JitsiMeetExternalAPI
  localParticipantId: string
  topInset: number
}>()
const emit = defineEmits<{ 'main-changed': [participantId: string] }>()

type VideoTrackState = {
  participantId?: string
  local?: boolean
  mediaType?: string
  videoType?: string
  muted?: boolean
  jitsiTrack?: { track?: MediaStreamTrack; getTrack?: () => MediaStreamTrack; isLocal?: () => boolean }
}

type FrameState = {
  'features/base/tracks'?: VideoTrackState[]
  'features/base/participants'?: Array<{ id?: string; name?: string; local?: boolean }>
  'features/large-video'?: { participantId?: string }
}

type PreviewParticipant = { id: string; name: string; local: boolean }

const participants = ref<PreviewParticipant[]>([])
const mainParticipantId = ref('')
const selectedParticipantId = ref('')
const previewRatios = ref<Record<string, number>>({})
const activeVideoIds = ref<Set<string>>(new Set())
const strip = ref<HTMLElement | null>(null)
const tracks = new Map<string, MediaStreamTrack>()
const videoTypes = new Map<string, 'camera' | 'desktop'>()
let participantOrder: string[] = []
let lastAutoMainTarget = ''
let refreshTimer: number | undefined

const previews = computed(() => participants.value.filter((participant) => participant.id !== mainParticipantId.value))
watch(mainParticipantId, (participantId) => emit('main-changed', participantId))

function getFrameState(): FrameState | null {
  try {
    const frame = props.api.getIFrame()
    const frameWindow = frame?.contentWindow as (Window & {
      APP?: { store?: { getState?: () => FrameState } }
    }) | null
    return frameWindow?.APP?.store?.getState?.() ?? null
  } catch {
    return null
  }
}

function readParticipants(state: FrameState | null): PreviewParticipant[] {
  const names = new Map<string, string>()
  const frameParticipants = state?.['features/base/participants']
  const safeFrameParticipants = Array.isArray(frameParticipants) ? frameParticipants : []
  safeFrameParticipants.forEach((participant) => {
    if (participant.id && participant.name) names.set(participant.id, participant.name)
  })
  let apiParticipants: JitsiParticipantInfo[] = []
  try {
    const value = props.api.getParticipantsInfo()
    apiParticipants = Array.isArray(value) ? value : []
  } catch {
    // The iframe may still be joining; the local participant is added below.
  }
  const result: PreviewParticipant[] = []
  const seen = new Set<string>()
  const add = (id: string, name: string, local: boolean) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    result.push({ id, name: name || names.get(id) || (local ? '我' : '参会者'), local })
  }
  add(props.localParticipantId, names.get(props.localParticipantId) || '我', true)
  apiParticipants.forEach((participant) => {
    if (participant.isHidden || participant.isJigasi) return
    const id = participant.participantId || participant.id || ''
    add(id, participant.displayName || names.get(id) || '', id === props.localParticipantId)
  })
  safeFrameParticipants.forEach((participant) => {
    if (participant.id) add(participant.id, participant.name || '', participant.id === props.localParticipantId)
  })
  participantOrder = participantOrder.filter((id) => seen.has(id))
  result.forEach((participant) => {
    if (!participantOrder.includes(participant.id)) participantOrder.push(participant.id)
  })
  return result.sort((a, b) => participantOrder.indexOf(a.id) - participantOrder.indexOf(b.id))
}

function readPreviewTracks(state: FrameState | null): void {
  tracks.clear()
  videoTypes.clear()
  const frameTracks = state?.['features/base/tracks']
  if (!Array.isArray(frameTracks)) {
    activeVideoIds.value = new Set()
    return
  }
  frameTracks.forEach((item) => {
    let isLocal = item.local === true
    try { isLocal ||= item.jitsiTrack?.isLocal?.() === true } catch { /* track is closing */ }
    const participantId = item.participantId || (isLocal ? props.localParticipantId : '')
    if (item.mediaType !== 'video' || item.muted || !participantId) return
    let track: MediaStreamTrack | undefined
    try { track = item.jitsiTrack?.track ?? item.jitsiTrack?.getTrack?.() } catch { return }
    if (track?.kind !== 'video' || track.readyState !== 'live') return
    const videoType = item.videoType === 'desktop' ? 'desktop' : 'camera'
    if (!tracks.has(participantId) || videoType === 'camera') {
      tracks.set(participantId, track)
      videoTypes.set(participantId, videoType)
    }
  })
  activeVideoIds.value = new Set(tracks.keys())
}

function syncPreviewVideos(): void {
  if (!strip.value) return
  const stripRect = strip.value.getBoundingClientRect()
  strip.value.querySelectorAll<HTMLVideoElement>('video[data-participant-id]').forEach((video) => {
    const id = video.dataset.participantId || ''
    const cardRect = video.parentElement?.getBoundingClientRect()
    const nearViewport = Boolean(cardRect && cardRect.right >= stripRect.left - 80 && cardRect.left <= stripRect.right + 80)
    const track = nearViewport ? tracks.get(id) : undefined
    const current = video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : undefined
    if (current === track) return
    video.srcObject = track ? new MediaStream([track]) : null
    if (track) void video.play().catch(() => undefined)
  })
}

function refresh(): void {
  const state = getFrameState()
  participants.value = readParticipants(state)
  readPreviewTracks(state)
  const ids = new Set(participants.value.map((participant) => participant.id))
  if (selectedParticipantId.value && !ids.has(selectedParticipantId.value)) {
    selectedParticipantId.value = ''
    try {
      props.api.executeCommand('pinParticipant', null)
      const fallback = participants.value.find((participant) => tracks.has(participant.id)) ?? participants.value[0]
      if (fallback) props.api.executeCommand('setLargeVideoParticipant', fallback.id, videoTypes.get(fallback.id) || 'camera')
    } catch { /* conference is closing */ }
  }
  const jitsiMain = state?.['features/large-video']?.participantId || ''
  if (!selectedParticipantId.value && jitsiMain === props.localParticipantId && !tracks.has(props.localParticipantId)) {
    const remoteWithVideo = participants.value.find((participant) => !participant.local && tracks.has(participant.id))
    if (remoteWithVideo && remoteWithVideo.id !== lastAutoMainTarget) {
      lastAutoMainTarget = remoteWithVideo.id
      try { props.api.executeCommand('setLargeVideoParticipant', remoteWithVideo.id, videoTypes.get(remoteWithVideo.id) || 'camera') } catch { /* conference is closing */ }
    }
  }
  const defaultMain = participants.value.find((participant) => !participant.local)?.id || participants.value[0]?.id || ''
  mainParticipantId.value = selectedParticipantId.value || (ids.has(jitsiMain) ? jitsiMain : defaultMain)
  requestAnimationFrame(syncPreviewVideos)
}

function chooseMain(id: string): void {
  if (!id || id === mainParticipantId.value) return
  selectedParticipantId.value = id
  mainParticipantId.value = id
  try {
    props.api.executeCommand('pinParticipant', id, videoTypes.get(id) || 'camera')
  } catch { /* older Jitsi releases may lack pinParticipant */ }
  try { props.api.executeCommand('setLargeVideoParticipant', id, videoTypes.get(id) || 'camera') } catch { /* conference is closing */ }
  requestAnimationFrame(syncPreviewVideos)
}

function previewSize(participant: PreviewParticipant): Record<string, string> {
  const ratio = previewRatios.value[participant.id] || (participant.local ? 9 / 16 : 16 / 9)
  const maxHeight = Math.min(window.innerHeight * 0.23, 190)
  const maxWidth = Math.min(window.innerWidth * 0.42, 180)
  const height = Math.min(maxHeight, maxWidth / ratio)
  return { width: `${Math.round(height * ratio)}px`, height: `${Math.round(height)}px` }
}

function onVideoMetadata(event: Event, id: string): void {
  const video = event.target as HTMLVideoElement
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    previewRatios.value = { ...previewRatios.value, [id]: video.videoWidth / video.videoHeight }
  }
}

function safeRefresh(): void {
  try { refresh() } catch (error) { console.warn('Android 小窗刷新失败', error) }
}

watch(() => props.api, safeRefresh)
onMounted(() => {
  refreshTimer = window.setInterval(safeRefresh, 900)
  safeRefresh()
})
onBeforeUnmount(() => {
  emit('main-changed', '')
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
  strip.value?.querySelectorAll<HTMLVideoElement>('video').forEach((video) => { video.srcObject = null })
  tracks.clear()
})
</script>

<template>
  <Teleport to="body">
  <div
    v-if="previews.length"
    ref="strip"
    class="android-video-strip"
    :style="{ top: `${Math.max(12, topInset + 10)}px` }"
    aria-label="其他参会成员，点击切换主画面"
    @scroll.passive="syncPreviewVideos"
  >
    <button
      v-for="participant in previews"
      :key="participant.id"
      type="button"
      class="android-video-strip__card"
      :style="previewSize(participant)"
      :aria-label="`将${participant.name}切换到主画面`"
      @click="chooseMain(participant.id)"
    >
      <video
        v-if="activeVideoIds.has(participant.id)"
        :data-participant-id="participant.id"
        autoplay
        muted
        playsinline
        @loadedmetadata="onVideoMetadata($event, participant.id)"
      />
      <span class="android-video-strip__avatar">{{ participant.name.slice(0, 1) }}</span>
      <span class="android-video-strip__name">{{ participant.name }}</span>
    </button>
  </div>
  </Teleport>
</template>

<style scoped>
.android-video-strip {
  position: fixed;
  right: 12px;
  z-index: 22;
  display: flex;
  gap: 8px;
  width: max-content;
  max-width: calc(100% - 24px);
  overflow-x: auto;
  overflow-y: hidden;
  scroll-snap-type: x proximity;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.android-video-strip::-webkit-scrollbar { display: none; }
.android-video-strip__card {
  position: relative;
  flex: none;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,.72);
  border-radius: 8px;
  color: #fff;
  background: #1b2330;
  box-shadow: 0 3px 14px rgba(0,0,0,.4);
  scroll-snap-align: end;
}
.android-video-strip__card video {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.android-video-strip__avatar {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 38px;
  color: #dce5f2;
}
.android-video-strip__name {
  position: absolute;
  z-index: 2;
  bottom: 4px;
  left: 5px;
  max-width: calc(100% - 10px);
  overflow: hidden;
  padding: 2px 5px;
  border-radius: 3px;
  background: rgba(0,0,0,.55);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
