const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
function body(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  const marker = '): void {'
  return source.slice(source.indexOf(marker, start) + marker.length, source.indexOf('\n}', start))
}

// Model Jitsi's persistent preferred size and native filmstrip deduction.
const viewport = { width: 1280, height: 722 }
const manager = {
  preferredWidth: 1280, preferredHeight: 722,
  update(width, height) {
    if (typeof width === 'number') this.preferredWidth = width
    if (typeof height === 'number') this.preferredHeight = height
    this.width = (this.preferredWidth || viewport.width) - 150
    this.height = this.preferredHeight || viewport.height
  },
}
const commands = []
const frame = {
  get clientWidth() { return viewport.width },
  get clientHeight() { return viewport.height },
  contentWindow: { Event, dispatchEvent() { manager.update() } },
}
const api = {
  getIFrame: () => frame,
  executeCommand(command, ...args) {
    commands.push([command, ...args])
    if (command === 'resizeLargeVideo') manager.update(...args)
  },
}
const context = vm.createContext({
  console, api, jitsiApi: { value: api },
  activeMeetingLayout: { value: 'default' }, tilePollingEnabled: { value: false },
  getMeetingLayoutTileCount: mode => mode === 'grid-4' ? 4 : 0,
  applyTileViewLayout() {}, scheduleMeetingBannerOverlaySync() {},
})
vm.runInContext(`function forceJitsiLayoutReflow(api) {${body('forceJitsiLayoutReflow').replace(/ as Window & \{ Event: typeof Event \}/g, '')}}`, context)
vm.runInContext(`function refreshJitsiLayoutAfterWindowResize() {${body('refreshJitsiLayoutAfterWindowResize')}}`, context)

// A layout reflow must not pin the small-window dimensions for future resizes.
vm.runInContext('forceJitsiLayoutReflow(api)', context)
viewport.width = 1707
viewport.height = 812
manager.update()
assert.equal(manager.width, 1557, 'Reflow must preserve native responsive width and filmstrip deduction')
assert.equal(manager.height, 812, 'Reflow must preserve native responsive height')

// Recover a stale preference from an earlier build/session on default-layout resize.
manager.update(1280, 722)
vm.runInContext('refreshJitsiLayoutAfterWindowResize()', context)
assert.equal(manager.width, 1557, 'Default layout resize must release old preferred dimensions')
assert.equal(manager.height, 812)
for (let i = 0; i < 6; i++) {
  viewport.height = i % 2 ? 812 : 960
  vm.runInContext('refreshJitsiLayoutAfterWindowResize()', context)
  assert.equal(manager.height, viewport.height, 'Fullscreen round trips stay responsive')
}
commands.length = 0
context.activeMeetingLayout.value = 'grid-4'
vm.runInContext('refreshJitsiLayoutAfterWindowResize()', context)
assert.equal(commands.length, 0, 'Grid resize must not force large-video repaint')
context.activeMeetingLayout.value = 'polling'
vm.runInContext('refreshJitsiLayoutAfterWindowResize()', context)
assert.equal(commands.length, 0, 'Polling resize is unaffected')
context.activeMeetingLayout.value = 'default'
manager.update(1280, 722)
viewport.width = 0
vm.runInContext('refreshJitsiLayoutAfterWindowResize()', context)
assert.equal(commands.length, 0, 'Hidden iframe must not trigger resize')
viewport.width = 1707
context.jitsiApi.value = null
vm.runInContext('refreshJitsiLayoutAfterWindowResize()', context)
assert.equal(commands.length, 0, 'Disposed meeting must not trigger resize')
// Execute the actual default branch, not just a source-text presence check.
context.jitsiApi.value = api
context.scheduleMeetingBannerOverlaySync = () => {}
context.options = { silent: true }
manager.update(1280, 722)
commands.length = 0
const defaultBranch = body('applyMeetingLayout').match(/if \(mode === 'default'\) \{([\s\S]*?)return/)[1]
vm.runInContext(defaultBranch, context)
assert.deepEqual(commands.map(c => c[0]), ['pinParticipant', 'setTileView', 'resizeLargeVideo'])
assert.equal(manager.width, 1557, 'Returning from grid immediately releases the preferred width')
assert.equal(manager.height, 812, 'Returning from grid immediately releases the preferred height')
console.log('PASS main video responsive sizing, stale preference recovery and grid isolation')
