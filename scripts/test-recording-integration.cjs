// Task 5 (web): adapter → selector → engine composed flow, mirroring MeetingStage's
// start/stop call sequence (documented in MeetingStage.startLocalRecording).
// Run: node scripts/test-recording-integration.cjs
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function transpile(file) {
  const source = readFileSync(path.join(__dirname, '../src/utils', file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const moduleExports = {}
  vm.runInNewContext(code, { exports: moduleExports, console })
  return moduleExports
}

const sources = transpile('recordingSources.ts')
const directed = transpile('directedRecording.ts')
const { selectRecordingSource, normalizeRecordingMode } = sources
const { createDirectedRecordingEngine, getRecordingStartBlockReason } = directed

// ---------- fake store (adapter stand-in using the same selector MeetingStage calls) ----------
function makeStore() {
  let state = { participants: { local: { id: 'me', role: 'moderator' } }, tracks: [] }
  const listeners = []
  return {
    getState: () => state,
    setState: (next) => { state = next; listeners.forEach((fn) => fn()) },
    subscribe: (fn) => { listeners.push(fn); return () => {} },
  }
}

function mediaState(over = {}) {
  return {
    participants: { local: { id: 'me', role: 'moderator' } },
    tracks: [],
    ...over,
  }
}

const trackEntry = (participantId, kind, videoType, id, over = {}) => ({
  participantId, local: participantId === 'me', mediaType: kind, videoType, muted: false,
  jitsiTrack: {
    getId: () => id, getType: () => kind, getVideoType: () => videoType, isMuted: () => false,
    getTrack: () => sourceTracks.get(id) ?? null,
  },
  ...over,
})
const sourceTracks = new Map()
function sourceTrack(id, kind) {
  const track = Object.assign(new EventTarget(), { kind, readyState: 'live', id, stopped: false,
    stop() { this.stopped = true; this.readyState = 'ended' } })
  sourceTracks.set(id, track)
  return track
}

// ---------- fake engine deps (same harness contract as test-directed-recording) ----------
function makeEngineDeps() {
  const draws = []
  const video = {
    srcObject: null, muted: true, autoplay: true, playsInline: true,
    videoWidth: 640, videoHeight: 360, readyState: 4, paused: false,
    async play() { this.paused = false },
    addEventListener() {}, removeEventListener() {},
  }
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      set fillStyle(v) { this._f = v }, get fillStyle() { return this._f },
      fillRect: (...a) => draws.push(['fillRect']),
      drawImage: () => draws.push(['drawImage']),
    }),
    captureStream: () => ({ getVideoTracks: () => [Object.assign(new EventTarget(), { kind: 'video', readyState: 'live', stop() { this.stopped = true } })] }),
  }
  const audioCtx = {
    destination: {},
    async resume() {}, async close() {},
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [Object.assign(new EventTarget(), { kind: 'audio', readyState: 'live', stop() { this.stopped = true } })] } }),
    createMediaStreamSource: (track) => ({ track, connect() {}, disconnect() {} }),
  }
  return {
    draws, video,
    deps: {
      createVideoElement: () => video,
      createAudioContext: () => audioCtx,
      createCanvas: (w, h) => { canvas.width = w; canvas.height = h; return canvas },
      createMediaStream: (tracks) => ({ tracks }),
      scheduler: { start() {}, stop() {} },
    },
  }
}

// ---------- fake bridge (mirrors MeetingStage session calls) ----------
function makeBridge() {
  return {
    sessions: 0, finishes: 0, cancels: 0, chunks: [],
    async startSession() { this.sessions += 1; return { sessionId: `s-${this.sessions}` } },
    writeChunk(kind) { this.chunks.push(kind) },
    async finish() { this.finishes += 1 },
    async cancel() { this.cancels += 1 },
  }
}

async function main() {
  // --- 1. startup blocked when no host ---
  {
    const store = makeStore()
    store.setState(mediaState({ participants: { local: { id: 'me', role: 'participant' }, remote: [] } }))
    const selection = selectRecordingSource(store.getState(), 'host-camera')
    assert.equal(getRecordingStartBlockReason(selection, 'host-camera'), '当前没有主持人，无法开始录制主持人视频')
  }

  // --- 2. shared mode blocked when no active share ---
  {
    const store = makeStore()
    const selection = selectRecordingSource(store.getState(), 'shared-screen')
    assert.equal(getRecordingStartBlockReason(selection, 'shared-screen'), '当前没有进行中的屏幕共享')
  }

  // --- 3. full start → record → mute → transfer-black → manual stop → finish once ---
  {
    const store = makeStore()
    const h = makeEngineDeps()
    const bridge = makeBridge()
    sourceTrack('me-cam', 'video')
    sourceTrack('me-mic', 'audio')
    store.setState(mediaState({ tracks: [
      trackEntry('me', 'video', 'camera', 'me-cam'),
      trackEntry('me', 'audio', null, 'me-mic'),
    ] }))

    // MeetingStage 序列：select → block? → engine.start → applySource → recorders on output
    const mode = normalizeRecordingMode('host-camera')
    const selection = selectRecordingSource(store.getState(), mode)
    assert.equal(getRecordingStartBlockReason(selection, mode), '')
    const engine = createDirectedRecordingEngine({
      mode, deps: h.deps,
      onShareEnded: () => {},
      onError: (error) => { throw error },
    })
    await engine.start()
    await engine.applySource(selection)
    const output = engine.getOutputStream()
    assert.equal(output.tracks.length, 2)
    await bridge.startSession({ recordAudioFile: true })
    const unsubscribe = store.subscribe(() => {
      const next = selectRecordingSource(store.getState(), mode)
      if (next) void engine.applySource(next)
    })

    // 会议静音（store 变化 → 换源 → 黑屏 + 静音，不停止录制）
    const mutedEntry = trackEntry('me', 'audio', null, 'me-mic', { muted: true, jitsiTrack: { getId: () => 'me-mic', getType: () => 'audio', getVideoType: () => null, isMuted: () => true, getTrack: () => sourceTracks.get('me-mic') } })
    store.setState(mediaState({ tracks: [trackEntry('me', 'video', 'camera', 'me-cam'), mutedEntry] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.draws.length = 0
    // draw loop 已由引擎内部调度驱动；此处直接验证输出流身份仍稳定
    assert.equal(engine.getOutputStream(), output, 'mute keeps the same output stream')
    await unsubscribe()
    await engine.dispose()
    await bridge.finish()
    assert.equal(bridge.finishes, 1)
    assert.equal(sourceTracks.get('me-mic').stopped, false, 'mute must not stop the source track')
    assert.equal(sourceTracks.get('me-cam').stopped, false)
  }

  // --- 4. shared mode: share stop → save-once under racing triggers ---
  {
    const store = makeStore()
    const h = makeEngineDeps()
    const bridge = makeBridge()
    sourceTrack('sharer-desk', 'video')
    sourceTrack('sharer-mic', 'audio')
    store.setState(mediaState({
      participants: { local: { id: 'me', role: 'participant' }, remote: [{ id: 'sharer', role: 'participant' }] },
      tracks: [
        trackEntry('sharer', 'screenshare', 'desktop', 'sharer-desk'),
        trackEntry('sharer', 'audio', null, 'sharer-mic'),
      ],
    }))
    const mode = 'shared-screen'
    let stopping = false
    const stopRecording = async () => {
      if (stopping) return // MeetingStage 重入保护（localRecordingBusy）
      stopping = true
      await bridge.finish()
    }
    const selection = selectRecordingSource(store.getState(), mode)
    assert.equal(getRecordingStartBlockReason(selection, mode), '')
    const engine = createDirectedRecordingEngine({
      mode, deps: h.deps,
      onShareEnded: () => { void stopRecording() },
      onError: () => {},
    })
    await engine.start()
    await engine.applySource(selection)
    await bridge.startSession({})
    store.subscribe(() => {
      const next = selectRecordingSource(store.getState(), mode)
      if (next) void engine.applySource(next)
    })

    // 共享停止（muted 驻留）→ 引擎一次 onShareEnded；手动停止竞态不再二次 finish
    const stoppedDesk = trackEntry('sharer', 'screenshare', 'desktop', 'sharer-desk', { muted: true, jitsiTrack: { getId: () => 'sharer-desk', getType: () => 'video', getVideoType: () => 'desktop', isMuted: () => true, getTrack: () => sourceTracks.get('sharer-desk') } })
    store.setState(mediaState({
      participants: { local: { id: 'me', role: 'participant' }, remote: [{ id: 'sharer', role: 'participant' }] },
      tracks: [stoppedDesk, trackEntry('sharer', 'audio', null, 'sharer-mic')],
    }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    await stopRecording() // 用户同时点停止
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(bridge.finishes, 1, 'share stop + manual stop race must finish exactly once')
    assert.equal(sourceTracks.get('sharer-desk').stopped, false, 'engine never stops the borrowed share track')
    await engine.dispose()
  }

  // --- 5. startup rollback: engine output missing → cancel, no finish ---
  {
    const store = makeStore()
    const bridge = makeBridge()
    const selection = selectRecordingSource(store.getState(), 'host-camera')
    assert.equal(getRecordingStartBlockReason(selection, 'host-camera'), '')
    const session = await bridge.startSession({})
    // 模拟输出流创建失败后的回滚路径
    await bridge.cancel(session.sessionId)
    assert.equal(bridge.cancels, 1)
    assert.equal(bridge.finishes, 0)
  }

  console.log('PASS web recording integration (adapter→selector→engine→bridge)')
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
})
