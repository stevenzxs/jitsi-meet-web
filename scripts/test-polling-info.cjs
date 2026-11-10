const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../src/utils/pollingLayout.ts'), 'utf8')
const context = vm.createContext({ exports: {} })
vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context)
const read = context.exports.getPollingParticipantInfo
assert.equal(typeof read, 'function', 'Polling slots need participant metadata independent of camera video')
const state = {
  'features/base/participants': { local: { id: 'host', name: '主持甲', role: 'moderator' }, remote: new Map([['member', { id: 'member', name: '成员乙', role: 'participant' }]]) },
  'features/base/tracks': [{ local: true, participantId: 'local', mediaType: 'audio', muted: true }, { participantId: 'member', mediaType: 'audio', muted: false }],
}
const api = { getIFrame: () => ({ contentWindow: { APP: { store: { getState: () => state } } } }) }
assert.equal(read(api, 'host').audioMuted, true)
assert.equal(read(api, 'host').local, true)
assert.equal(read(api, 'host').moderator, true)
assert.equal(read(api, 'member').displayName, '成员乙')
assert.equal(read(api, 'member').audioMuted, false)
state['features/base/tracks'][1].muted = true
state['features/base/participants'].remote.get('member').name = '新姓名'
state['features/base/participants'].remote.get('member').role = 'moderator'
assert.equal(read(api, 'member').audioMuted, true)
assert.equal(read(api, 'member').displayName, '新姓名')
assert.equal(read(api, 'member').moderator, true)
state['features/base/tracks'] = []
assert.equal(read(api, 'member').audioMuted, null, 'Unknown mute state must not be reported as unmuted')
assert.equal(read(api, 'missing'), null)
assert.equal(read(null, 'host'), null)
assert.equal(read({ getIFrame() { throw Error('cross-origin') } }, 'host'), null)
console.log('PASS polling metadata: local/remote, mute changes, rename, role transfer, no camera, unknown and missing participants')
