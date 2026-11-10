const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const stage = fs.readFileSync(path.join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
const confirm = stage.slice(stage.indexOf('function onPollingDialogConfirm('), stage.indexOf('function onPollingDialogStop('))
const events = []
const c = vm.createContext({ pollingGroupIds: {}, pollingDialogOpen: {}, tilePollingEnabled: { value: false }, activeMeetingLayout: { value: 'polling' }, pollingCursor: 0,
  canUseHostMediaControls: () => true,
  applyMeetingLayout() {}, restartTilePolling() {}, showStageToast() {}, refreshPollingSlots() {}, notifyShellLayoutChanged: mode => events.push(mode) })
vm.runInContext(ts.transpile('let pollingGroupConfigured=false;\n' + confirm), c)
c.onPollingDialogConfirm(['member'])
assert.deepEqual(events, ['polling'], 'Starting while already in polling layout must resync the shell')
c.canUseHostMediaControls = () => false
c.pollingDialogOpen.value = true
c.onPollingDialogConfirm(['unauthorized-member'])
assert.equal(c.pollingDialogOpen.value, false)
assert.deepEqual([...c.pollingGroupIds.value], ['member'], 'Revoked host cannot replace the polling group')
assert.deepEqual(events, ['polling'], 'Revoked host cannot start polling or notify the shell')
console.log('PASS polling restart title sync (card positioning covered by test-polling-card)')
