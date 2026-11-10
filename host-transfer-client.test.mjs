import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { TextEncoder } from 'node:util'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const ROOM = '123456789'
const ROOM_JID = `${ROOM}@conference.test`
const SESSION_JID = 'target@guest.test/device'
const KEY = 'NEW-SECRET'
const OPERATION = 'operation-one'
const NS = 'urn:cloudmeet:host-control:1'

class XmlNode {
  constructor(namespaceURI, localName) {
    this.namespaceURI = namespaceURI
    this.localName = localName
    this.attrs = new Map()
    this.children = []
  }
  setAttribute(name, value) { this.attrs.set(name, value) }
  getAttribute(name) { return this.attrs.get(name) ?? null }
  appendChild(child) { this.children.push(child) }
}
const doc = { createElementNS: (ns, name) => new XmlNode(ns, name) }
function response(name, attributes) {
  const iq = doc.createElementNS('jabber:client', 'iq')
  iq.setAttribute('from', ROOM_JID)
  const command = doc.createElementNS(NS, name)
  for (const [key, value] of Object.entries(attributes)) command.setAttribute(key, String(value))
  iq.appendChild(command)
  return iq
}

function setup() {
  const storage = new Map()
  let rejectWrites = false
  const localStorage = {
    getItem: key => storage.get(`local:${key}`) ?? null,
    setItem: (key, value) => { if (rejectWrites) throw new Error('storage unavailable'); storage.set(`local:${key}`, value) },
  }
  const sessionStorage = {
    getItem: key => storage.get(`session:${key}`) ?? null,
    setItem: (key, value) => storage.set(`session:${key}`, value),
  }
  const modules = new Map()
  const timers = []
  // Model an internal HTTP origin where WebCrypto's secure-context APIs are unavailable.
  const context = { exports: {}, localStorage, sessionStorage, crypto: {}, TextEncoder,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    window: { setTimeout: callback => { timers.push(callback); return timers.length }, clearTimeout: () => {} }, console }
  const load = path => {
    if (modules.has(path)) return modules.get(path)
    const exports = {}
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText
    vm.runInNewContext(code, { ...context, exports,
      require: name => name === '../stores/meeting' ? load('./src/stores/meeting.ts')
        : name === './meetingPermissions' ? load('./src/utils/meetingPermissions.ts') : require(name) })
    modules.set(path, exports)
    return exports
  }
  const store = load('./src/stores/meeting.ts')
  const client = load('./src/utils/hostTransferClient.ts')
  store.saveSession({ roomName: ROOM, subject: 'Meeting', password: 'password', createdAt: 1,
    displayName: 'Target', host: false })
  const requests = []
  let handler
  const connection = { connected: true, jid: SESSION_JID,
    addHandler: callback => { handler = callback; return callback },
    deleteHandler: () => { handler = undefined },
    sendIQ: (stanza, success, error) => { requests.push({ stanza, success, error }) },
  }
  const targetId = 'abcdef12'
  let localRole = 'moderator'
  const targetNick = `${ROOM_JID}/${targetId}`
  const conference = { room: { roomjid: ROOM_JID, myroomjid: `${ROOM_JID}/source12`,
    members: { [targetNick]: { jid: SESSION_JID, role: 'participant', affiliation: 'none' } } },
  isJoined: () => true,
  getConnection: () => ({ xmpp: { connection: { connected: true, _stropheConn: connection } } }) }
  const api = { getIFrame: () => ({ contentWindow: { document: doc, APP: {
    conference: { _room: conference }, store: { getState: () => ({
      'features/base/conference': { conference },
      'features/base/participants': { local: { id: 'source12', role: localRole },
        remote: new Map([[targetId, { role: 'participant' }]]) },
    }) },
  } } }) }
  const completed = []
  const errors = []
  let rejectCompletion = false
  const attach = () => client.attachHostTransferClient(api, ROOM, {
    onComplete: async key => { if (rejectCompletion) throw new Error('host token unavailable'); completed.push(key) },
    onError: message => { errors.push(message) },
  })
  const deliver = (operation = OPERATION, previousOperationId) => {
    const message = doc.createElementNS('jabber:client', 'message')
    message.setAttribute('from', ROOM_JID)
    message.setAttribute('type', 'normal')
    const credential = doc.createElementNS(NS, 'credential')
    credential.setAttribute('operationId', operation)
    credential.setAttribute('hostKey', KEY)
    credential.setAttribute('identity', `host-v1-${'a'.repeat(43)}`)
    if (previousOperationId) credential.setAttribute('previousOperationId', previousOperationId)
    message.appendChild(credential)
    handler(message)
  }
  return { store, client, attach, deliver, requests, completed, errors, api, conference, targetId, targetNick,
    timers,
    setLocalRole: role => { localRole = role },
    get handler() { return handler }, connection,
    rejectStorageWrites: () => { rejectWrites = true },
    rejectHostToken: () => { rejectCompletion = true } }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('only room-authenticated exact-operation revocation retires pending credentials', async () => {
  const f = setup()
  f.attach()
  f.deliver()
  const revoke = response('revoked', { operationId: OPERATION })
  revoke.setAttribute('type', 'normal')
  revoke.setAttribute('from', 'peer@guest.test')
  f.handler(revoke)
  assert(f.store.getPendingHostTransfer(ROOM))
  revoke.setAttribute('from', ROOM_JID)
  revoke.children[0].setAttribute('operationId', 'different')
  f.handler(revoke)
  assert(f.store.getPendingHostTransfer(ROOM))
  revoke.children[0].setAttribute('operationId', OPERATION)
  f.handler(revoke)
  assert.equal(f.store.getPendingHostTransfer(ROOM), null)
  assert.equal(f.store.getSession(ROOM).hostKey, undefined)
  f.deliver('replacement')
  f.handler(revoke)
  assert.equal(f.store.getPendingHostTransfer(ROOM).operationId, 'replacement')
  assert.equal(f.store.getSession(ROOM).hostKey, KEY)
})

test('outgoing host-control IQ carries explicit wire namespaces for Strophe serialization', async () => {
  const f = setup()
  const pending = f.client.requestHostTransfer(f.api, ROOM, f.targetId)
  const rejected = assert.rejects(pending)
  const { stanza, error } = f.requests[0]
  error(null)
  await rejected
  // Strophe serializes attributes, not the DOM namespaceURI. An implicit DOM
  // namespace passed the old fake but reached Prosody as xmlns=''.
  assert.equal(stanza.getAttribute('xmlns'), 'jabber:client')
  assert.equal(stanza.children[0].getAttribute('xmlns'), NS)
})

test('creator reclaim requires local independent capability and live joined connection', async () => {
  const f = setup()
  assert.equal(f.client.canReclaimHost(f.api, ROOM, false), false)
  f.store.saveCreatorRecoveryKey(ROOM, 'C'.repeat(43))
  assert.equal(f.client.canReclaimHost(f.api, ROOM, false), true)
  assert.equal(f.client.canReclaimHost(f.api, ROOM, true), false)
  f.connection.connected = false
  assert.equal(f.client.canReclaimHost(f.api, ROOM, false), false)
  await assert.rejects(f.client.requestHostReclaim(f.api, ROOM))
  assert.equal(f.requests.length, 0)
})

test('reclaim sends no target and response loss retries the same operation', async () => {
  const f = setup()
  f.store.saveCreatorRecoveryKey(ROOM, 'C'.repeat(43))
  const first = f.client.requestHostReclaim(f.api, ROOM)
  const firstCheck = assert.rejects(first)
  const command = f.requests[0].stanza.children[0]
  assert.equal(command.localName, 'reclaim')
  assert.equal(command.getAttribute('creatorCredential'), 'C'.repeat(43))
  assert.equal(command.getAttribute('target'), null)
  const op = command.getAttribute('operationId')
  f.requests[0].error(null)
  await firstCheck
  const retry = f.client.requestHostReclaim(f.api, ROOM)
  assert.equal(f.requests[1].stanza.children[0].getAttribute('operationId'), op)
  f.requests[1].success(response('reclaim', { operationId: op, state: 'roles-committed' }))
  assert.equal(await retry, op)
  await flush()
  assert.equal(f.requests[2].stanza.children[0].localName, 'claim')
  assert.deepEqual(f.completed, [])
})

test('reclaim rejects forged response and duplicate request without emitting a second operation', async () => {
  const f = setup()
  f.store.saveCreatorRecoveryKey(ROOM, 'C'.repeat(43))
  const first = f.client.requestHostReclaim(f.api, ROOM)
  const check = assert.rejects(first)
  await assert.rejects(f.client.requestHostReclaim(f.api, ROOM))
  assert.equal(f.requests.length, 1)
  f.requests[0].success(response('reclaim', { operationId: 'wrong', state: 'roles-committed' }))
  await check
  assert.equal(f.requests.length, 1)
})

test('proof bytes match server HMAC contract', async () => {
  const { client } = setup()
  const args = [KEY, ROOM, OPERATION, SESSION_JID, 'old-instance', 'new-instance', 'nonce-123456789012']
  const proof = await client.makeHostTransferProof(...args)
  const expected = createHmac('sha256', KEY)
    .update(['host-transfer-rebind-v1', ...args.slice(1)].join('\n'))
    .digest('base64url')
  assert.equal(proof, expected)
})

test('credential is saved before ack and completion clears pending receipt', async () => {
  const fixture = setup()
  fixture.attach()
  fixture.deliver()
  assert.equal(fixture.store.getPendingHostTransfer(ROOM).hostKey, KEY)
  assert.equal(fixture.store.getSession(ROOM).hostKey, KEY)
  assert.equal(fixture.requests[0].stanza.children[0].localName, 'ack')
  fixture.requests[0].success(response('ack', { operationId: OPERATION, state: 'complete' }))
  await flush()
  assert.deepEqual(fixture.completed, [KEY])
  assert.equal(fixture.store.getPendingHostTransfer(ROOM), null)
})

test('only an exact server-attested predecessor can replace a live pending receipt', async () => {
  const f = setup()
  f.attach()
  f.store.savePendingHostTransfer(ROOM, { operationId: 'old-op', hostKey: 'old-key', expiresAt: Date.now() + 300000 })
  f.deliver('new-op')
  assert.equal(f.store.getPendingHostTransfer(ROOM).operationId, 'old-op')
  f.deliver('new-op', 'wrong-op')
  assert.equal(f.store.getPendingHostTransfer(ROOM).operationId, 'old-op')
  f.deliver('new-op', 'old-op')
  assert.equal(f.store.getPendingHostTransfer(ROOM).operationId, 'new-op')
  assert.equal(f.requests[0].stanza.children[0].localName, 'ack')
  f.requests[0].success(response('ack', { operationId: 'new-op', state: 'complete' }))
  await flush()
  assert.deepEqual(f.completed, [KEY])
})

test('late old ack cannot complete superseded credential and replacement ack follows', async () => {
  const f = setup()
  f.attach()
  f.deliver('old-op')
  f.deliver('new-op', 'old-op')
  f.requests[0].success(response('ack', { operationId: 'old-op', state: 'complete' }))
  await flush()
  assert.deepEqual(f.completed, [])
  assert.equal(f.store.getPendingHostTransfer(ROOM).operationId, 'new-op')
  assert.equal(f.requests[1].stanza.children[0].getAttribute('operationId'), 'new-op')
  f.requests[1].success(response('ack', { operationId: 'new-op', state: 'complete' }))
  await flush()
  assert.deepEqual(f.completed, [KEY])
})

test('rejoin proves stored key then confirms only after role recovery', async () => {
  const fixture = setup()
  fixture.store.savePendingHostTransfer(ROOM, {
    operationId: OPERATION, hostKey: KEY, expiresAt: Date.now() + 300000,
  })
  fixture.attach()
  assert.equal(fixture.requests[0].stanza.children[0].localName, 'recover')
  fixture.requests[0].success(response('challenge', { operationId: OPERATION, roomName: ROOM,
    targetSession: SESSION_JID, expectedRoomInstance: 'old-instance',
    roomInstance: 'new-instance', nonce: 'nonce-123456789012',
    expiresAt: Math.floor(Date.now() / 1000) + 30 }))
  await flush()
  assert.equal(fixture.requests[1].stanza.children[0].localName, 'rebind')
  const proof = fixture.requests[1].stanza.children[0].getAttribute('proof')
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/)
  fixture.requests[1].success(response('rebind', { operationId: OPERATION, state: 'roles-committed' }))
  await flush()
  assert.equal(fixture.requests[2].stanza.children[0].localName, 'ack')
  fixture.requests[2].success(response('ack', { operationId: OPERATION, state: 'complete' }))
  await flush()
  assert.deepEqual(fixture.completed, [KEY])
})

test('forged room message and wrong challenge session never confirm', async () => {
  const fixture = setup()
  fixture.attach()
  const forged = doc.createElementNS('jabber:client', 'message')
  forged.setAttribute('from', `${ROOM_JID}/peer`)
  forged.setAttribute('type', 'normal')
  fixture.handler(forged)
  assert.equal(fixture.requests.length, 0)
  fixture.store.savePendingHostTransfer(ROOM, {
    operationId: OPERATION, hostKey: KEY, expiresAt: Date.now() + 300000,
  })
  fixture.rejectHostToken()
  fixture.attach()
  fixture.requests[0].success(response('challenge', { operationId: OPERATION, roomName: ROOM,
    targetSession: 'attacker@guest.test/device', expectedRoomInstance: 'old-instance',
    roomInstance: 'new-instance', nonce: 'nonce-123456789012',
    expiresAt: Math.floor(Date.now() / 1000) + 30 }))
  await flush()
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.completed.length, 0)
  assert.equal(fixture.errors.length, 1)
})

test('storage failure never sends acknowledgement', () => {
  const fixture = setup()
  fixture.attach()
  fixture.rejectStorageWrites()
  fixture.deliver()
  assert.equal(fixture.requests.length, 0)
  assert.equal(fixture.completed.length, 0)
  assert.equal(fixture.errors.length, 1)
})

test('promoted target without first credential requests a private redelivery', async () => {
  const fixture = setup()
  fixture.setLocalRole('participant')
  fixture.attach()
  assert.equal(fixture.requests.length, 0)
  fixture.setLocalRole('moderator')
  fixture.timers[0]()
  await flush()
  assert.equal(fixture.requests[0].stanza.children[0].localName, 'claim')
  fixture.deliver()
  assert.equal(fixture.requests[1].stanza.children[0].localName, 'ack')
})

test('lost ack response is resolved by a verified completed host token', async () => {
  const fixture = setup()
  fixture.attach()
  fixture.deliver()
  fixture.requests[0].error(null)
  await flush()
  assert.deepEqual(fixture.completed, [KEY])
  assert.equal(fixture.store.getPendingHostTransfer(ROOM), null)
})

test('source resolves a live participant to the exact MUC occupant', async () => {
  const fixture = setup()
  const result = fixture.client.requestHostTransfer(fixture.api, ROOM, fixture.targetId)
  assert.equal(fixture.requests[0].stanza.children[0].getAttribute('target'), fixture.targetNick)
  const operation = fixture.requests[0].stanza.children[0].getAttribute('operationId')
  fixture.requests[0].success(response('transfer', { operationId: operation, state: 'roles-committed' }))
  assert.equal(await result, operation)
})

test('source rejects hidden, changed-role and unknown MUC targets before sending', async () => {
  const fixture = setup()
  fixture.conference.room.members[fixture.targetNick].isFocus = true
  await assert.rejects(() => fixture.client.requestHostTransfer(fixture.api, ROOM, fixture.targetId))
  fixture.conference.room.members[fixture.targetNick].isFocus = false
  fixture.conference.room.members[fixture.targetNick].role = 'moderator'
  await assert.rejects(() => fixture.client.requestHostTransfer(fixture.api, ROOM, fixture.targetId))
  fixture.conference.room.members[fixture.targetNick].role = 'participant'
  await assert.rejects(() => fixture.client.requestHostTransfer(fixture.api, ROOM, 'unknown1'))
  assert.equal(fixture.requests.length, 0)
})
