const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

function harness(options = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/utils/recordingGroup.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports })
  const jobs = [], finished = [], canceled = [], errors = []
  let group
  group = exports.createRecordingGroup({
    async create(mode, onEnded) {
      const job = { mode, onEnded, disposed: false,
        async start() {
          if (mode === options.failStart) throw new Error('start failed')
          if (mode === options.endPreviousOnStart) await jobs[0].onEnded()
        },
        async finish(cancel) {
          (cancel ? canceled : finished).push(mode)
          if (mode === options.failFinish) throw new Error('save failed')
        },
        async dispose() { this.disposed = true },
      }
      jobs.push(job)
      return job
    },
    onChanged() {}, onError: error => errors.push(error),
  })
  return { group, jobs, finished, canceled, errors }
}

test('three selected modes create three jobs; share ending does not stop host', async () => {
  const h = harness()
  await h.group.start(['host-camera', 'shared-screen', 'composite'])
  assert.equal(h.jobs.length, 3)
  await h.jobs[1].onEnded()
  await h.jobs[2].onEnded()
  assert.deepEqual(h.finished, ['shared-screen', 'composite'])
  assert.equal(h.group.active, true)
  await Promise.all([h.group.stop(), h.group.stop()])
  assert.deepEqual(h.finished, ['shared-screen', 'composite', 'host-camera'])
  assert.ok(h.jobs.every(job => job.disposed))
})
test('startup failure cancels and disposes every allocated job', async () => {
  const h = harness({ failStart: 'shared-screen' })
  await assert.rejects(h.group.start(['host-camera', 'shared-screen', 'composite']), /start failed/)
  assert.deepEqual(h.canceled, ['host-camera', 'shared-screen'])
  assert.equal(h.group.active, false)
  assert.ok(h.jobs.every(job => job.disposed))
})
test('save failure does not discard other outputs', async () => {
  const h = harness({ failFinish: 'shared-screen' })
  await h.group.start(['host-camera', 'shared-screen', 'composite'])
  await h.group.stop()
  assert.deepEqual(h.finished, ['host-camera', 'shared-screen', 'composite'])
  assert.equal(h.errors.length, 1)
  assert.ok(h.jobs.every(job => job.disposed))
})
test('empty selection is rejected rather than silently recording another mode', async () => {
  const h = harness()
  await assert.rejects(h.group.start([]), /至少选择/)
  assert.equal(h.jobs.length, 0)
})
test('a previously started share ending during sibling startup is saved', async () => {
  const h = harness({ endPreviousOnStart: 'composite' })
  await h.group.start(['shared-screen', 'composite'])
  assert.deepEqual(h.finished, ['shared-screen'])
  await h.group.stop()
})

for (const delayedShare of [false, true]) test(`MeetingStage owns independent disk sessions (delayedShare=${delayedShare})`, async () => {
  const stage = fs.readFileSync('src/components/MeetingStage.vue', 'utf8').split('<script setup lang="ts">')[1].split('</script>')[0]
  const tree = ts.createSourceFile('stage.ts', stage, ts.ScriptTarget.Latest, true)
  const groupExports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/utils/scheduledRecordingGroup.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: groupExports })
  const sessions = [], writes = [], finishes = [], engines = [], recorders = []
  let share = delayedShare ? '' : 'share1'
  const listeners = new Set()
  const adapter = {
    select: mode => ({ reason: mode !== 'host-camera' && !share ? 'no-active-share' : '', share: { identity: share } }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const notify = async () => {
    for (const listener of [...listeners]) listener()
    await c.recordingGroup.refresh()
  }
  const conference = {}
  const c = {
    props: { mode: 'desktop', roomName: 'room' }, window: { parent: {} }, MediaRecorder: function () {},
    localRecording: { value: false }, localRecordingBusy: { value: false }, localRecordingError: { value: '' },
    recordingGroup: null, recordingPermissionGeneration: 0, recordingStopSilent: false,
    jitsiApi: { value: {} }, displaySubject: { value: '会议' },
    canUseHostMediaControls: () => true, getJoinedModeratorConference: () => conference,
    getDesktopRecordingSettings: async () => ({ recording: { modes: ['host-camera', 'shared-screen', 'composite'] } }),
    pickSupportedMimeType: types => types[0],
    createRecordingSourcesAdapter: () => adapter,
    getRecordingStartBlockReason: selection => selection.reason, createRecordingGroup: groupExports.createRecordingGroup,
    createDirectedRecordingEngine(options) {
      const engine = { options, disposed: false, async start() {}, async applySource() {},
        getOutputStream: () => ({ getVideoTracks: () => [{}], getAudioTracks: () => [], getTracks: () => [] }),
        async dispose() { this.disposed = true },
      }
      engines.push(engine)
      return engine
    },
    createRecordingMediaRecorder() {
      const listeners = {}
      const recorder = { mimeType: 'video/webm', state: 'inactive',
        addEventListener: (type, fn) => { listeners[type] = fn },
        start() { this.state = 'recording'; listeners.dataavailable({ data: { size: 10 } }) },
        stop() { this.state = 'inactive'; listeners.dataavailable({ data: { size: 5 } }); listeners.stop?.() },
      }
      recorders.push(recorder)
      return recorder
    },
    async startDesktopRecordingSession(options) { sessions.push(options); return { sessionId: `s${sessions.length}` } },
    async writeDesktopRecordingChunk(id, kind) { writes.push([id, kind]) },
    async finishDesktopRecordingSession(id) { finishes.push(id); return {} },
    async cancelDesktopRecordingSession() { throw new Error('unexpected cancellation') },
    recordingTranscodes: { start() {}, finish() { return '' }, cancel() {} },
    getRecordingErrorMessage: error => error.message, showStageToast() {}, console,
  }
  for (const name of ['stopRecorder', 'resetLocalRecordingState', 'startLocalRecording', 'finishLocalRecording']) {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === name)
    vm.runInNewContext(ts.transpile(node.getText(tree)), c)
  }
  await c.startLocalRecording()
  assert.equal(c.localRecordingError.value, '')
  if (delayedShare) {
    assert.deepEqual(sessions.map(s => s.mode), ['host-camera'])
    share = 'share1'
    await notify()
  }
  assert.deepEqual(sessions.map(s => s.mode), ['host-camera', 'shared-screen', 'composite'])
  assert.deepEqual(writes, [['s1', 'video'], ['s2', 'video'], ['s3', 'video']])
  engines[1].options.onShareEnded()
  engines[2].options.onShareEnded()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(c.localRecording.value, true)
  assert.equal(recorders[0].state, 'recording')
  if (delayedShare) {
    share = ''
    await notify()
    share = 'share2'
    await notify()
    assert.deepEqual(sessions.map(s => s.mode), ['host-camera', 'shared-screen', 'composite', 'shared-screen', 'composite'])
    assert.equal(recorders[0].state, 'recording')
  }
  await c.finishLocalRecording()
  assert.deepEqual(finishes.sort(), delayedShare ? ['s1', 's2', 's3', 's4', 's5'] : ['s1', 's2', 's3'])
  assert.equal(writes.length, sessions.length * 2, 'final chunks flushed before session finish')
  assert.ok(engines.every(e => e.disposed))
  assert.equal(c.localRecording.value, false)
  assert.equal(listeners.size, 0)
  share = 'share3'
  for (const listener of listeners) listener()
  assert.equal(sessions.length, delayedShare ? 5 : 3)
})
