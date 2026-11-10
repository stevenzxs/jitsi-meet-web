import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

test('host action switches at the same menu position using verified roles', async () => {
  const source = fs.readFileSync('src/utils/hostParticipantMenu.ts', 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ES2022 })
  const { getHostParticipantAction } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  assert.equal(getHostParticipantAction(true, false, 'participant', false), 'transfer')
  assert.equal(getHostParticipantAction(false, true, 'moderator', false), 'reclaim')
  assert.equal(getHostParticipantAction(false, false, 'moderator', false), null)
  assert.equal(getHostParticipantAction(false, true, 'participant', false), null)
  assert.equal(getHostParticipantAction(true, true, 'moderator', true), null)
  assert.equal(getHostParticipantAction(false, true, '', false), null)
})

test('stage removes bottom reclaim and validates menu reclaim target', () => {
  const source = fs.readFileSync('src/components/MeetingStage.vue', 'utf8')
  assert.doesNotMatch(source, /creator-reclaim-button/)
  assert.match(source, /attachHostParticipantMenu/)
  assert.match(source, /clicked\?\.key === HOST_RECLAIM_MENU_ID/)
  assert.match(source, /getParticipantRole\(api, reclaimTargetId.value\) !== 'moderator'/)
})

test('pane menu follows selected member, live role changes and cleans up listeners', async () => {
  const source = fs.readFileSync('src/utils/hostParticipantMenu.ts', 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ES2022 })
  const { attachHostParticipantMenu } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  let config = { customParticipantMenuButtons: [{ id: 'cloudmeet-transfer-host', text: '设为主持人', icon: 'crown' }] }
  const listeners = new Map()
  let subscriber, action = 'transfer', unsubscribed = false
  const store = {
    getState: () => ({ 'features/base/config': config }),
    subscribe: fn => { subscriber = fn; return () => { unsubscribed = true } },
    dispatch: event => { config = event.config; subscriber?.() },
  }
  const frame = { APP: { store }, document: {
    addEventListener: (event, fn) => listeners.set(event, fn),
    removeEventListener: event => listeners.delete(event),
  } }
  const cleanup = attachHostParticipantMenu(frame, id => id === 'wangwu' ? action : null)
  assert.deepEqual(config.customParticipantMenuButtons, [])
  const target = { closest: () => ({ getAttribute: () => 'participant-more-options-wangwu' }) }
  listeners.get('click')({ target })
  assert.equal(config.customParticipantMenuButtons[0].text, '设置主持人')
  action = 'reclaim'
  subscriber()
  assert.equal(config.customParticipantMenuButtons[0].id, 'cloudmeet-reclaim-host')
  assert.equal(config.customParticipantMenuButtons[0].text, '收回主持人')
  action = null
  subscriber()
  assert.deepEqual(config.customParticipantMenuButtons, [])
  cleanup()
  assert.equal(unsubscribed, true)
  assert.equal(listeners.size, 0)
})
