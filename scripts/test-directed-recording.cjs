// Task 4 (web): directed recording engine lifecycle tests.
// Run: node scripts/test-directed-recording.cjs
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = readFileSync(path.join(__dirname, '../src/utils/directedRecording.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText
const moduleExports = {}
vm.runInNewContext(code, { exports: moduleExports, console })

const { createDirectedRecordingEngine, getRecordingStartBlockReason } = moduleExports
assert.equal(typeof createDirectedRecordingEngine, 'function')
assert.equal(typeof getRecordingStartBlockReason, 'function')

// ---------- fake deps ----------
function makeDeps() {
  const draws = []
  const sourceNodes = []
  const stoppedTracks = []
  let playGate = null
  let playCount = 0
  const video = {
    srcObject: null, muted: false, autoplay: false, playsInline: false,
    videoWidth: 0, videoHeight: 0, readyState: 0, paused: true,
    listeners: {},
    async play() {
      playCount++
      this.paused = false
      this.readyState = 4
      this.videoWidth = 640
      this.videoHeight = 360
      if (playGate) await playGate
    },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn)
    },
  }
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({
      set fillStyle(value) { this._fill = value },
      get fillStyle() { return this._fill },
      fillRect: (...args) => draws.push(['fillRect', ...args]),
      drawImage: (...args) => draws.push(['drawImage', args[0] === video ? 'video' : 'other', ...args.slice(1)]),
    }),
    captureStream: () => ({
      getVideoTracks: () => [Object.assign(new EventTarget(), {
        kind: 'video', readyState: 'live', stopped: false,
        requestFrame() { draws.push(['requestFrame']) },
        stop() { this.stopped = true; stoppedTracks.push('canvas-video') },
      })],
    }),
  }
  const audioCtx = {
    silenceStarted: false,
    silenceStopped: false,
    createConstantSource() {
      return { offset: { value: 1 }, connect() {}, disconnect() {},
        start() { audioCtx.silenceStarted = true; assert.equal(this.offset.value, 0) },
        stop() { audioCtx.silenceStopped = true } }
    },
    closed: false,
    destination: { name: 'destination' },
    async resume() {},
    async close() { this.closed = true },
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [Object.assign(new EventTarget(), {
        kind: 'audio', readyState: 'live', stopped: false,
        stop() { this.stopped = true; stoppedTracks.push('dest-audio') },
      })] } }
    },
    createMediaStreamSource(stream) {
      assert.ok(Array.isArray(stream.tracks), 'AudioContext requires a MediaStream, not a track')
      const track = stream.tracks[0]
      const node = { track, connections: [], connected: true,
        connect(dest) { this.connections.push(dest); this.connected = true },
        disconnect() { this.connected = false; this.connections = [] } }
      sourceNodes.push(node)
      return node
    },
  }
  let schedulerWork = null
  const scheduler = {
    start(work) { schedulerWork = work },
    stop() { schedulerWork = null },
    tick() { schedulerWork && schedulerWork() },
    active: () => schedulerWork !== null,
  }
  const createdStreams = []
  return {
    video, canvas, audioCtx, scheduler, sourceNodes, stoppedTracks, draws, createdStreams,
    setPlayGate(gate) { playGate = gate },
    getPlayCount: () => playCount,
    deps: {
      createVideoElement: () => video,
      createAudioContext: () => audioCtx,
      createCanvas: (w, h) => { canvas.width = w; canvas.height = h; return canvas },
      createMediaStream: (tracks) => { const s = { tracks }; createdStreams.push(s); return s },
      scheduler,
    },
  }
}

// selection fixture factory
let seq = 0
function selection(over = {}) {
  seq += 1
  const videoTrack = Object.assign(new EventTarget(), {
    kind: 'video', readyState: 'live', id: `src-video-${seq}`, stopped: false,
    stop() { this.stopped = true },
  })
  const audioTrack = Object.assign(new EventTarget(), {
    kind: 'audio', readyState: 'live', id: `src-audio-${seq}`, stopped: false,
    stop() { this.stopped = true },
  })
  return {
    mode: 'host-camera', targetId: 'host-1', reason: '',
    video: { present: true, muted: false, track: { jitsiTrack: { getTrack: () => videoTrack } } },
    microphone: { present: true, muted: false, track: { jitsiTrack: { getTrack: () => audioTrack } } },
    share: { active: false, ended: false, identity: '' },
    ...over,
  }
}

async function main() {
  {
    const h = makeDeps()
    const videos = []
    h.deps.createVideoElement = () => {
      const video = { ...h.video, srcObject: null, async play() { this.videoWidth = 640; this.videoHeight = 360; this.readyState = 4 } }
      videos.push(video)
      return video
    }
    let ended = 0
    const engine = createDirectedRecordingEngine({ mode: 'composite', deps: h.deps, onShareEnded: () => ended++ })
    const host = selection()
    const share = selection({ share: { active: true, identity: 'share-1' } })
    await engine.start()
    await engine.applySource({ ...share, mode: 'composite', overlay: host.video, microphones: [host.microphone, share.microphone, host.microphone] })
    h.draws.length = 0
    h.scheduler.tick()
    assert.equal(h.draws.filter(d => d[0] === 'drawImage').length, 2, 'composite must draw share and host')
    assert.equal(h.sourceNodes.filter(n => n.connected).length, 2, 'deduplicate mixed microphones')
    const inset = h.draws.filter(d => d[0] === 'drawImage')[1]
    assert.ok(inset[2] > 1000 && inset[3] > 500, 'host inset is at bottom-right')
    await engine.applySource({ ...share, mode: 'composite', overlay: host.video, microphones: [host.microphone], share: { active: false, identity: 'share-1' } })
    assert.equal(ended, 1)
    await engine.dispose()
    assert.ok(videos.every(video => video.srcObject === null))
    assert.equal(host.video.track.jitsiTrack.getTrack().stopped, false)
    assert.equal(h.sourceNodes.filter(n => n.connected).length, 0)
  }
  // Unrelated Redux updates and mic changes must not reload or black out the camera.
  {
    const h = makeDeps()
    const engine = createDirectedRecordingEngine({ mode: 'host-camera', deps: h.deps })
    await engine.start()
    const sel = selection()
    await engine.applySource(sel)
    const stream = h.video.srcObject
    const plays = h.getPlayCount()
    h.draws.length = 0
    for (let i = 0; i < 50; i++) await engine.applySource({ ...sel })
    assert.equal(h.video.srcObject, stream, 'same camera must retain its MediaStream across state updates')
    assert.equal(h.getPlayCount(), plays, 'same camera must not restart playback')
    assert.equal(h.draws.length, 0, 'same-source state updates must not publish black frames')
    assert.equal(h.sourceNodes.length, 1, 'same microphone must not reconnect')
    await engine.applySource({ ...sel, microphone: { present: false, muted: true, track: null } })
    assert.equal(h.video.srcObject, stream, 'mic mute must not reset camera')
    assert.equal(h.draws.length, 0, 'mic mute must not black out camera')
    assert.equal(h.sourceNodes.filter(n => n.connected).length, 0)
    h.scheduler.tick()
    assert.deepEqual(h.draws.map(d => d[0]), ['fillRect', 'drawImage', 'requestFrame'], 'publish only after complete video composition')
    await engine.applySource({ ...sel, video: { present: true, muted: true, track: null } })
    assert.equal(h.video.srcObject, null, 'camera mute must clear the source')
    assert.equal(h.draws.at(-1)[0], 'requestFrame', 'intentional black frame is published')
    await engine.applySource(sel)
    assert.equal(h.getPlayCount(), plays + 1, 'camera unmute restarts playback')
    sel.video.track.jitsiTrack.getTrack().dispatchEvent(new Event('ended'))
    assert.equal(h.video.srcObject, null, 'same-source updates must preserve ended listener')
    await engine.dispose()
  }
  // --- output identity stable + has audio even before any source ---
  {
    const h = makeDeps()
    const engine = createDirectedRecordingEngine({ mode: 'host-camera', deps: h.deps })
    await engine.start()
    const stream = engine.getOutputStream()
    assert.ok(stream, 'output stream exists after start')
    assert.ok(h.audioCtx.silenceStarted, 'Continuous zero-valued audio source keeps silent recordings encodable')
    assert.equal(stream.tracks.length, 2, 'output = canvas video + audio destination')
    assert.equal(stream.tracks.filter((t) => t.kind === 'audio').length, 1, 'output always has an audio track (silence when no mic)')
    const sel = selection()
    await engine.applySource(sel)
    await engine.applySource(selection({ targetId: 'host-2' }))
    assert.equal(engine.getOutputStream(), stream, 'output stream identity stable across source switches')
    assert.equal(engine.getOutputStream().tracks.length, 2)
    // draw loop produced frames
    h.scheduler.tick()
    assert.ok(h.draws.some((d) => d[0] === 'drawImage'), 'draw loop draws the active video')
    await engine.dispose()
    assert.ok(h.audioCtx.closed, 'audio context closed on dispose')
    assert.ok(h.audioCtx.silenceStopped, 'Owned silence source stopped on dispose')
  }

  // --- black when muted / no camera ---
  {
    const h = makeDeps()
    const engine = createDirectedRecordingEngine({ mode: 'host-camera', deps: h.deps })
    await engine.start()
    await engine.applySource(selection({ video: { present: true, muted: true, track: null } }))
    h.draws.length = 0
    h.scheduler.tick()
    assert.deepEqual(h.draws.map(d => d[0]), ['fillRect', 'requestFrame'], 'muted camera publishes black only')
    await engine.dispose()
  }

  // --- audio reconnect: exactly one connected source node, follows target mic ---
  {
    const h = makeDeps()
    const engine = createDirectedRecordingEngine({ mode: 'host-camera', deps: h.deps })
    await engine.start()
    const first = selection()
    await engine.applySource(first)
    const second = selection({ targetId: 'host-2' })
    const secondAudioId = second.microphone.track.jitsiTrack.getTrack().id
    await engine.applySource(second)
    const connected = h.sourceNodes.filter((n) => n.connected)
    assert.equal(connected.length, 1, 'only the current target mic stays connected')
    assert.equal(connected[0].track.id, secondAudioId, 'connected mic belongs to the new target')
    assert.equal(h.sourceNodes.filter((n) => !n.connected).length, 1, 'previous mic disconnected')
    // muted mic → silence (no node connected), still one audio track on output
    await engine.applySource(selection({ microphone: { present: true, muted: true, track: null } }))
    assert.equal(h.sourceNodes.filter((n) => n.connected).length, 0, 'muted conference mic yields silence, never bypassed')
    assert.equal(engine.getOutputStream().tracks.filter((t) => t.kind === 'audio').length, 1)
    await engine.dispose()
  }

  // --- generation guard: late play() of a stale source cannot restore old host ---
  {
    const h = makeDeps()
    let gate = null
    h.setPlayGate(new Promise((resolve) => { gate = resolve }))
    const engine = createDirectedRecordingEngine({ mode: 'host-camera', deps: h.deps })
    await engine.start()
    const stale = selection({ targetId: 'old-host' })
    const applying = engine.applySource(stale)
    h.setPlayGate(null)
    await engine.applySource(selection({ targetId: 'new-host' }))
    gate() // stale play resolves late
    await applying
    h.draws.length = 0
    h.scheduler.tick()
    const images = h.draws.filter((d) => d[0] === 'drawImage')
    assert.ok(images.length > 0, 'drawing continues after stale play resolved')
    await engine.dispose()
  }

  // --- shared screen: share-ended callback exactly once, replacement also ends ---
  {
    const h = makeDeps()
    let ended = 0
    const engine = createDirectedRecordingEngine({
      mode: 'shared-screen',
      deps: h.deps,
      onShareEnded: () => { ended += 1 },
    })
    await engine.start()
    const activeShare = selection({ mode: 'shared-screen', targetId: 'sharer', share: { active: true, ended: false, identity: 'sharer:desk-1' } })
    await engine.applySource(activeShare)
    // same share still active → no end
    await engine.applySource(selection({ mode: 'shared-screen', targetId: 'sharer', share: { active: true, ended: false, identity: 'sharer:desk-1' } }))
    assert.equal(ended, 0, 'reapplying the same share must not end recording')
    // sharer stops (lingering muted entry, no active identity)
    await engine.applySource(selection({ mode: 'shared-screen', targetId: 'sharer', share: { active: false, ended: false, identity: '' } }))
    assert.equal(ended, 1, 'share stop fires onShareEnded exactly once')
    // further applies do not refire
    await engine.applySource(selection({ mode: 'shared-screen', targetId: 'other', share: { active: true, ended: false, identity: 'other:desk-2' } }))
    assert.equal(ended, 1, 'no continuation / no refire after share ended')
    await engine.dispose()
  }

  // --- dispose: idempotent, stops only owned tracks, never source tracks ---
  {
    const h = makeDeps()
    const engine = createDirectedRecordingEngine({ mode: 'host-camera', deps: h.deps })
    await engine.start()
    const sel = selection()
    await engine.applySource(sel)
    const videoSource = sel.video.track.jitsiTrack.getTrack()
    const audioSource = sel.microphone.track.jitsiTrack.getTrack()
    const destTrack = engine.getOutputStream().tracks.find((t) => t.kind === 'audio')
    await engine.dispose()
    await engine.dispose()
    assert.equal(videoSource.stopped, false, 'source video track must never be stopped by dispose')
    assert.equal(audioSource.stopped, false, 'source audio track must never be stopped by dispose')
    assert.equal(destTrack.stopped, true, 'owned destination audio track stopped')
    assert.ok(h.stoppedTracks.includes('canvas-video'), 'owned canvas track stopped')
    assert.equal(h.scheduler.active(), false, 'scheduler stopped')
  }

  // --- start-block reasons ---
  {
    const h = makeDeps()
    let ended = 0
    const engine = createDirectedRecordingEngine({ mode: 'shared-screen', deps: h.deps, onShareEnded: () => ended++ })
    await engine.start()
    const share = selection({ share: { active: true, ended: false, identity: 'host:share' } })
    await engine.applySource(share)
    const track = share.video.track.jitsiTrack.getTrack()
    track.dispatchEvent(new Event('ended'))
    track.dispatchEvent(new Event('ended'))
    assert.equal(ended, 1, 'Source ended must finish without waiting for Redux')
    await engine.dispose()
  }
  assert.equal(getRecordingStartBlockReason(null, 'host-camera'), '会议状态暂不可读，请稍后重试')
  assert.equal(getRecordingStartBlockReason({ reason: 'no-host' }, 'host-camera'), '当前没有主持人，无法开始录制主持人视频')
  assert.equal(getRecordingStartBlockReason({ reason: 'no-active-share' }, 'shared-screen'), '当前没有进行中的屏幕共享')
  assert.equal(getRecordingStartBlockReason({ reason: 'ambiguous-share' }, 'shared-screen'), '多人同时共享屏幕，无法确定录制目标')
  assert.equal(getRecordingStartBlockReason({ reason: 'ambiguous-mic' }, 'host-camera'), '目标麦克风状态不明确，无法安全录制')
  assert.equal(getRecordingStartBlockReason({ reason: '', share: { active: true } }, 'shared-screen'), '')
  assert.equal(getRecordingStartBlockReason({ reason: '', targetId: 'x' }, 'host-camera'), '')

  console.log('PASS web directed recording engine lifecycle')
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
})
