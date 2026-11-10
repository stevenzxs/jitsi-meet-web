const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync('src/components/MeetingStage.vue', 'utf8')
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0]
const tree = ts.createSourceFile('stage.ts', script, ts.ScriptTarget.Latest, true)
test('transfer action is registered before promotion, with live authorization at click', () => {
  const frame = fs.readFileSync('src/components/JitsiFrame.vue', 'utf8')
  assert.doesNotMatch(frame, /props\.jwt\s*\?\s*\{\s*customParticipantMenuButtons/)
  assert.match(frame, /customParticipantMenuButtons: \[\{/)
  assert.match(source, /if \(!localModerator.value \|\| !hostKey.value \|\| !getJoinedModeratorConference\(api\)/)
})
function runFunction(name, context) {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === name)
  vm.runInNewContext(ts.transpile(node.getText(tree)), context)
  return context[name]
}
test('source transfer clears credentials and reconciles without replacing conference', async () => {
  const api = {}
  const calls = []
  const c = {
    transferTarget: { value: { id: 'target' } }, jitsiApi: { value: api },
    hostKey: { value: 'old' }, hostToken: { value: 'old-jwt' },
    transferBusy: { value: false }, reclaimBusy: { value: false }, localModerator: { value: true },
    props: { roomName: '123456789' }, getParticipantRole: () => 'participant',
    getJoinedModeratorConference: () => ({}), requestHostTransfer: async () => {},
    clearTransferredHostKey: () => calls.push('clear'), showStageToast: () => {},
    reloadMeetingIframe: () => calls.push('reload'), reconcileMeetingPermissions: () => calls.push('reconcile'),
  }
  await runFunction('confirmHostTransfer', c)()
  assert.deepEqual(calls, ['clear', 'reconcile'])
  assert.equal(c.hostToken.value, null)
  assert.equal(c.hostKey.value, '')
  assert.equal(c.jitsiApi.value, api)
})
test('passive demotion removes old credentials without reconnecting', () => {
  const calls = []
  const c = {
    localModerator: { value: true }, localRole: { value: 'moderator' }, hostKey: { value: 'old' }, hostToken: { value: 'jwt' },
    props: { roomName: '123456789' }, getPendingHostTransfer: () => null,
    clearTransferredHostKey: () => calls.push('clear'), transferBusy: { value: false },
    reloadMeetingIframe: () => calls.push('reload'), shellCloseMenuCanEndForAll: { value: true },
    bannerPanelOpen: { value: true }, localParticipantId: { value: 'source' }, removeParticipantMeetingBannerState: () => {},
  }
  runFunction('setLocalModerator', c)(false, 'participant')
  assert.deepEqual(calls, ['clear'])
  assert.equal(c.localModerator.value, false)
})
test('target completion keeps live API and rejects superseded credential fetch', async () => {
  const setup = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'setupMeetingApiListeners')
  let callback
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'onComplete') callback = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(setup)
  const api = {}
  let pending = { hostKey: 'new' }
  let resolveToken
  const c = {
    api, jitsiApi: { value: api }, status: { value: 'joined' }, props: { roomName: '123456789' },
    displayName: { value: 'target' }, session: {}, hostKey: { value: '' }, hostToken: { value: null },
    reclaimDialogOpen: { value: true }, getPendingHostTransfer: () => pending,
    fetchHostToken: () => new Promise(resolve => { resolveToken = resolve }),
    getJoinedModeratorConference: () => ({}),
    reloadMeetingIframe: () => { throw Error('must not reload') }, reconcileMeetingPermissions: () => {},
  }
  vm.runInNewContext(ts.transpile('var complete = ' + callback.getText(tree)), c)
  const first = c.complete('new'); resolveToken('new-jwt'); await first
  assert.equal(c.hostToken.value, 'new-jwt')
  const stale = c.complete('new'); pending = { hostKey: 'replacement' }; resolveToken('stale-jwt')
  await assert.rejects(stale)
  assert.equal(c.hostToken.value, 'new-jwt')
})
