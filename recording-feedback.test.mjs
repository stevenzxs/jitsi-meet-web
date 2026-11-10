import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(`${root}/package.json`)
const ts = require('typescript')
const source = readFileSync(`${root}/src/utils/recordingFeedback.ts`, 'utf8')
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const context = { exports: {} }
vm.runInNewContext(code, context)

test('a pending MP4 conversion is reported as progress, never as failure', () => {
  const message = context.exports.getRecordingFinishMessage({ converting: true, videoFormat: 'webm' })
  assert.match(message, /正在后台转换/)
  assert.doesNotMatch(message, /失败/)
})

test('a finished WebM fallback reports a real conversion failure', () => {
  assert.match(context.exports.getRecordingFinishMessage({ converting: false, videoFormat: 'webm' }), /失败/)
})

test('conversion success after the stop response replaces progress with success', () => {
  const tracker = new context.exports.RecordingTranscodeTracker()
  tracker.start('session-1')
  assert.match(tracker.finish('session-1', { converting: true, videoFormat: 'webm' }), /正在后台转换/)
  assert.match(tracker.outcome('session-1', 'complete'), /转换完成/)
  assert.equal(tracker.outcome('session-1', 'failed'), null)
})

test('a fast conversion result arriving before the stop response is not overwritten by progress', () => {
  const tracker = new context.exports.RecordingTranscodeTracker()
  tracker.start('session-2')
  assert.equal(tracker.outcome('session-2', 'complete'), null)
  assert.match(tracker.finish('session-2', { converting: true, videoFormat: 'webm' }), /转换完成/)
})

test('a real conversion error is reported only after the failure event', () => {
  const tracker = new context.exports.RecordingTranscodeTracker()
  tracker.start('session-3')
  assert.match(tracker.finish('session-3', { converting: true, videoFormat: 'webm' }), /正在后台转换/)
  assert.match(tracker.outcome('session-3', 'failed'), /转换失败/)
})
