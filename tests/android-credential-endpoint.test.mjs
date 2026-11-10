import test from 'node:test'
import assert from 'node:assert/strict'
import { createAndroidCredentialEndpoint } from '../src/utils/androidCredentialEndpoint.js'
import { acceptNativeCredentials } from '../src/utils/androidCredentialStorage.js'

function harness() {
  const parent = {}, sent = [], accepted = []
  let closed = 0
  const port = { postMessage: data => sent.push(data), start() {}, close() { closed++ } }
  const endpoint = createAndroidCredentialEndpoint({ parent, room: '123456789',
    accept: data => { accepted.push(data); return { ok: true } } })
  const connect = { source: parent, origin: 'null', ports: [port], data: {
    type: 'cloudmeet-credential-connect', version: 1, room: '123456789', channelId: 'channel' } }
  const payload = { type: 'bootstrap', version: 1, room: '123456789', channelId: 'channel', sequence: 1,
    hostKey: 'host', creatorRecoveryKey: 'A'.repeat(43), password: '' }
  return { endpoint, connect, payload, port, sent, accepted, closed: () => closed }
}

test('only exact parent, opaque origin, room, version and one port can connect once', () => {
  const h = harness()
  for (const event of [
    { ...h.connect, source: {} }, { ...h.connect, origin: 'https://evil.example' },
    { ...h.connect, ports: [] }, { ...h.connect, ports: [h.port, h.port] },
    { ...h.connect, data: { ...h.connect.data, version: 2 } },
    { ...h.connect, data: { ...h.connect.data, room: '987654321' } },
    { ...h.connect, data: { ...h.connect.data, channelId: '' } },
  ]) assert.equal(h.endpoint.connect(event), false)
  assert.equal(h.endpoint.connect(h.connect), true)
  assert.equal(h.endpoint.connect(h.connect), false)
})

test('bootstrap has a secret-free ack only after successful storage', () => {
  const h = harness()
  h.endpoint.connect(h.connect)
  h.port.onmessage({ data: h.payload })
  assert.equal(h.accepted.length, 1)
  assert.deepEqual(h.sent, [{ type: 'bootstrap-ack', ok: true, version: 1,
    room: '123456789', channelId: 'channel', sequence: 1 }])
})

test('private state sender owns the envelope and cannot send after close', () => {
  const h = harness()
  assert.equal(h.endpoint.send({ type: 'credential-state' }), false)
  h.endpoint.connect(h.connect)
  assert.equal(h.endpoint.send({ type: 'credential-state', sequence: 999, room: 'evil' }), true)
  assert.equal(h.sent[0].sequence, 1)
  assert.equal(h.sent[0].room, '123456789')
  h.endpoint.close()
  assert.equal(h.endpoint.send({}), false)
})

test('wrong envelope, replay and messages after close cannot reach storage', () => {
  const h = harness()
  h.endpoint.connect(h.connect)
  for (const change of [{ version: 2 }, { room: '987654321' }, { channelId: 'old' },
    { sequence: 0 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { type: 'unknown' }]) {
    h.port.onmessage({ data: { ...h.payload, ...change } })
  }
  assert.equal(h.accepted.length, 0)
  h.port.onmessage({ data: h.payload })
  h.port.onmessage({ data: h.payload })
  assert.equal(h.accepted.length, 1)
  const late = h.port.onmessage
  h.endpoint.close()
  late({ data: { ...h.payload, sequence: 2 } })
  assert.equal(h.accepted.length, 1)
  assert.equal(h.closed(), 1)
  assert.equal(h.endpoint.connect(h.connect), false)
})

test('failed or throwing storage returns only negative ack and supports ordered retry', () => {
  for (const throws of [false, true]) {
    const h = harness()
    let attempts = 0
    const endpoint = createAndroidCredentialEndpoint({ parent: h.connect.source, room: '123456789', accept() {
      attempts++
      if (attempts > 1) return { ok: true }
      if (throws) throw Error('must not leak secret diagnostics')
      return { ok: false }
    } })
    endpoint.connect(h.connect)
    h.port.onmessage({ data: h.payload })
    assert.equal(h.sent[0].ok, false)
    assert.equal(JSON.stringify(h.sent).includes('diagnostics'), false)
    h.port.onmessage({ data: { ...h.payload, sequence: 2 } })
    assert.equal(h.sent[1].ok, true)
    assert.equal(h.sent[1].sequence, 2)
  }
})

test('port and real storage integration refuses rotated keys and acknowledges persisted bootstrap', () => {
  for (const rotated of [false, true]) {
    const h = harness(), values = new Map()
    if (rotated) values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: 'newer' } }))
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
    const endpoint = createAndroidCredentialEndpoint({ parent: h.connect.source, room: '123456789',
      accept: payload => acceptNativeCredentials(storage, '123456789', payload) })
    endpoint.connect(h.connect)
    h.port.onmessage({ data: h.payload })
    assert.equal(h.sent[0].ok, !rotated)
    assert.equal(JSON.parse(values.get('jitsi-meet-credentials-v1'))['123456789'].hostKey, rotated ? 'newer' : 'host')
    endpoint.close()
  }
})
