const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const c = vm.createContext({ exports: {} })
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/utils/pollingLayout.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, c)
assert.equal(typeof c.exports.getPollingCardSize, 'function', 'Polling must size actual cards like grid-2')
for (const [w, h] of [[2000, 968], [1280, 720], [800, 300], [480, 800]]) {
  const size = c.exports.getPollingCardSize(w, h)
  assert.ok(size.width * 2 + 8 + 14 <= w)
  assert.ok(size.height + 4 + 14 <= h)
  assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.04)
}
const state = { 'features/base/participants': { local: { id: 'local' }, remote: new Map([['remote', { id: 'remote' }]]) } }
const api = { getIFrame: () => ({ contentWindow: { interfaceConfig: { DEFAULT_LOCAL_DISPLAY_NAME: '本地默认', DEFAULT_REMOTE_DISPLAY_NAME: 'Fellow Jitster' }, APP: { store: { getState: () => state } } } }) }
assert.equal(c.exports.getPollingParticipantInfo(api, 'remote').displayName, 'Fellow Jitster')
assert.equal(c.exports.getPollingParticipantInfo(api, 'local').displayName, '本地默认')
console.log('PASS polling grid-2 geometry and native fallback names')
