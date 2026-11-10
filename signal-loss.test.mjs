import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
const ts = createRequire(import.meta.url)('typescript')
function load() {
  const source = readFileSync(new URL('./src/utils/signalLoss.ts', import.meta.url), 'utf8')
  const context = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context)
  return context.exports
}
function harness() {
  let tick, now = 0, lost = 0, stopped = 0
  const room = {}
  let state = { conference: room, connected: false, transitioning: false }
  const stop = load().createSignalLossMonitor({ read: () => state, onLost: () => lost++, now: () => now,
    schedule: fn => { tick = fn; return 1 }, cancel: () => stopped++ })
  return { tick(ms) { now = ms; tick() }, set(value) { state = value }, room, stop,
    get lost() { return lost }, get stopped() { return stopped } }
}
test('same explicitly disconnected conference exits once only after eight seconds', () => {
  const h = harness(); h.tick(0); h.tick(7999); assert.equal(h.lost, 0)
  h.tick(8000); h.tick(16000); assert.equal(h.lost, 1); assert.equal(h.stopped, 1)
})
test('recovery, transition, unknown and switched conference reset grace', () => {
  for (const change of [null, { connected: true }, { connected: undefined }, { transitioning: true }, { conference: {} }]) {
    const h = harness(); h.tick(0); h.tick(7000)
    h.set(change === null ? null : { conference: h.room, connected: false, transitioning: false, ...change })
    h.tick(8000); assert.equal(h.lost, 0)
    h.set({ conference: h.room, connected: false, transitioning: false }); h.tick(9000); h.tick(16999)
    assert.equal(h.lost, 0); h.tick(17000); assert.equal(h.lost, 1)
  }
})
test('stopping cancels monitor and pending callbacks cannot report signal loss', () => {
  const h = harness(); h.tick(0); h.stop(); h.tick(9000); assert.equal(h.lost, 0)
})
test('stream resume may exceed eight seconds without destroying the conference', () => {
  const h = harness()
  h.tick(0)
  h.set({ conference: h.room, connected: false, transitioning: false, recovering: true })
  h.tick(1000); h.tick(10000); h.tick(45000)
  assert.equal(h.lost, 0, 'RESUMING is not a terminal disconnection')
  h.set({ conference: h.room, connected: true, transitioning: false, recovering: false })
  h.tick(46000)
  assert.equal(h.lost, 0)
})
test('current Jitsi resume adapter recognizes pending retries but not exhaustion or missing token', () => {
  const { isXmppRecovering } = load()
  for (const retryCount of [1, 2, 3]) {
    assert.equal(isXmppRecovering({ _resumeTask: { retryCount },
      _stropheConn: { streamManagement: { getResumeToken: () => 'opaque' } } }), true)
  }
  for (const retryCount of [0, 4, undefined]) {
    assert.equal(isXmppRecovering({ _resumeTask: { retryCount },
      _stropheConn: { streamManagement: { getResumeToken: () => 'opaque' } } }), false)
  }
  assert.equal(isXmppRecovering(null), false)
  assert.equal(isXmppRecovering({ _resumeTask: { retryCount: 1 } }), false)
  assert.equal(isXmppRecovering({ _resumeTask: { retryCount: 1 },
    _stropheConn: { streamManagement: { getResumeToken: () => null } } }), false)
})
test('socket close handshake can stall before Jitsi emits RESUMING', () => {
  const { isXmppRecovering } = load()
  for (const status of [5, 11]) for (const readyState of [2, 3]) {
    assert.equal(isXmppRecovering({ _status: status, _resumeTask: { retryCount: 0 },
      _stropheConn: { _proto: { socket: { readyState } },
        streamManagement: { getResumeToken: () => 'opaque' } } }), true)
  }
  assert.equal(isXmppRecovering({ _status: 6, _resumeTask: { retryCount: 4 },
    _stropheConn: { _proto: { socket: { readyState: 3 } },
      streamManagement: { getResumeToken: () => 'opaque' } } }), false)
})
test('exhausted resume starts a fresh grace interval and still exits once', () => {
  const h = harness()
  h.set({ conference: h.room, connected: false, transitioning: false, recovering: true })
  h.tick(0); h.tick(20000)
  assert.equal(h.lost, 0)
  h.set({ conference: h.room, connected: false, transitioning: false, recovering: false })
  h.tick(21000); h.tick(28999); assert.equal(h.lost, 0)
  h.tick(29000); h.tick(50000); assert.equal(h.lost, 1)
})
test('frame routes sustained loss to a dedicated local event and stage never ends business record', async () => {
  const frame = readFileSync(new URL('./src/components/JitsiFrame.vue', import.meta.url), 'utf8')
  assert.match(frame, /createSignalLossMonitor/)
  assert.match(frame, /recovering:\s*isXmppRecovering\(connection\)/,
    'The frame must pass live resume state, not just the socket connected getter')
  assert.match(frame, /emit\('connection-lost'\)/)
  const stage = readFileSync(new URL('./src/components/MeetingStage.vue', import.meta.url), 'utf8')
  assert.match(stage, /@connection-lost="onConnectionLost"/)
  const script = stage.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile('stage.ts', script, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'onConnectionLost')
  assert.ok(fn, 'dedicated local cleanup handler required')
  let cleared = 0, recording = 0
  const c = { stopLocalRecording: async () => recording++, clearMeetingRuntimeState: () => cleared++,
    errorMsg: { value: '' }, setStatus: value => { c.status = value } }
  vm.runInNewContext(ts.transpileModule(fn.getText(ast), {}).outputText, c)
  await c.onConnectionLost()
  assert.equal(cleared, 1); assert.equal(recording, 1); assert.equal(c.status, 'left')
  assert.match(c.errorMsg.value, /连接已断开/); assert.match(c.errorMsg.value, /不代表会议已结束/)
})
