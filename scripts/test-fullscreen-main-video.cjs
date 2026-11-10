const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
const match = source.match(/function syncDesktopFullscreenMainVideoStyle\(\): void \{([\s\S]*?doc.head.appendChild\(style\))\n\}/)
assert.ok(match, 'Desktop fullscreen main-video style sync must exist')
const nodes = new Map()
const doc = {
  head: { appendChild: node => nodes.set(node.id, node) },
  getElementById: id => nodes.get(id),
  createElement: () => ({ remove() { nodes.delete(this.id) } }),
}
const context = {
  props: { mode: 'desktop' }, androidEmbed: false,
  fullscreen: { value: true }, activeMeetingLayout: { value: 'default' },
  getJitsiFrameDocument: () => doc,
}
vm.createContext(context)
vm.runInContext(`function syncDesktopFullscreenMainVideoStyle() {${match[1].replace(/ as HTMLStyleElement \| null/g, '')}\n}`, context)
const sync = () => vm.runInContext('syncDesktopFullscreenMainVideoStyle()', context)
sync()
assert.equal(nodes.size, 1)
const css = [...nodes.values()][0].textContent
assert.match(css, /#largeVideoWrapper\s*\{[^}]*inset:\s*0 !important;[^}]*width:\s*100% !important;[^}]*height:\s*100% !important;/)
assert.match(css, /#largeVideo\s*\{[^}]*object-fit:\s*contain !important;/)
assert.doesNotMatch(css, /100vw|#filmstrip|#remoteVideos/)
sync()
assert.equal(nodes.size, 1, 'Repeated sync must not add styles')
for (const mode of ['auto', 'grid-4', 'polling']) {
  context.activeMeetingLayout.value = mode
  sync()
  assert.equal(nodes.size, 0, `${mode} must keep native layout`)
}
context.activeMeetingLayout.value = 'default'
sync()
context.fullscreen.value = false
sync()
assert.equal(nodes.size, 0, 'Exit fullscreen restores native sizing')
context.fullscreen.value = true
context.androidEmbed = true
sync()
assert.equal(nodes.size, 0, 'Android is unaffected')
context.androidEmbed = false
context.props.mode = 'web'
sync()
assert.equal(nodes.size, 0, 'Web mode is unaffected')
for (const name of ['ensureLargeVideoFitStyle', 'applyMeetingLayout', 'setFullscreenState']) {
  const start = source.indexOf(`function ${name}(`)
  const body = source.slice(start, source.indexOf('\n}', start))
  assert.match(body, /syncDesktopFullscreenMainVideoStyle\(\)/, `${name} must sync main-video sizing`)
}
console.log('PASS desktop fullscreen main video sizing and layout isolation')
