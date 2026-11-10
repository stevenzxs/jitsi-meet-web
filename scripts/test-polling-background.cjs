const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const source = readFileSync(join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
const rule = selector => {
  const start = source.indexOf(`${selector} {`)
  assert.ok(start >= 0, `Missing CSS rule: ${selector}`)
  return source.slice(start, source.indexOf('}', start))
}
assert.match(rule('.polling-slot'), /background:\s*transparent\s*;/, 'Slots should expose the meeting background, not a black backing')
assert.match(rule('.meeting-stage__polling'), /background:\s*var\(--bg-0\)\s*;/, 'Overlay must still hide the underlying Jitsi UI')
assert.match(rule('.polling-slot :deep(video)'), /object-fit:\s*contain\s*;/, 'Preserve the full video without cropping')
console.log('PASS polling background: transparent slots, opaque meeting overlay, uncropped video')
