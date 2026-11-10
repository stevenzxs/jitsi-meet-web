import test from 'node:test'
import assert from 'node:assert/strict'
import { createAndroidCredentialGate } from '../src/utils/androidCredentialGate.js'

function harness(overrides = {}) {
  const values = new Map(), sessions = new Map(), sent = [], states = []
  let timeout, receiver, removed = 0
  const parent = { postMessage: (...args) => sent.push(args) }
  const portMessages = []
  const port = { start() {}, close() {}, postMessage: data => portMessages.push(data) }
  const options = { parent, room: '123456789', path: '/cm/desktop/meeting/123456789',
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    saveSession: session => sessions.set(session.roomName, session),
    getSession: room => sessions.get(room),
    listen: fn => { receiver = fn; return () => { removed++ } },
    schedule: fn => { timeout = fn; return () => {} },
    onState: state => states.push(state), ...overrides }
  const gate = createAndroidCredentialGate(options)
  const connect = () => receiver({ source: parent, origin: 'null', ports: [port], data: {
    type: 'cloudmeet-credential-connect', version: 1, room: '123456789', channelId: 'current' } })
  const payload = { type: 'bootstrap', version: 1, room: '123456789', channelId: 'current', sequence: 1,
    creatorRecoveryKey: 'A'.repeat(43), hostKey: 'host', password: '', displayName: 'Device creator', subject: 'test' }
  return { gate, values, sessions, sent, states, port, portMessages, connect, payload,
    timeout: () => timeout(), removed: () => removed }
}

test('gate waits for private persisted credentials and session before permitting mount', () => {
  const h = harness()
  assert.deepEqual(h.states, ['waiting'])
  assert.equal(h.sent[0][0].type, 'cloudmeet-credential-ready')
  assert.equal(JSON.stringify(h.sent).includes('creatorRecoveryKey'), false)
  h.connect()
  h.port.onmessage({ data: h.payload })
  assert.deepEqual(h.states, ['waiting', 'ready'])
  assert.equal(h.sessions.get('123456789').hostKey, 'host')
  assert.equal(h.sessions.get('123456789').displayName, 'Device creator')
  assert.equal(h.portMessages[0].ok, true)
  h.timeout()
  assert.equal(h.states.at(-1), 'ready')
})

test('session failure and storage conflicts fail closed without positive ack', () => {
  for (const options of [{ saveSession() { throw Error('quota') } }, {}]) {
    const h = harness(options)
    if (!options.saveSession) h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: 'newer' } }))
    h.connect()
    h.port.onmessage({ data: h.payload })
    assert.equal(h.states.includes('ready'), false)
    assert.equal(h.portMessages[0].ok, false)
  }
})

test('timeout and close reject queued messages without storing or mounting', () => {
  for (const terminate of [h => h.timeout(), h => h.gate.close()]) {
    const h = harness()
    h.connect()
    const late = h.port.onmessage
    terminate(h)
    late({ data: h.payload })
    assert.equal(h.values.size, 0)
    assert.equal(h.states.includes('ready'), false)
    assert.equal(h.removed(), 1)
  }
})

test('missing display name, invalid end time and existing session key conflict cannot mount', () => {
  for (const change of [{ displayName: '' }, { displayName: null }, { endTime: -1 }, { endTime: 'tomorrow' }]) {
    const h = harness()
    h.connect()
    h.port.onmessage({ data: { ...h.payload, ...change } })
    assert.equal(h.states.includes('ready'), false)
    assert.equal(h.values.size, 0)
  }
  const h = harness()
  h.sessions.set('123456789', { roomName: '123456789', hostKey: 'newer' })
  h.connect()
  h.port.onmessage({ data: h.payload })
  assert.equal(h.states.includes('ready'), false)
  assert.equal(h.values.size, 0)
})

test('silently discarded session writes never release the meeting gate', () => {
  const h = harness({ saveSession() {} })
  h.connect()
  h.port.onmessage({ data: h.payload })
  assert.equal(h.states.includes('ready'), false)
  assert.equal(h.portMessages[0].ok, false)
})

test('a fenced native candidate reopens only with the same persisted pending receipt', () => {
  const h = harness()
  h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: 'old', password: '' } }))
  h.values.set('jitsi-meet-pending-host-transfer-v1', JSON.stringify({
    '123456789': { hostKey: 'rotated', operationId: 'op1', expiresAt: Date.now() + 60000 },
  }))
  h.sessions.set('123456789', { roomName: '123456789', hostKey: 'old' })
  h.connect()
  h.port.onmessage({ data: { ...h.payload, hostKey: 'rotated', hostState: 'pending' } })
  assert.equal(h.states.at(-1), 'ready')
  assert.equal(h.sessions.get('123456789').hostKey, 'rotated')
  assert.equal(JSON.parse(h.values.get('jitsi-meet-credentials-v1'))['123456789'].hostKey, 'old')
  assert.equal(h.portMessages[0].ok, true)

  const conflict = harness()
  conflict.values.set('jitsi-meet-pending-host-transfer-v1', JSON.stringify({
    '123456789': { hostKey: 'newer', operationId: 'op2', expiresAt: Date.now() + 60000 },
  }))
  conflict.connect()
  conflict.port.onmessage({ data: { ...conflict.payload, hostKey: 'rotated', hostState: 'pending' } })
  assert.equal(conflict.states.includes('ready'), false)
  assert.equal(conflict.portMessages[0].ok, false)

  const damaged = harness()
  damaged.values.set('jitsi-meet-pending-host-transfer-v1', JSON.stringify({
    '123456789': { hostKey: 'rotated', operationId: 'invalid!', expiresAt: Date.now() + 60000 },
  }))
  damaged.connect()
  damaged.port.onmessage({ data: { ...damaged.payload, hostKey: 'rotated', hostState: 'pending' } })
  assert.equal(damaged.states.includes('ready'), false)
  assert.equal(damaged.portMessages[0].ok, false)
})

test('an explicitly revoked Web key cannot be restored by an older native bootstrap', () => {
  const h = harness()
  h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: '', password: '' } }))
  h.sessions.set('123456789', { roomName: '123456789', hostKey: '' })
  h.connect()
  h.port.onmessage({ data: { ...h.payload, hostState: 'active' } })
  assert.equal(h.states.at(-1), 'ready')
  assert.equal(h.sessions.get('123456789').hostKey, '')
  assert.equal(JSON.parse(h.values.get('jitsi-meet-credentials-v1'))['123456789'].hostKey, '')
  assert.equal(h.portMessages[0].ok, true)

  const stale = harness()
  stale.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: 'newer', password: '' } }))
  stale.connect()
  stale.port.onmessage({ data: h.payload })
  assert.equal(stale.states.includes('ready'), false)
})

test('a Web pending receipt can fence the old native key after a restart', () => {
  const h = harness()
  h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: 'host', password: '' } }))
  h.values.set('jitsi-meet-pending-host-transfer-v1', JSON.stringify({
    '123456789': { hostKey: 'rotated', operationId: 'op1', expiresAt: Date.now() + 60000 },
  }))
  h.sessions.set('123456789', { roomName: '123456789', hostKey: 'host' })
  h.connect()
  h.port.onmessage({ data: { ...h.payload, hostState: 'active' } })
  assert.equal(h.states.at(-1), 'ready')
  assert.equal(h.sessions.get('123456789').hostKey, 'rotated')
  assert.equal(JSON.parse(h.values.get('jitsi-meet-credentials-v1'))['123456789'].hostKey, 'host')
  assert.equal(h.portMessages[0].ok, true)
})
