import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptNativeCredentials } from '../src/utils/androidCredentialStorage.js'

function harness() {
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const payload = { room: '123456789', creatorRecoveryKey: 'A'.repeat(43), hostKey: 'host-key', password: '' }
  return { values, storage, payload }
}

test('native credentials are acknowledged only after read-back succeeds', () => {
  const h = harness()
  assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, true)
  assert.equal(JSON.parse(h.values.get('jitsi-meet-creator-recovery-v1'))['123456789'], h.payload.creatorRecoveryKey)
  assert.equal(JSON.parse(h.values.get('jitsi-meet-credentials-v1'))['123456789'].hostKey, 'host-key')
})

test('conflicting creator capability, wrong room and invalid values never overwrite storage', () => {
  for (const change of [{ room: '987654321' }, { creatorRecoveryKey: 'bad' }, { hostKey: 'x'.repeat(129) }]) {
    const h = harness()
    assert.equal(acceptNativeCredentials(h.storage, '123456789', { ...h.payload, ...change }).ok, false)
    assert.equal(h.values.size, 0)
  }
  const h = harness()
  h.values.set('jitsi-meet-creator-recovery-v1', JSON.stringify({ '123456789': 'B'.repeat(43) }))
  const before = [...h.values]
  assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, false)
  assert.deepEqual([...h.values], before)
})

test('existing rotated host or pending transfer is never replaced by stale native bootstrap', () => {
  const h = harness()
  h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: 'rotated', password: '' } }))
  assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, false)
  assert.equal(JSON.parse(h.values.get('jitsi-meet-credentials-v1'))['123456789'].hostKey, 'rotated')
  const pending = harness()
  pending.values.set('jitsi-meet-pending-host-transfer-v1', JSON.stringify({ '123456789': { hostKey: 'pending' } }))
  assert.equal(acceptNativeCredentials(pending.storage, '123456789', pending.payload).ok, false)
})

test('failed or silently discarded writes cannot produce a successful acknowledgement', () => {
  const h = harness()
  for (const storage of [
    { getItem: () => null, setItem: () => { throw Error('quota') } },
    { getItem: () => null, setItem: () => {} },
  ]) assert.equal(acceptNativeCredentials(storage, '123456789', h.payload).ok, false)
})

test('damaged storage is rejected instead of clearing unrelated room credentials', () => {
  const h = harness()
  h.values.set('jitsi-meet-credentials-v1', '{damaged')
  assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, false)
  assert.equal(h.values.get('jitsi-meet-credentials-v1'), '{damaged')
})

test('revoked and scheduled credentials cannot be resurrected by bootstrap', () => {
  for (const hostKey of ['', 'rotated']) {
    const h = harness()
    h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey, password: '' } }))
    assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, false)
    const scheduled = harness()
    scheduled.values.set('jitsi-meet-scheduled-v1', JSON.stringify([{ roomName: '123456789', hostKey }]))
    assert.equal(acceptNativeCredentials(scheduled.storage, '123456789', scheduled.payload).ok, false)
  }
})

test('bootstrap is idempotent and preserves unrelated room records', () => {
  const h = harness()
  h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '987654321': { hostKey: 'other', password: 'other' } }))
  assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, true)
  assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, true)
  assert.equal(JSON.parse(h.values.get('jitsi-meet-credentials-v1'))['987654321'].hostKey, 'other')
})

test('invalid storage shapes fail closed before any write', () => {
  for (const key of ['jitsi-meet-credentials-v1', 'jitsi-meet-creator-recovery-v1', 'jitsi-meet-pending-host-transfer-v1']) {
    for (const raw of ['null', '[]', '42']) {
      const h = harness()
      h.values.set(key, raw)
      const before = [...h.values]
      assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, false)
      assert.deepEqual([...h.values], before)
    }
  }
})

test('a partial write failure retains recovery and retries without acknowledging early', () => {
  const h = harness()
  let failHost = true
  const storage = { getItem: h.storage.getItem, setItem(key, value) {
    if (key === 'jitsi-meet-credentials-v1' && failHost) throw Error('quota')
    h.storage.setItem(key, value)
  } }
  assert.equal(acceptNativeCredentials(storage, '123456789', h.payload).ok, false)
  assert.equal(JSON.parse(h.values.get('jitsi-meet-creator-recovery-v1'))['123456789'], h.payload.creatorRecoveryKey)
  assert.equal(h.values.has('jitsi-meet-credentials-v1'), false)
  failHost = false
  assert.equal(acceptNativeCredentials(storage, '123456789', h.payload).ok, true)
})

test('same host key cannot overwrite a newer stored password', () => {
  const h = harness()
  h.values.set('jitsi-meet-credentials-v1', JSON.stringify({ '123456789': { hostKey: 'host-key', password: 'newer' } }))
  const before = [...h.values]
  assert.equal(acceptNativeCredentials(h.storage, '123456789', h.payload).ok, false)
  assert.deepEqual([...h.values], before)
})

test('payload types and password bounds are checked before persistence', () => {
  for (const change of [{ password: null }, { password: 'x'.repeat(129) }, { hostKey: '' },
    { hostKey: 123 }, { creatorRecoveryKey: null }]) {
    const h = harness()
    assert.equal(acceptNativeCredentials(h.storage, '123456789', { ...h.payload, ...change }).ok, false)
    assert.equal(h.values.size, 0)
  }
  const h = harness()
  assert.equal(acceptNativeCredentials(h.storage, 123456789, { ...h.payload, room: 123456789 }).ok, false)
  assert.equal(h.values.size, 0)
})
