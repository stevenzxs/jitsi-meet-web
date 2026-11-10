import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'
import fs from 'node:fs'
const source = fs.readFileSync('src/utils/roomPassword.ts', 'utf8')
const js = ts.transpile(source, { module: ts.ModuleKind.ES2022 })
const { createRoomPasswordGuard } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('waits for moderator, confirms lock and never reapplies after success', () => {
  let state = { moderator: false, locked: false }
  let writes = 0, failures = 0
  const tick = createRoomPasswordGuard({ read: () => state, lock: () => writes++, failed: () => failures++, deadline: 100 })
  assert.equal(tick(0), false)
  assert.equal(writes, 0)
  state.moderator = true
  assert.equal(tick(1), false)
  assert.equal(writes, 1)
  state.locked = true
  assert.equal(tick(2), true)
  state.locked = false
  assert.equal(tick(3), true)
  assert.equal(writes, 1)
  assert.equal(failures, 0)
})

test('fails explicitly on timeout and stops password writes', () => {
  let failures = 0, writes = 0
  const tick = createRoomPasswordGuard({ read: () => ({ moderator: true, locked: false }), lock: () => writes++, failed: () => failures++, deadline: 10 })
  tick(0)
  assert.equal(tick(10), true)
  tick(11)
  assert.equal(failures, 1)
  assert.equal(writes, 1)
})

test('retries only while authorized and awaiting server confirmation', () => {
  let state = { moderator: true, locked: false }, writes = 0
  const tick = createRoomPasswordGuard({ read: () => state, lock: () => writes++, failed: () => assert.fail(), deadline: 15000 })
  tick(0)
  tick(200)
  assert.equal(writes, 1)
  state.moderator = false
  tick(1000)
  assert.equal(writes, 1)
  state.moderator = true
  tick(1200)
  assert.equal(writes, 2)
  state.locked = true
  assert.equal(tick(1400), true)
})

test('frame starts guarded host setup after join and cancels it on disposal', () => {
  const frame = fs.readFileSync('src/components/JitsiFrame.vue', 'utf8')
  assert.match(frame, /ensureHostPassword\(\)/)
  assert.match(frame, /moderator: conference.isModerator\(\), locked: conference.room\?\.locked === true/)
  assert.match(frame, /function disposeApi[^]*?clearInterval\(hostPasswordTimer\)/)
  assert.doesNotMatch(frame, /props.jwt && props.password && !passwordTried/)
})
