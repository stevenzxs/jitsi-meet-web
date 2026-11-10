import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function harness() {
  const listeners = {}, sent = []
  const parent = { postMessage: (...args) => sent.push(args) }
  const window = { parent, location: { search: '?android=1', pathname: '/cm/desktop/meeting/123456789' },
    addEventListener: (type, fn) => { listeners[type] = fn } }
  vm.runInNewContext(fs.readFileSync(new URL('../src/android-credential-probe.js', import.meta.url), 'utf8'),
    { window, URLSearchParams })
  return { listeners, sent, parent }
}

test('probe requests a room-bound channel without credentials', () => {
  const h = harness()
  assert.equal(h.sent[0][0].type, 'cloudmeet-credential-ready')
  assert.equal(h.sent[0][0].room, '123456789')
  assert.equal(h.sent[0][1], '*') // Public ready only: file parent has opaque origin.
})

test('probe rejects unrelated frame and non-file parent connection', () => {
  const h = harness(), messages = []
  const port = { postMessage: data => messages.push(data), start() {}, close() {} }
  const event = { source: h.parent, origin: 'null', ports: [port], data: {
    type: 'cloudmeet-credential-connect', version: 1, room: '123456789', channelId: 'current' } }
  h.listeners.message({ ...event, source: {} })
  h.listeners.message({ ...event, origin: 'https://evil.example' })
  h.listeners.message({ ...event, data: { ...event.data, room: '987654321' } })
  assert.equal(messages.length, 0)
  h.listeners.message(event)
  assert.equal(messages[0].type, 'probe')
  assert.equal(messages[0].channelId, 'current')
  assert.equal(messages[0].sequence, 1)
  h.listeners.message(event)
  assert.equal(messages.length, 1)
})

test('pagehide before connection permanently rejects a delayed parent port', () => {
  const h = harness(), messages = []
  h.listeners.pagehide()
  h.listeners.message({ source: h.parent, origin: 'null', ports: [{
    start() {}, close() {}, postMessage: data => messages.push(data),
  }], data: { type: 'cloudmeet-credential-connect', version: 1, room: '123456789', channelId: 'late' } })
  assert.equal(messages.length, 0)
})
