// Task 2 (web): recording mode must survive every settings normalization boundary.
// Run: node scripts/test-recording-settings.cjs
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadDesktopSettings(sandboxExtras = {}) {
  const source = readFileSync(path.join(__dirname, '../src/stores/desktopSettings.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const exports = {}
  const sandbox = {
    exports,
    console,
    require: (name) => {
      if (name === './user') return { inDesktopShell: () => true }
      throw new Error(`unexpected require: ${name}`)
    },
    ...sandboxExtras,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)
  return { ...exports, sandbox }
}

const { normalizeDesktopSettings, saveDesktopSettings } = loadDesktopSettings()
assert.equal(typeof normalizeDesktopSettings, 'function')
assert.equal(typeof saveDesktopSettings, 'function')
assert.equal(JSON.stringify(normalizeDesktopSettings({ recording: { modes: ['composite', 'host-camera', 'host-camera'] } }).recording.modes), JSON.stringify(['host-camera', 'composite']))
assert.equal(JSON.stringify(normalizeDesktopSettings({ recording: { mode: 'shared-screen' } }).recording.modes), JSON.stringify(['shared-screen']))
assert.equal(JSON.stringify(normalizeDesktopSettings({ recording: { modes: [] } }).recording.modes), '[]')

// --- normalize boundary ---
const defaults = normalizeDesktopSettings(null)
assert.equal(defaults.recording.mode, 'host-camera', 'missing mode must default to host-camera')
assert.equal(defaults.recording.recordAudioFile, false)
assert.equal(typeof defaults.recording.directory, 'string')

for (const junk of [undefined, null, '', 'nonsense', 'shared', 'HOST-CAMERA', 42, {}]) {
  const normalized = normalizeDesktopSettings({ recording: { mode: junk } })
  assert.equal(normalized.recording.mode, 'host-camera', `unknown mode ${JSON.stringify(junk)} must fall back`)
}

const preserved = normalizeDesktopSettings({
  recording: { mode: 'shared-screen', directory: 'D:/rec', recordAudioFile: true },
  video: { tilePollingSeconds: 30 },
})
assert.equal(preserved.recording.mode, 'shared-screen', 'valid shared-screen must survive normalization')
assert.equal(preserved.recording.directory, 'D:/rec', 'directory retained')
assert.equal(preserved.recording.recordAudioFile, true, 'recordAudioFile retained')
assert.equal(preserved.video.tilePollingSeconds, 30)

// legacy minutes regression
const legacy = normalizeDesktopSettings({ video: { tilePollingMinutes: 2 } })
assert.equal(legacy.video.tilePollingSeconds, 120, 'legacy tilePollingMinutes must still convert')

// --- save boundary: normalized payload must carry the mode to the shell ---
{
  let captured = null
  const listeners = []
  const fakeWindow = {
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: () => {},
    parent: { postMessage: (message) => { captured = message } },
  }
  const { saveDesktopSettings: saveWithWindow } = loadDesktopSettings({ window: fakeWindow })
  const pending = saveWithWindow({
    recording: { mode: 'shared-screen', directory: 'D:/rec', recordAudioFile: true },
    video: { tilePollingSeconds: 30 },
  })
  assert.ok(captured, 'save must post a message to the shell')
  for (const fn of listeners) {
    fn({ source: fakeWindow.parent, data: {
      type: 'cloudmeet-desktop-settings-saved', requestId: captured.requestId,
      settings: { recording: { mode: 'shared-screen', directory: 'D:/rec', recordAudioFile: true }, video: { tilePollingSeconds: 30 } },
    } })
  }
  pending.then(() => {
    assert.equal(captured.settings.recording.mode, 'shared-screen', 'saved payload must include normalized mode')
    assert.equal(captured.settings.recording.directory, 'D:/rec')
    console.log('PASS web recording settings (mode normalization + save payload)')
  }).catch((error) => {
    console.error(`FAIL ${error.message}`)
    process.exitCode = 1
  })
}
