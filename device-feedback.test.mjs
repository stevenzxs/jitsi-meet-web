import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(process.env.WEB_TEST_PACKAGE || new URL('./package.json', import.meta.url))
const ts = require('typescript')
function loadModule(url) {
  const code = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => name.startsWith('.') ? loadModule(new URL(`${name}.ts`, url)) : require(name),
  }, { filename: fileURLToPath(url) })
  return module.exports
}
const { createCameraState, getCameraState, disposeCameraState } = loadModule(new URL('./src/utils/cameraState.ts', import.meta.url))
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
function fakeApi(initialMuted = false) {
  const listeners = new Map()
  const api = {
    actualMuted: initialMuted, commands: [], autoToggle: true,
    addListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(handler)
    },
    removeListener(name, handler) { listeners.get(name)?.delete(handler) },
    emit(name, event) { for (const handler of listeners.get(name) || []) handler(event) },
    isVideoMuted() { return Promise.resolve(api.actualMuted) },
    executeCommand(name) {
      api.commands.push(name)
      if (api.autoToggle) queueMicrotask(() => {
        api.actualMuted = !api.actualMuted
        api.emit('videoMuteStatusChanged', { muted: api.actualMuted })
      })
    },
  }
  return api
}

test('no-video-data notification closes the stale track and immediately shows enable video', async () => {
  const api = fakeApi()
  const state = createCameraState(api)
  await state.sync()
  assert.equal(state.muted.value, false)
  api.emit('notificationTriggered', { title: 'dialog.cameraNotSendingDataTitle', description: 'dialog.cameraNotSendingData' })
  assert.equal(state.muted.value, true)
  await flush()
  assert.equal(api.actualMuted, true)
  assert.deepEqual(api.commands, ['toggleVideo'])
})

test('device rediscovery and stale unmute events cannot override a camera failure', async () => {
  const api = fakeApi(true)
  const state = createCameraState(api)
  api.emit('cameraError', {})
  await flush()
  api.emit('videoAvailabilityChanged', { available: true })
  api.emit('videoMuteStatusChanged', { muted: false })
  api.actualMuted = false
  await state.sync()
  assert.equal(state.muted.value, true)
})

test('late state query from before an error cannot put the icon back on', async () => {
  const api = fakeApi()
  const state = createCameraState(api)
  let finishOldQuery
  api.isVideoMuted = () => new Promise(resolve => { finishOldQuery = resolve })
  const oldSync = state.sync()
  api.isVideoMuted = () => Promise.resolve(true)
  api.emit('cameraError', {})
  finishOldQuery(false)
  await oldSync
  assert.equal(state.muted.value, true)
})

test('retry stays visually off until video opens, then follows normal toggling', async () => {
  const api = fakeApi(true)
  const state = createCameraState(api)
  api.emit('cameraError', {})
  await flush()
  api.autoToggle = false
  await state.toggle()
  assert.equal(state.muted.value, true)
  api.actualMuted = false
  await state.sync()
  assert.equal(state.muted.value, true, 'polling is not confirmation of a successful retry')
  api.emit('videoMuteStatusChanged', { muted: false })
  assert.equal(state.muted.value, false)
  api.autoToggle = true
  await state.toggle()
  await flush()
  assert.equal(state.muted.value, true)
})

test('retry during camera shutdown waits for mute before reopening, without duplicate toggles', async () => {
  const api = fakeApi()
  api.autoToggle = false
  const state = createCameraState(api)
  api.emit('cameraError', {})
  api.emit('notificationTriggered', { title: 'deviceError.cameraError' })
  await flush()
  await state.toggle()
  await state.toggle()
  assert.deepEqual(api.commands, ['toggleVideo'])
  api.actualMuted = true
  api.emit('videoMuteStatusChanged', { muted: true })
  assert.deepEqual(api.commands, ['toggleVideo', 'toggleVideo'])
  api.actualMuted = false
  api.emit('videoMuteStatusChanged', { muted: false })
  assert.equal(state.muted.value, false)
})

test('a retry without a Jitsi event can be attempted again after the wait expires', async () => {
  const api = fakeApi(true)
  api.autoToggle = false
  const state = createCameraState(api)
  state.unavailable()
  await flush()
  await state.toggle()
  await state.toggle()
  assert.deepEqual(api.commands, ['toggleVideo'], 'rapid repeated taps do not send duplicate commands')
  await new Promise(resolve => setTimeout(resolve, 2550))
  await state.toggle()
  assert.deepEqual(api.commands, ['toggleVideo', 'toggleVideo'])
})

test('another camera failure during retry leaves the indicator off', async () => {
  const api = fakeApi(true)
  api.autoToggle = false
  const state = createCameraState(api)
  state.unavailable()
  await flush()
  await state.toggle()
  api.emit('cameraError', {})
  api.emit('videoMuteStatusChanged', { muted: false })
  await flush()
  assert.equal(state.muted.value, true)
})

test('early failures are retained when the toolbar obtains the shared state after joining', async () => {
  const api = fakeApi(true)
  const earlyState = getCameraState(api)
  api.emit('cameraError', {})
  await flush()
  const toolbarState = getCameraState(api)
  assert.equal(earlyState, toolbarState)
  api.emit('videoMuteStatusChanged', { muted: false })
  assert.equal(toolbarState.muted.value, true)
  disposeCameraState(api)
})

test('device discovery, microphone errors, and malformed events do not switch off video', async () => {
  const api = fakeApi()
  const state = createCameraState(api)
  await state.sync()
  for (const event of [null, {}, { title: 'notify.newDeviceAudioTitle' }, { title: 'deviceError.microphoneError' }]) {
    api.emit('notificationTriggered', event)
  }
  api.emit('videoMuteStatusChanged', {})
  assert.equal(state.muted.value, false)
  assert.deepEqual(api.commands, [])
})

test('a camera failure does not toggle off an active screen share', async () => {
  const api = fakeApi()
  const state = createCameraState(api)
  api.emit('screenSharingStatusChanged', { on: true })
  state.unavailable()
  await flush()
  assert.equal(state.muted.value, true)
  assert.deepEqual(api.commands, [])
})

test('disposing the iframe cancels pending device commands and removes listeners', async () => {
  const api = fakeApi()
  let finishQuery
  api.isVideoMuted = () => new Promise(resolve => { finishQuery = resolve })
  const state = createCameraState(api)
  state.unavailable()
  state.dispose()
  finishQuery(false)
  api.emit('videoMuteStatusChanged', { muted: false })
  await flush()
  assert.deepEqual(api.commands, [])
  assert.equal(state.muted.value, true)
})

test('a temporary iframe query failure does not permanently block further retries', async () => {
  const api = fakeApi(true)
  const state = createCameraState(api)
  state.unavailable()
  await flush()
  api.isVideoMuted = () => Promise.reject(new Error('iframe unavailable'))
  await state.toggle()
  assert.equal(state.muted.value, true)
  api.isVideoMuted = () => Promise.resolve(api.actualMuted)
  await state.toggle()
  await flush()
  assert.equal(state.muted.value, false)
})

test('an old failure query cannot toggle video back on after a mute event', async () => {
  const api = fakeApi(false)
  const state = createCameraState(api)
  let finishQuery
  api.isVideoMuted = () => new Promise(resolve => { finishQuery = resolve })
  state.unavailable()
  api.actualMuted = true
  api.emit('videoMuteStatusChanged', { muted: true })
  finishQuery(false)
  await flush()
  assert.deepEqual(api.commands, [])
  assert.equal(api.actualMuted, true)
})
