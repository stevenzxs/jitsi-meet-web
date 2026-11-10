import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const root = process.env.WEB_TEST_ROOT || fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(`${root}/package.json`)
const ts = require('typescript')

// Execute the actual SFC synchronization functions with a fake message transport and clock.
function extract(relativePath, names) {
  const file = `${root}/${relativePath}`
  let source = readFileSync(file, 'utf8')
  if (file.endsWith('.vue')) source = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return ast.statements.filter(node => {
    if (ts.isFunctionDeclaration(node)) return names.includes(node.name?.text)
    return ts.isVariableStatement(node) && node.declarationList.declarations.every(declaration =>
      /^(BANNER_|MEETING_BANNER_)/.test(declaration.name.getText(ast)))
  }).map(node => node.getText(ast)).join('\n')
}

const code = ts.transpileModule([
  extract('src/utils/jitsi.ts', ['getEndpointMessage']),
  extract('src/utils/meetingPermissions.ts', ['getEndpointSenderParticipantId']),
  extract('src/components/MeetingStage.vue', [
    'normalizeParticipantId', 'parseMeetingBannerMessage', 'createDefaultMeetingBannerState',
    'normalizeMeetingBannerState', 'normalizeBannerLogoUrl', 'clampBannerFontSize',
    'normalizeBannerColor', 'normalizeBannerBgColor', 'normalizeBannerFontFamily',
    'meetingBannerHasContent', 'getAndroidMainBannerEntry',
    'applyLocalMeetingBannerState',
    'broadcastLocalMeetingBannerState', 'syncLocalMeetingBannerToParticipant',
    'applyParticipantMeetingBannerState', 'encodeMeetingBannerMessage',
    'getRemoteParticipantIds', 'sendMeetingBannerStateToParticipant',
    'requestMissingMeetingBannerStates', 'clearMeetingBannerStateSync',
    'scheduleMeetingBannerStateSync', 'handleMeetingBannerMessage', 'cleanupMeetingApiListeners',
  ]),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

const REQUEST = 'cloudmeet:meeting-banner-request'
const STATE = 'cloudmeet:meeting-banner'
const banner = (text = '会议电子屏', updatedAt = 1) => ({
  visible: Boolean(text), text, logoUrl: '', fontSize: 32, color: '#FFFFFF',
  fontFamily: '', bgColor: '', position: 'top', updatedAt,
})
const event = (id, text) => ({ data: { senderInfo: { id }, eventData: { text } } })

function harness(peers = ['host']) {
  let now = 0, nextTimer = 0, transport = () => {}, renders = 0
  const jobs = new Map(), sent = []
  const ctx = {
    exports: {}, status: { value: 'joined' }, localParticipantId: { value: 'android' },
    androidEmbed: true, localModerator: { value: false },
    getJoinedModeratorConference: () => ({}),
    refreshMeetingSubject: async () => {},
    getParticipantRole: (_api, id) => peers.includes(id) ? 'moderator' : '',
    getParticipantId: value => typeof value === 'string' ? value : value?.participantId || '',
    androidMainParticipantId: { value: '' },
    meetingBanner: { value: banner('', 0) }, participantMeetingBanners: { value: {} },
    meetingBannerStateSyncTimers: [], meetingApiListenerCleanups: [],
    removeGridVideoClickHandlers: null,
    scheduleMeetingBannerOverlaySync: () => renders++,
    console: { warn() {} },
    window: {
      setTimeout(fn, delay) { const id = ++nextTimer; jobs.set(id, { fn, at: now + delay }); return id },
      clearTimeout(id) { jobs.delete(id) },
    },
    jitsiApi: { value: {
      getParticipantsInfo: () => ['android', ...peers].map(participantId => ({ participantId })),
      executeCommand(command, id, text) {
        assert.equal(command, 'sendEndpointTextMessage')
        sent.push({ id, text, at: now })
        transport(id, text)
      },
    } },
  }
  vm.createContext(ctx)
  vm.runInContext(code, ctx)
  const h = {
    ctx, sent, jobs,
    transport(fn) { transport = fn },
    state(id, value = banner()) { ctx.handleMeetingBannerMessage(event(id, JSON.stringify({ type: STATE, banner: value }))) },
    advance(until) {
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, job] = next
        jobs.delete(id); now = job.at; job.fn()
      }
      now = until
    },
    get renders() { return renders },
  }
  return h
}

test('lost initial push and early requests recover when the receiver/channel becomes ready', () => {
  const h = harness()
  h.ctx.scheduleMeetingBannerStateSync()
  h.advance(1500)
  assert.equal(h.sent.length, 3)
  assert.equal(h.renders, 0)
  h.transport((id, text) => { if (text === REQUEST) h.state(id) })
  h.advance(20000)
  assert.equal(h.ctx.participantMeetingBanners.value.host.text, '会议电子屏')
  assert.equal(h.sent.length, 4, 'stop requesting that owner after the first reply')
  assert.equal(h.renders, 1)
})

test('received pushes count as confirmation and only missing peers are requested', () => {
  const h = harness(['host', 'other'])
  h.state('host')
  h.transport((id, text) => { if (text === REQUEST) h.state(id, banner('', 0)) })
  h.ctx.scheduleMeetingBannerStateSync()
  h.advance(20000)
  assert.deepEqual(h.sent.map(item => item.id), ['other'])
  assert.equal(h.ctx.participantMeetingBanners.value.other.visible, false)
})

test('state requests return the current state, including an empty state, without a request loop', () => {
  const h = harness()
  h.ctx.handleMeetingBannerMessage(event('host', REQUEST))
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].id, 'host')
  const reply = JSON.parse(h.sent[0].text)
  assert.equal(reply.type, STATE)
  assert.equal(reply.participantId, 'android')
  assert.equal(reply.banner.visible, false)
  assert.equal(reply.banner.updatedAt, 0)
  h.ctx.localModerator.value = true
  h.ctx.meetingBanner.value = banner('更新后的内容', 2)
  h.ctx.handleMeetingBannerMessage(event('host', REQUEST))
  assert.equal(JSON.parse(h.sent[1].text).banner.text, '更新后的内容')
  assert.equal(h.jobs.size, 0)
})

test('retries are finite even when a peer never responds', () => {
  const h = harness()
  h.ctx.scheduleMeetingBannerStateSync()
  h.advance(60000)
  assert.equal(h.sent.length, 6)
  assert.equal(h.jobs.size, 0)
})

test('stale moderator cannot broadcast or reply with nonempty banner when live authority is lost', () => {
  const h = harness(['host'])
  h.ctx.androidEmbed = false
  h.ctx.localModerator.value = true
  h.ctx.meetingBanner.value = banner('private stale state', 2)
  h.ctx.getJoinedModeratorConference = () => null
  h.ctx.broadcastLocalMeetingBannerState()
  h.ctx.syncLocalMeetingBannerToParticipant('host')
  assert.equal(h.sent.length, 0)
  h.ctx.handleMeetingBannerMessage(event('host', REQUEST))
  assert.equal(h.sent.length, 1)
  assert.equal(JSON.parse(h.sent[0].text).banner.text, '')
})

test('live moderator still broadcasts and synchronizes its current banner', () => {
  const h = harness(['host'])
  h.ctx.androidEmbed = false
  h.ctx.localModerator.value = true
  h.ctx.meetingBanner.value = banner('authorized state', 2)
  h.ctx.broadcastLocalMeetingBannerState()
  h.ctx.syncLocalMeetingBannerToParticipant('host')
  assert.equal(h.sent.length, 2)
  assert.ok(h.sent.every(item => item.id === 'host' && JSON.parse(item.text).banner.text === 'authorized state'))
})

test('restart replaces pending timers and cleanup cancels all requests', () => {
  const h = harness()
  let cleaned = false
  h.ctx.meetingApiListenerCleanups.push(() => { cleaned = true })
  h.ctx.scheduleMeetingBannerStateSync()
  h.ctx.scheduleMeetingBannerStateSync()
  assert.equal(h.jobs.size, 6)
  h.advance(0)
  h.ctx.cleanupMeetingApiListeners()
  h.advance(60000)
  assert.equal(h.sent.length, 1)
  assert.equal(h.jobs.size, 0)
  assert.equal(cleaned, true)
})

test('late state replies cannot overwrite newer edits', () => {
  const h = harness()
  h.state('host', banner('最新文字', 10))
  h.state('host', banner('旧文字', 2))
  assert.equal(h.ctx.participantMeetingBanners.value.host.text, '最新文字')
  assert.equal(h.renders, 1)
})

test('Android no longer exposes a participant-bound main-video banner', () => {
  const h = harness(['electron', 'other'])
  h.state('electron', banner('你好你好'))
  h.ctx.participantMeetingBanners.value.android = banner('不应出现在 Android 自拍上')
  h.ctx.androidMainParticipantId.value = 'android'
  assert.equal(h.ctx.getAndroidMainBannerEntry, undefined)
  h.ctx.androidMainParticipantId.value = 'other'
  assert.equal(h.ctx.getAndroidMainBannerEntry, undefined)
  h.ctx.androidMainParticipantId.value = 'electron'
  assert.equal(h.ctx.getAndroidMainBannerEntry, undefined)
  h.state('electron', banner('', 2))
  assert.equal(h.ctx.getAndroidMainBannerEntry, undefined)
})

test('Android never creates, stores, or broadcasts its own electronic screen', () => {
  const h = harness(['electron'])
  assert.doesNotMatch(code, /sessionStorage\.setItem/)
  h.ctx.applyLocalMeetingBannerState(banner('本地残留'))
  assert.equal(h.ctx.meetingBanner.value.text, '')
  assert.equal(Object.keys(h.ctx.participantMeetingBanners.value).length, 0)
  h.ctx.broadcastLocalMeetingBannerState(banner('本地残留'))
  h.ctx.syncLocalMeetingBannerToParticipant({ participantId: 'electron' })
  assert.equal(h.sent.length, 0)
})

test('not joined, malformed messages and requests without a remote sender do not send', () => {
  const h = harness()
  h.ctx.status.value = 'left'
  h.ctx.scheduleMeetingBannerStateSync()
  h.advance(60000)
  h.ctx.handleMeetingBannerMessage(event('android', REQUEST))
  h.ctx.handleMeetingBannerMessage({ data: { eventData: { text: REQUEST } } })
  h.ctx.handleMeetingBannerMessage(event('host', 'not-json'))
  assert.equal(h.sent.length, 0)
})

test('banner messages without transport sender cannot impersonate a moderator', () => {
  const h = harness()
  h.ctx.handleMeetingBannerMessage({ data: { eventData: { text: JSON.stringify({ type: STATE, participantId: 'host', banner: banner() }) } } })
  assert.equal(Object.keys(h.ctx.participantMeetingBanners.value).length, 0)
})

test('ordinary sender cannot publish even when payload names a moderator', () => {
  const h = harness()
  h.ctx.handleMeetingBannerMessage(event('guest', JSON.stringify({ type: STATE, participantId: 'host', banner: banner() })))
  assert.equal(Object.keys(h.ctx.participantMeetingBanners.value).length, 0)
})

test('ordinary clients answer state requests only with empty state', () => {
  const h = harness()
  h.ctx.meetingBanner.value = banner('旧版残留内容')
  h.ctx.handleMeetingBannerMessage(event('host', REQUEST))
  assert.equal(JSON.parse(h.sent[0].text).banner.visible, false)
})
