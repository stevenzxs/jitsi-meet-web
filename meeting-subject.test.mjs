import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = readFileSync(new URL('./src/components/MeetingStage.vue', import.meta.url), 'utf8')
const ast = ts.createSourceFile('stage.ts', source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1], ts.ScriptTarget.Latest, true)
function run(name, context) {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn, `${name} exists`)
  vm.createContext(context)
  vm.runInContext(ts.transpile(fn.getText(ast)), context)
  return context[name]
}

test('public banner renderer never paints participant video tiles', () => {
  let reconciled = 0, removed = 0
  const fn = run('applyMeetingBannerOverlays', {
    reconcileMeetingPermissions: () => reconciled++,
    removeMeetingBannerOverlay: () => removed++,
    getJitsiFrameDocument: () => { throw new Error('must not render video overlays') },
  })
  fn()
  assert.equal(reconciled, 1)
  assert.equal(removed, 1)
  assert.equal((source.match(/class="meeting-subject-banner"/g) || []).length, 1)
})

test('canonical state refresh reads persisted room subject rather than message text', async () => {
  const state = { text: '服务器主题', visible: true, updatedAt: 7 }
  const context = {
    props: { roomName: '123456789' }, status: { value: 'joined' },
    jitsiApi: { value: {} }, meetingBanner: { value: {} },
    fetchMeetingBanner: async () => state,
    normalizeMeetingBannerState: value => value,
  }
  await run('refreshMeetingSubject', context)()
  assert.equal(context.meetingBanner.value.text, '服务器主题')
})

test('save failure leaves visible state unchanged and never broadcasts', async () => {
  let applied = 0, broadcast = 0
  const api = {}, conference = {}
  const context = {
    jitsiApi: { value: api }, localModerator: { value: true }, hostKey: { value: 'key' },
    getJoinedModeratorConference: () => conference, props: { roomName: '123456789' },
    bannerLogoSaving: { value: false }, bannerDraftText: { value: '新主题' },
    bannerDraftLogoUrl: { value: '' }, bannerLogoFile: { value: null }, bannerDraftVisible: { value: true },
    bannerDraftFontSize: { value: 32 }, bannerDraftColor: { value: '#FFFFFF' },
    bannerDraftFontFamily: { value: '' }, bannerDraftBgColor: { value: '' },
    BANNER_TEXT_MAX_LENGTH: 80, BANNER_COLOR_DEFAULT: '#FFFFFF',
    clampBannerFontSize: v => v, normalizeBannerColor: v => v,
    normalizeBannerFontFamily: v => v, normalizeBannerBgColor: v => v,
    bannerLogoError: { value: '' }, bannerPanelOpen: { value: true },
    saveMeetingBanner: async () => { throw Error('offline') },
    applyLocalMeetingBannerState: () => applied++, broadcastLocalMeetingBannerState: () => broadcast++,
  }
  await run('saveBannerPanel', context)()
  assert.equal(applied, 0)
  assert.equal(broadcast, 0)
  assert.equal(context.bannerPanelOpen.value, true)
  assert.match(context.bannerLogoError.value, /offline/)
  assert.equal(context.bannerLogoSaving.value, false)
})

test('server refresh never truncates a previously created long subject', () => {
  const text = '会'.repeat(120)
  const context = {
    BANNER_TEXT_MAX_LENGTH: 80, normalizeBannerLogoUrl: () => '',
    clampBannerFontSize: () => 32, normalizeBannerColor: () => '#FFFFFF',
    BANNER_COLOR_DEFAULT: '#FFFFFF', normalizeBannerFontFamily: () => '',
    normalizeBannerBgColor: () => '',
  }
  assert.equal(run('normalizeMeetingBannerState', context)({ text, visible: true, updatedAt: 1 }).text, text)
})

test('editor never silently truncates a historical subject', () => {
  const context = { bannerDraftText: { value: '' }, BANNER_TEXT_MAX_LENGTH: 80 }
  const text = '会'.repeat(120)
  run('handleBannerTextInput', context)({ target: { value: text } })
  assert.equal(context.bannerDraftText.value, text)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveBannerPanel')
  assert.doesNotMatch(fn.getText(ast), /trim\(\)\.slice/)
  assert.doesNotMatch(source, /<textarea[\s\S]*?id="meeting-banner-text"[\s\S]*?maxlength="80"/)
})

test('refresh repairs poisoned client timestamps but ignores delayed older responses', async () => {
  const context = {
    props: { roomName: '123456789' }, status: { value: 'joined' }, jitsiApi: { value: {} },
    meetingBanner: { value: { text: '旧', updatedAt: Number.MAX_SAFE_INTEGER } },
    fetchMeetingBanner: async () => ({ text: '权威主题', updatedAt: 10 }),
    normalizeMeetingBannerState: value => value,
  }
  const refresh = run('refreshMeetingSubject', context)
  await refresh()
  assert.equal(context.meetingBanner.value.text, '权威主题')
  context.fetchMeetingBanner = async () => ({ text: '延迟旧响应', updatedAt: 9 })
  await refresh()
  assert.equal(context.meetingBanner.value.text, '权威主题')
})

test('missed notification has a continuing refresh path with teardown', () => {
  assert.match(source, /meetingSubjectRefreshTimer = window\.setInterval\([\s\S]*?refreshMeetingSubject\(\)[\s\S]*?10_000/)
  assert.match(source, /window\.clearInterval\(meetingSubjectRefreshTimer\)/)
})

test('successful save applies and broadcasts the server response, not the client clock', async () => {
  const api = {}, conference = {}
  let applied, broadcast
  const canonical = { text: '服务端主题', visible: true, updatedAt: 42 }
  const context = {
    jitsiApi: { value: api }, localModerator: { value: true }, hostKey: { value: 'key' },
    getJoinedModeratorConference: () => conference, props: { roomName: '123456789' },
    bannerLogoSaving: { value: false }, bannerDraftText: { value: '新主题' },
    bannerDraftLogoUrl: { value: '' }, bannerLogoFile: { value: null }, bannerDraftVisible: { value: true },
    bannerDraftFontSize: { value: 32 }, bannerDraftColor: { value: '#FFFFFF' },
    bannerDraftFontFamily: { value: '' }, bannerDraftBgColor: { value: '' },
    BANNER_TEXT_MAX_LENGTH: 80, BANNER_COLOR_DEFAULT: '#FFFFFF',
    clampBannerFontSize: v => v, normalizeBannerColor: v => v,
    normalizeBannerFontFamily: v => v, normalizeBannerBgColor: v => v,
    bannerLogoError: { value: '' }, bannerPanelOpen: { value: true },
    saveMeetingBanner: async () => canonical, normalizeMeetingBannerState: value => value,
    applyLocalMeetingBannerState: state => { applied = state },
    broadcastLocalMeetingBannerState: state => { broadcast = state }, setBannerLogoFile() {},
  }
  await run('saveBannerPanel', context)()
  assert.equal(applied.text, canonical.text)
  assert.equal(applied.updatedAt, 42)
  assert.equal(broadcast, applied)
  assert.equal(context.bannerPanelOpen.value, false)
})
