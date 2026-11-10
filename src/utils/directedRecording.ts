/**
 * 定向录制稳定输出引擎：固定尺寸 Canvas 视频输出 + Web Audio 单一 destination。
 * 只替换录制输入源，MediaRecorder 面对的输出流身份全程稳定。
 * 契约见 docs/plans/2026-10-21-recording-modes-design.md 与 Task 1 实测记录。
 * 只释放自建轨道/节点/定时器/订阅；借用的 Jitsi 源轨道永不停止。
 */

import type { RecordingMode, RecordingSourceSelection } from './recordingSources'

export interface DirectedVideoElement {
  srcObject: unknown
  muted: boolean
  autoplay: boolean
  playsInline: boolean
  videoWidth: number
  videoHeight: number
  readyState: number
  play(): Promise<void>
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface DirectedAudioNode {
  connect(destination: unknown): unknown
  disconnect(): void
}

export interface DirectedAudioContextLike {
  destination: unknown
  resume(): Promise<void>
  close(): Promise<void>
  createMediaStreamDestination(): { stream: { getAudioTracks(): Array<{ kind: string; stop(): void }> } }
  createMediaStreamSource(track: unknown): DirectedAudioNode
  createConstantSource?: () => DirectedAudioNode & { offset: { value: number }; start(): void; stop(): void }
}

export interface DirectedCanvasLike {
  width: number
  height: number
  getContext(kind: '2d'): {
    fillStyle: string
    fillRect(x: number, y: number, w: number, h: number): void
    drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void
  }
  captureStream(frameRate?: number): { getVideoTracks(): Array<{ kind: string; stop(): void }> }
}

export interface DirectedScheduler {
  start(work: () => void): void
  stop(): void
}

export interface DirectedEngineDeps {
  createVideoElement(): DirectedVideoElement
  createAudioContext(): DirectedAudioContextLike
  createCanvas(width: number, height: number): DirectedCanvasLike
  createMediaStream(tracks: unknown[]): unknown
  scheduler?: DirectedScheduler
}

export interface DirectedEngineOptions {
  mode: RecordingMode
  width?: number
  height?: number
  frameRate?: number
  deps?: DirectedEngineDeps
  onShareEnded?: () => void
  onError?: (error: Error) => void
}

export interface DirectedRecordingEngine {
  start(): Promise<void>
  getOutputStream(): unknown | null
  applySource(selection: RecordingSourceSelection): Promise<void>
  dispose(): Promise<void>
}

const BLACK = '#000000'

function defaultScheduler(frameRate: number): DirectedScheduler {
  let timer: ReturnType<typeof setInterval> | null = null
  return {
    start(work) {
      if (timer !== null) return
      timer = setInterval(work, Math.max(10, Math.floor(1000 / frameRate)))
    },
    stop() {
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}

function browserDeps(): DirectedEngineDeps {
  return {
    createVideoElement: () => document.createElement('video') as unknown as DirectedVideoElement,
    createAudioContext: () => new AudioContext() as unknown as DirectedAudioContextLike,
    createCanvas: (width, height) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      return canvas as unknown as DirectedCanvasLike
    },
    createMediaStream: (tracks) => new MediaStream(tracks as MediaStreamTrack[]),
  }
}

function underlyingTrack(entry: RecordingSourceSelection['video']['track']): unknown | null {
  try {
    return entry?.jitsiTrack?.getTrack?.() ?? null
  } catch {
    return null
  }
}

/** 启动阻断原因 → 用户可读文案；空串表示可开始。 */
export function getRecordingStartBlockReason(
  selection: Pick<RecordingSourceSelection, 'reason'> | null,
  mode: RecordingMode,
): string {
  if (!selection) return '会议状态暂不可读，请稍后重试'
  switch (selection.reason) {
    case '':
      return ''
    case 'no-host':
      return mode === 'shared-screen' ? '当前没有进行中的屏幕共享' : '当前没有主持人，无法开始录制主持人视频'
    case 'no-active-share':
      return '当前没有进行中的屏幕共享'
    case 'ambiguous-share':
      return '多人同时共享屏幕，无法确定录制目标'
    case 'ambiguous-mic':
      return '目标麦克风状态不明确，无法安全录制'
    default:
      return '录制目标暂不可用，请稍后重试'
  }
}

export function createDirectedRecordingEngine(options: DirectedEngineOptions): DirectedRecordingEngine {
  const { mode, onShareEnded, onError } = options
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const frameRate = options.frameRate ?? 30
  const deps = options.deps ?? browserDeps()
  const scheduler = deps.scheduler ?? defaultScheduler(frameRate)

  let started = false
  let disposed = false
  let generation = 0
  let canvas: DirectedCanvasLike | null = null
  let ctx: ReturnType<DirectedCanvasLike['getContext']> | null = null
  let videoElement: DirectedVideoElement | null = null
  let overlayElement: DirectedVideoElement | null = null
  let overlayTrack: unknown | null = null
  let overlayGeneration = 0
  const mixedMics = new Map<unknown, DirectedAudioNode>()
  let audioContext: DirectedAudioContextLike | null = null
  let destination: { stream: { getAudioTracks(): Array<{ kind: string; stop(): void }> } } | null = null
  let outputStream: unknown | null = null
  let ownedTracks: Array<{ kind: string; stop(): void }> = []
  let micNode: DirectedAudioNode | null = null
  let boundMicrophone: unknown | null = null
  let boundVideoTrack: unknown | null = null
  let silence: (DirectedAudioNode & { stop(): void }) | null = null
  let boundShareIdentity = ''
  let shareEndedFired = false
  let removeSourceEnded: (() => void) | null = null
  let requestVideoFrame: (() => void) | null = null

  function drawBlack(publish = true): void {
    if (!ctx || !canvas) return
    ctx.fillStyle = BLACK
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    if (publish) requestVideoFrame?.()
  }

  function draw(): void {
    if (!ctx || !canvas) return
    const video = videoElement
    if (!video || !video.srcObject || video.videoWidth <= 0 || video.videoHeight <= 0
      || (typeof video.readyState === 'number' && video.readyState < 2)) {
      drawBlack()
      return
    }
    // Compose the entire frame before requesting capture; never publish the intermediate black background.
    drawBlack(false)
    // contain 不裁切
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight)
    const dw = Math.max(1, Math.floor(video.videoWidth * scale))
    const dh = Math.max(1, Math.floor(video.videoHeight * scale))
    const dx = Math.floor((canvas.width - dw) / 2)
    const dy = Math.floor((canvas.height - dh) / 2)
    ctx.drawImage(video, dx, dy, dw, dh)
    if (mode === 'composite' && overlayElement?.srcObject && overlayElement.readyState >= 2
      && (overlayTrack as { readyState?: string } | null)?.readyState !== 'ended'
      && overlayElement.videoWidth > 0 && overlayElement.videoHeight > 0) {
      const boxW = Math.floor(canvas.width * 0.26)
      const boxH = Math.floor(canvas.height * 0.26)
      const margin = Math.floor(canvas.width * 0.015)
      const scale = Math.min(boxW / overlayElement.videoWidth, boxH / overlayElement.videoHeight)
      const w = Math.floor(overlayElement.videoWidth * scale)
      const h = Math.floor(overlayElement.videoHeight * scale)
      ctx.fillStyle = BLACK
      ctx.fillRect(canvas.width - boxW - margin, canvas.height - boxH - margin, boxW, boxH)
      ctx.drawImage(overlayElement, canvas.width - boxW - margin + (boxW - w) / 2,
        canvas.height - boxH - margin + (boxH - h) / 2, w, h)
    }
    requestVideoFrame?.()
  }

  function setMicrophone(track: unknown | null): void {
    if (track === boundMicrophone) return
    if (micNode) {
      try { micNode.disconnect() } catch { /* ignore */ }
      micNode = null
    }
    boundMicrophone = null
    if (!track || !audioContext || !destination) return
    try {
      micNode = audioContext.createMediaStreamSource(deps.createMediaStream([track]))
      micNode.connect(destination)
      boundMicrophone = track
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error('连接目标麦克风失败'))
    }
  }

  function maybeFireShareEnded(selection: RecordingSourceSelection): void {
    if (mode === 'host-camera' || shareEndedFired) return
    if (!boundShareIdentity) return
    if (selection.share.identity === boundShareIdentity && selection.share.active) return
    shareEndedFired = true
    try { onShareEnded?.() } catch { /* ignore */ }
  }

  return {
    async start() {
      if (started || disposed) return
      canvas = deps.createCanvas(width, height)
      ctx = canvas.getContext('2d')
      drawBlack()
      audioContext = deps.createAudioContext()
      try { await audioContext.resume() } catch { /* 继续；连接时再次尝试 */ }
      destination = audioContext.createMediaStreamDestination()
      // 空 destination 在 Chromium 中可能不产生音频时钟，导致整个录制输出为空。
      // 持续的零值信号保证静音开始/静音期间仍有可编码的音频帧，不连接扬声器。
      const silentSource = audioContext.createConstantSource?.()
      if (silentSource) {
        silence = silentSource
        silentSource.offset.value = 0
        silentSource.connect(destination)
        silentSource.start()
      }
      const canvasStream = canvas.captureStream(frameRate)
      const canvasVideoTrack = canvasStream.getVideoTracks()[0] ?? null
      const manualTrack = canvasVideoTrack as (typeof canvasVideoTrack & { requestFrame?: () => void })
      requestVideoFrame = manualTrack?.requestFrame ? () => manualTrack.requestFrame!() : null
      const destAudioTrack = destination.stream.getAudioTracks()[0] ?? null
      ownedTracks = [canvasVideoTrack, destAudioTrack].filter(Boolean)
      outputStream = deps.createMediaStream(ownedTracks.slice())
      videoElement = deps.createVideoElement()
      videoElement.muted = true
      videoElement.autoplay = true
      videoElement.playsInline = true
      if (mode === 'composite') {
        overlayElement = deps.createVideoElement()
        overlayElement.muted = true
        overlayElement.autoplay = true
        overlayElement.playsInline = true
      }
      scheduler.start(draw)
      started = true
    },

    getOutputStream() {
      return outputStream
    },

    async applySource(selection: RecordingSourceSelection) {
      if (!started || disposed) return
      // 共享模式：首个活跃共享绑定身份；之后身份变化（停止或换人）即结束，不接续。
      if (mode !== 'host-camera' && !boundShareIdentity && selection.share.active && selection.share.identity) {
        boundShareIdentity = selection.share.identity
      }
      // 音频：仅连接目标麦克风；静音/缺席 = 静音输出（destination 空输入即静音，不走扬声器）。
      const micTrack = selection.microphone.present && !selection.microphone.muted
        ? underlyingTrack(selection.microphone.track)
        : null
      if (mode === 'composite') {
        const tracks = new Set((selection.microphones ?? [selection.microphone])
          .filter(mic => mic.present && !mic.muted).map(mic => underlyingTrack(mic.track)).filter(Boolean))
        for (const [track, node] of mixedMics) {
          if (!tracks.has(track)) { node.disconnect(); mixedMics.delete(track) }
        }
        for (const track of tracks) {
          if (!mixedMics.has(track) && audioContext && destination) {
            const node = audioContext.createMediaStreamSource(deps.createMediaStream([track]))
            node.connect(destination)
            mixedMics.set(track, node)
          }
        }
        const overlay = selection.overlay
        const nextOverlay = overlay?.present && !overlay.muted ? underlyingTrack(overlay.track) : null
        if (nextOverlay !== overlayTrack && overlayElement) {
          overlayTrack = nextOverlay
          const gen = ++overlayGeneration
          overlayElement.srcObject = nextOverlay ? deps.createMediaStream([nextOverlay]) : null
          if (nextOverlay) {
            void overlayElement.play().catch(error => {
              if (!disposed && gen === overlayGeneration) onError?.(error instanceof Error ? error : new Error('播放主持人画面失败'))
            })
          }
        }
      } else setMicrophone(micTrack)
      // 视频：静音/缺席 = 黑屏。
      const videoTrack = selection.video.present && !selection.video.muted
        ? underlyingTrack(selection.video.track)
        : null
      // Redux emits for many non-media changes. Keep the current decoder and ended listener
      // when the underlying camera track is unchanged, even if the mic changed.
      if (videoTrack === boundVideoTrack) {
        maybeFireShareEnded(selection)
        return
      }
      const gen = ++generation
      removeSourceEnded?.()
      removeSourceEnded = null
      boundVideoTrack = videoTrack
      // Real source changes must not retain the previous host's image.
      drawBlack()
      const video = videoElement
      const source = videoTrack as MediaStreamTrack | null
      if (source?.addEventListener) {
        const ended = () => {
          if (disposed || gen !== generation) return
          boundVideoTrack = null
          if (videoElement) videoElement.srcObject = null
          drawBlack()
          if (mode !== 'host-camera') {
            setMicrophone(null)
            maybeFireShareEnded({ ...selection, share: { ...selection.share, active: false } })
          }
        }
        source.addEventListener('ended', ended)
        removeSourceEnded = () => source.removeEventListener('ended', ended)
      }
      if (!videoTrack || !video) {
        if (video) video.srcObject = null
      } else {
        try {
          video.srcObject = deps.createMediaStream([videoTrack])
          await video.play()
        } catch (error) {
          if (gen === generation && !disposed) {
            onError?.(error instanceof Error ? error : new Error('播放录制目标失败'))
          }
        }
        if (gen !== generation) return
      }
      maybeFireShareEnded(selection)
    },

    async dispose() {
      if (disposed) return
      disposed = true
      removeSourceEnded?.()
      removeSourceEnded = null
      scheduler.stop()
      generation += 1
      overlayGeneration += 1
      for (const node of mixedMics.values()) { try { node.disconnect() } catch { /* ignore */ } }
      mixedMics.clear()
      if (overlayElement) overlayElement.srcObject = null
      overlayElement = null
      overlayTrack = null
      try { micNode?.disconnect() } catch { /* ignore */ }
      micNode = null
      try { silence?.stop(); silence?.disconnect() } catch { /* ignore */ }
      silence = null
      if (videoElement) {
        try { videoElement.srcObject = null } catch { /* ignore */ }
      }
      ownedTracks.forEach((track) => { try { track.stop() } catch { /* ignore */ } })
      ownedTracks = []
      requestVideoFrame = null
      try { await audioContext?.close() } catch { /* ignore */ }
      outputStream = null
      canvas = null
      ctx = null
      videoElement = null
      audioContext = null
      destination = null
      started = false
    },
  }
}
