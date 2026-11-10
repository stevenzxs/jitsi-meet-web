import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { webcrypto } from 'node:crypto'

const require = createRequire(import.meta.url)
const ts = require('typescript')
function setup() {
  const storage = new Map()
  const localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) }
  const modules = new Map()
  const calls = []
  const posted = []
  let records = []
  let failDelete = false
  const request = {
    get: async () => records,
    post: async (_url, data) => { posted.push(data); return { ...data, scheduledEndTime: '2030-01-01T11:00:00Z' } },
    del: async (...args) => { calls.push(args); if (failDelete) throw new Error('denied') },
  }
  function load(path) {
    if (modules.has(path)) return modules.get(path)
    const exports = {}
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    vm.runInNewContext(code, { exports, localStorage, sessionStorage: localStorage, console,
      crypto: webcrypto, btoa: value => Buffer.from(value, 'binary').toString('base64'),
      require: name => name === './request' ? request : load('./src/stores/meeting.ts') })
    modules.set(path, exports)
    return exports
  }
  return { api: load('./src/api/meetingApi.ts'), store: load('./src/stores/meeting.ts'), calls, posted,
    records: value => { records = value }, fail: () => { failDelete = true } }
}
const meeting = { roomName: '123456789', subject: '会议', date: '2030-01-01', time: '10:00',
  durationMin: 60, endTime: 1893495600000, password: 'local-password', displayName: '主持人', hostKey: 'local-key', creatorId: 'creator', createdAt: 1 }
const record = { ...meeting, hostKey: null, password: null, status: 'SCHEDULED',
  scheduledStartTime: '2030-01-01T10:00:00Z', scheduledEndTime: '2030-01-01T11:00:00Z' }

test('scheduled refresh preserves local credentials when server redacts them', async () => {
  const s = setup(); s.store.addScheduled(meeting); s.records([record])
  const result = await s.api.fetchScheduledMeetings('creator')
  assert.equal(result[0].hostKey, 'local-key')
  assert.equal(result[0].password, 'local-password')
  assert.equal(s.store.listScheduled()[0].hostKey, 'local-key')
})
test('history credentials survive scheduled list removal', async () => {
  const s = setup(); s.store.addScheduled(meeting); s.records([])
  await s.api.fetchScheduledMeetings('creator')
  s.records([{ ...record, status: 'ENDED' }])
  assert.equal((await s.api.fetchMeetingHistory('creator'))[0].hostKey, 'local-key')
})
test('new instant meetings persist their local credentials', async () => {
  const s = setup(); await s.api.createInstantMeeting(meeting)
  s.records([{ ...record, status: 'ENDED' }])
  assert.equal((await s.api.fetchMeetingHistory('creator'))[0].hostKey, 'local-key')
  assert.match(s.posted[0].creatorRecoveryKey, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(s.posted[0].creatorRecoveryKey, meeting.hostKey)
  assert.equal(s.store.getCreatorRecoveryKey(meeting.roomName), s.posted[0].creatorRecoveryKey)
  await s.api.createInstantMeeting(meeting)
  assert.equal(s.posted[1].creatorRecoveryKey, s.posted[0].creatorRecoveryKey)
})
test('scheduled creation stores a separate creator proof without adding it to meeting lists', async () => {
  const s = setup()
  await s.api.saveScheduledMeeting(meeting)
  assert.match(s.posted[0].creatorRecoveryKey, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(s.store.getCreatorRecoveryKey(meeting.roomName), s.posted[0].creatorRecoveryKey)
  assert.equal('creatorRecoveryKey' in s.store.listScheduled()[0], false)
})
test('cancel uses header credentials and removes cache only after success', async () => {
  const s = setup(); s.store.addScheduled(meeting); s.fail()
  await assert.rejects(() => s.api.cancelScheduledMeeting(meeting.roomName, 'creator', 'local-key'))
  assert.equal(s.store.listScheduled().length, 1)
  assert.equal(s.calls[0][1].headers['X-Host-Key'], 'local-key')
  assert.doesNotMatch(s.calls[0][0], /local-key/)
})
test('delete requires a local key rather than creatorId', async () => {
  const s = setup()
  await assert.rejects(() => s.api.deleteHistoryMeeting(meeting.roomName, 'creator'))
  assert.equal(s.calls.length, 0)
})
test('creator proof is removed only after history deletion succeeds', async () => {
  const s = setup()
  await s.api.createInstantMeeting(meeting)
  const key = s.store.getCreatorRecoveryKey(meeting.roomName)
  s.fail()
  await assert.rejects(() => s.api.deleteHistoryMeeting(meeting.roomName, 'creator', 'local-key'))
  assert.equal(s.store.getCreatorRecoveryKey(meeting.roomName), key)
  const successful = setup()
  await successful.api.createInstantMeeting(meeting)
  await successful.api.deleteHistoryMeeting(meeting.roomName, 'creator', 'local-key')
  assert.equal(successful.store.getCreatorRecoveryKey(meeting.roomName), null)
})

test('host handoff clears only the transferred key and retains creator proof', () => {
  const s = setup()
  s.store.addScheduled(meeting)
  s.store.saveSession({ roomName: meeting.roomName, subject: meeting.subject,
    password: meeting.password, displayName: meeting.displayName, createdAt: 1,
    host: true, hostKey: meeting.hostKey })
  s.store.saveCreatorRecoveryKey(meeting.roomName, 'A'.repeat(43))
  s.store.clearTransferredHostKey(meeting.roomName, meeting.hostKey)
  assert.equal(s.store.getMeetingCredentials(meeting.roomName).hostKey, '')
  assert.equal(s.store.getSession(meeting.roomName).hostKey, undefined)
  assert.equal(s.store.listScheduled()[0].hostKey, '')
  assert.equal(s.store.getCreatorRecoveryKey(meeting.roomName), 'A'.repeat(43))
})

test('late source cleanup cannot erase a newer host key', () => {
  const s = setup()
  s.store.addScheduled(meeting)
  s.store.saveMeetingCredentials(meeting.roomName, { hostKey: 'new-key', password: meeting.password })
  s.store.clearTransferredHostKey(meeting.roomName, meeting.hostKey)
  assert.equal(s.store.getMeetingCredentials(meeting.roomName).hostKey, 'new-key')
})
