const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
const start = source.indexOf('const sharingRecordingControl =')
const end = source.indexOf('\nconst sharingRecordingWindow', start)
assert.ok(start > 0 && end > start)
const code = ts.transpileModule(source.slice(start, end), {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText
let toggles = 0
const context = {props: {mode: 'desktop'}, window: {parent: {}}, MediaRecorder: function () {},
  localRecording: {value: false}, localRecordingBusy: {value: false}, localRecordingError: {value: ''},
  toggleLocalRecording() { toggles++ },
  hostMediaControlsVisible: { value: true },
  canUseHostMediaControls: () => context.props.mode === 'desktop' && context.hostMediaControlsVisible.value,
}
vm.createContext(context)
vm.runInContext(code + '\nglobalThis.control = sharingRecordingControl', context)
assert.equal(context.control.getState().available, true)
assert.equal(context.control.toggle().ok, true)
assert.equal(toggles, 1)
context.hostMediaControlsVisible.value = false
assert.equal(context.control.getState().available, false)
assert.equal(context.control.toggle().ok, false)
assert.equal(toggles, 1, 'guest cannot invoke hidden recording action')
context.hostMediaControlsVisible.value = true
context.localRecording.value = true
assert.equal(context.control.getState().active, true, 'meeting toolbar changes propagate to floater queries')
context.localRecordingBusy.value = true
assert.equal(context.control.toggle().ok, false)
assert.equal(toggles, 1, 'busy recording cannot be toggled twice')
context.localRecordingError.value = '选源失败'
assert.equal(context.control.getState().error, '选源失败')
context.props.mode = 'web'
assert.equal(context.control.getState().available, false)
assert.equal(context.control.toggle().ok, false)
assert.match(source, /onBeforeUnmount\(\(\) => \{\s*if \(sharingRecordingWindow\.__cloudmeetRecording === sharingRecordingControl\) delete sharingRecordingWindow\.__cloudmeetRecording/)
console.log('PASS sharing toolbar delegates recording to the existing meeting controller, reflects state and cleans up')
