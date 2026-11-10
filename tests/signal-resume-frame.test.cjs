const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Execute the actual frame wiring and actual watchdog together. A helper-only
// test would miss a regression where the frame forgets to forward resume state.
function harness() {
  const utils = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,
    '../src/utils/signalLoss.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, utils)
  const source = fs.readFileSync(path.join(__dirname, '../src/components/JitsiFrame.vue'), 'utf8')
  const tree = ts.createSourceFile('frame.ts', source.split('<script setup lang="ts">')[1]
    .split('</script>')[0], ts.ScriptTarget.Latest, true)
  const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'watchSignalLoss')
  let time = 0, tick, disposed = 0, cancelled = 0
  const events = []
  const connection = { connected: true, _resumeTask: { retryCount: 0 },
    _stropheConn: { streamManagement: { getResumeToken: () => 'test-only-token' } } }
  const room = { getConnection: () => ({ xmpp: { connection } }) }
  const state = { conference: room }
  const app = { conference: { _room: room }, store: { getState: () => ({ 'features/base/conference': state }) } }
  const api = { getIFrame: () => ({ contentWindow: { APP: app } }) }
  const c = { ...utils.exports, api, closing: false, leaveRequested: false,
    stopSignalMonitor: undefined, performance: { now: () => time },
    window: { setInterval(fn) { tick = fn; return 1 }, clearInterval() { cancelled++ } },
    disposeApi() { disposed++ }, emit: name => events.push(name) }
  vm.runInNewContext(ts.transpileModule(fn.getText(tree), {}).outputText, c)
  c.watchSignalLoss(api)
  return { c, connection, room, state, events, tick(ms) { time = ms; tick() },
    get disposed() { return disposed }, get cancelled() { return cancelled } }
}

test('frame preserves stream through 12-second outage and resumes the same conference', () => {
  const h = harness()
  h.tick(0)
  h.connection.connected = false
  h.tick(1000)
  h.connection._resumeTask.retryCount = 1
  for (const time of [2000, 9000, 12000, 15000]) h.tick(time)
  assert.equal(h.disposed, 0)
  h.connection.connected = true
  h.connection._resumeTask.retryCount = 0
  h.tick(16000)
  assert.equal(h.state.conference, h.room)
  assert.deepEqual(h.events, [])
})

test('frame still disposes once when stream resume is exhausted', () => {
  const h = harness()
  h.connection.connected = false
  h.connection._resumeTask.retryCount = 3
  h.tick(0); h.tick(45000)
  assert.equal(h.disposed, 0)
  h.connection._resumeTask.retryCount = 4
  h.tick(46000); h.tick(53999)
  assert.equal(h.disposed, 0)
  h.tick(54000); h.tick(55000)
  assert.equal(h.disposed, 1)
  assert.equal(h.cancelled, 1)
  assert.deepEqual(h.events, ['connection-lost'])
})

test('frame waits through socket close handshake before stream resume begins', () => {
  const h = harness()
  h.connection.connected = false
  h.connection._status = 5
  h.connection._stropheConn._proto = { socket: { readyState: 2 } }
  h.tick(0); h.tick(25000)
  assert.equal(h.disposed, 0)
  h.connection._status = 6
  h.connection._resumeTask.retryCount = 1
  h.tick(30000)
  assert.equal(h.disposed, 0)
  h.connection.connected = true
  h.connection._status = 5
  h.connection._resumeTask.retryCount = 0
  h.connection._stropheConn._proto.socket.readyState = 1
  h.tick(35000)
  assert.deepEqual(h.events, [])
})

test('replaced API, explicit leave and disposal suppress stale watchdog events', () => {
  for (const change of [c => { c.api = {} }, c => { c.closing = true }, c => { c.leaveRequested = true }]) {
    const h = harness()
    h.connection.connected = false
    h.tick(0); change(h.c); h.tick(9000)
    assert.equal(h.disposed, 0)
    assert.deepEqual(h.events, [])
  }
})
