import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('versioned Android entry gates MeetingStage and never parses legacy query credentials', () => {
  const view = fs.readFileSync(new URL('../src/views/DesktopMeetingView.vue', import.meta.url), 'utf8')
  assert.match(view, /route\.query\.credentialBridge === '1'/)
  assert.match(view, /if \(nativeCredentialEntry\) return null/)
  assert.match(view, /<MeetingStage\s+v-if="credentialState === 'ready'"/)
  assert.match(view, /createAndroidCredentialGate\(/)
  assert.match(view, /credentialGate\?\.close\(\)/)
  const probe = fs.readFileSync(new URL('../src/android-credential-probe.js', import.meta.url), 'utf8')
  assert.match(probe, /get\('credentialBridge'\) === '1'/)
})
