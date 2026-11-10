const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
const script = source.split('<script setup lang="ts">')[1].split('</script>')[0]
const tree = ts.createSourceFile('stage.ts', script, ts.ScriptTarget.Latest, true)

function harness() {
  let nextId = 0
  const timers = new Map(), calls = []
  const rect = { width: 1280, height: 722 }
  const c = {
    meetingStageRoot: { value: { getBoundingClientRect: () => rect } },
    window: { setTimeout(fn) { timers.set(++nextId, fn); return nextId }, clearTimeout(id) { timers.delete(id) } },
    refreshJitsiLayoutAfterWindowResize: () => calls.push('resize'),
    fullscreen: { value: false }, fullscreenToolbarVisible: { value: false },
    syncFullscreenTileViewGutterStyle: () => calls.push('gutter'),
    syncDesktopFullscreenMainVideoStyle: () => calls.push('style'),
    refreshAndroidFullscreenLayout: () => {}, scheduleMeetingBannerOverlaySync: () => {},
  }
  vm.createContext(c)
  const names = ['clearJitsiWindowResizeRefreshTimers', 'scheduleJitsiWindowResizeRefresh', 'setFullscreenState']
  const code = tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
    .map(n => n.getText(tree)).join('\n')
  vm.runInContext(ts.transpile('let jitsiWindowResizeRefreshTimer; let lastMeetingStageSizeKey="";\n' + code), c)
  const flush = () => { const tasks = [...timers.values()]; timers.clear(); tasks.forEach(fn => fn()) }
  return { c, rect, timers, calls, flush }
}

test('rapid resize cancels stale refresh and runs only after the latest size', () => {
  const { c, rect, timers, calls, flush } = harness()
  for (const width of [1280, 1400, 1600, 1707]) {
    rect.width = width
    c.scheduleJitsiWindowResizeRefresh()
    assert.equal(timers.size, 1)
  }
  flush()
  assert.deepEqual(calls, ['resize'])
  c.scheduleJitsiWindowResizeRefresh()
  assert.equal(timers.size, 0, 'Duplicate ResizeObserver size is ignored')
  c.scheduleJitsiWindowResizeRefresh(true)
  assert.equal(timers.size, 1, 'Shell fullscreen notification can force same-size recovery')
})

test('fullscreen round trips sync CSS immediately and coalesce pending layout recovery', () => {
  const { c, timers, calls, flush } = harness()
  for (let i = 0; i < 6; i++) {
    c.setFullscreenState(true)
    c.fullscreenToolbarVisible.value = true
    c.setFullscreenState(false)
    assert.equal(c.fullscreenToolbarVisible.value, false)
    assert.equal(timers.size, 1)
  }
  assert.equal(calls.filter(x => x === 'style').length, 12)
  flush()
  assert.equal(calls.filter(x => x === 'resize').length, 1)
})

test('unmount cancels pending work and missing or hidden stage schedules nothing', () => {
  const { c, rect, timers, calls, flush } = harness()
  c.scheduleJitsiWindowResizeRefresh()
  c.clearJitsiWindowResizeRefreshTimers()
  flush()
  assert.deepEqual(calls, [])
  rect.height = 0
  c.scheduleJitsiWindowResizeRefresh(true)
  c.meetingStageRoot.value = null
  c.scheduleJitsiWindowResizeRefresh(true)
  assert.equal(timers.size, 0)
  const unmount = source.slice(source.indexOf('onBeforeUnmount('))
  assert.match(unmount, /clearJitsiWindowResizeRefreshTimers\(\)/)
})
