import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('Android targets 720 capture while retaining low-resolution fallback and compatibility', () => {
  const source = readFileSync(new URL('../src/components/JitsiFrame.vue', import.meta.url), 'utf8')
  assert.match(source, /const ANDROID_WEBVIEW_VIDEO_HEIGHT = 720\b/)
  assert.match(source, /resolution: ANDROID_WEBVIEW_VIDEO_HEIGHT/)
  assert.match(source, /height:\s*\{\s*ideal: ANDROID_WEBVIEW_VIDEO_HEIGHT,\s*max: ANDROID_WEBVIEW_VIDEO_HEIGHT,\s*min: 180/)
  assert.match(source, /disableSimulcast: true/)
  assert.match(source, /const ANDROID_WEBVIEW_VIDEO_CODECS = \['VP8', 'H264'\]/)
  assert.match(source, /p2p:\s*\{\s*enabled: false/)
})
