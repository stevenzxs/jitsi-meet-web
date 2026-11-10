const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync('src/components/MeetingStage.vue', 'utf8')
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0]
const tree = ts.createSourceFile('stage.ts', script, ts.ScriptTarget.Latest, true)
function harness(host) {
  const calls = []
  const context = {
    props: { mode: 'desktop' }, status: { value: 'joined' }, localModerator: { value: host },
    jitsiApi: { value: {} }, getJoinedModeratorConference: () => host,
    localRecording: { value: false }, localRecordingBusy: { value: false },
    startLocalRecording: () => calls.push('start'), stopLocalRecording: () => calls.push('save'),
    stopTilePolling: () => calls.push('stop-polling'), pollingDialogOpen: { value: true },
    recordingPermissionGeneration: 0, showStageToast: () => {},
    customToolbar: { value: null }, tilePollingControlAvailable: { value: true },
  }
  for (const name of ['canUseHostMediaControls', 'toggleLocalRecording', 'toggleTilePolling', 'onPollingDialogConfirm', 'revokeHostMediaControls']) {
    const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === name)
    assert.ok(node, `missing ${name}`)
    vm.runInNewContext(ts.transpile(node.getText(tree)), context)
  }
  return { context, calls }
}
test('guest cannot start recording or open/confirm polling even with stale availability', () => {
  const { context: c, calls } = harness(false)
  c.pollingDialogOpen.value = false
  c.toggleLocalRecording(); c.toggleTilePolling(); c.onPollingDialogConfirm(['guest'])
  assert.deepEqual(calls, [])
  assert.equal(c.pollingDialogOpen.value, false)
})
test('host can start recording; revocation saves recording and stops polling', () => {
  const { context: c, calls } = harness(true)
  c.toggleLocalRecording()
  assert.deepEqual(calls, ['start'])
  c.localRecording.value = true
  c.revokeHostMediaControls()
  assert.deepEqual(calls, ['start', 'stop-polling', 'save'])
  assert.equal(c.pollingDialogOpen.value, false)
  assert.equal(c.recordingPermissionGeneration, 1)
})
test('cached host state cannot authorize actions after live role loss', () => {
  const { context: c, calls } = harness(true)
  c.getJoinedModeratorConference = () => null
  c.toggleLocalRecording(); c.toggleTilePolling(); c.onPollingDialogConfirm([])
  assert.deepEqual(calls, [])
})
test('concurrent permission-loss and hangup callers await the same save', async () => {
  let resolveSave
  let saves = 0
  const context = { finishLocalRecording: () => {
    saves++
    return new Promise(resolve => { resolveSave = resolve })
  } }
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'stopLocalRecording')
  vm.runInNewContext('let recordingStopPromise = null;\n' + ts.transpile(node.getText(tree)), context)
  const first = context.stopLocalRecording()
  const second = context.stopLocalRecording()
  assert.equal(first, second)
  assert.equal(saves, 1)
  resolveSave()
  await second
})
test('permission lost while awaiting recording settings cancels startup', async () => {
  const { context: c } = harness(true)
  let resolveSettings
  let reset = false
  Object.assign(c, {
    window: { parent: {} }, MediaRecorder: function () {},
    localRecordingError: { value: '' },
    recordingGroup: null,
    getDesktopRecordingSettings: () => new Promise(resolve => { resolveSettings = resolve }),
    resetLocalRecordingState: () => { reset = true },
    getRecordingErrorMessage: error => error.message,
  })
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'startLocalRecording')
  vm.runInNewContext(ts.transpile(node.getText(tree)), c)
  const pending = c.startLocalRecording()
  c.recordingPermissionGeneration++
  c.localModerator.value = false
  resolveSettings({})
  await pending
  assert.equal(reset, true)
  assert.match(c.localRecordingError.value, /主持人权限已失效/)
  assert.equal(c.localRecording.value, false)
})
test('toolbar, bridge and asynchronous recording start enforce host permission', () => {
  assert.match(source, /:recording-available="hostMediaControlsVisible"/)
  assert.match(source, /:tile-polling-visible="hostMediaControlsVisible"/)
  assert.match(source, /available: hostMediaControlsVisible.value && canUseHostMediaControls\(\)/)
  assert.match(source, /if \(!canUseHostMediaControls\(\)\) return \{ ok: false/)
  assert.ok((source.match(/assertRecordingPermission\(\)/g) || []).length >= 4)
  assert.match(source, /watch\(\[localModerator, status, jitsiApi\]/)
})
