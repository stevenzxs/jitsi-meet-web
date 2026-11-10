import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
const ts = createRequire(import.meta.url)('typescript')
test('expired pending token failure explains recovery without deleting uncertain credentials', async () => {
  const c = functions('./src/components/MeetingStage.vue', ['acquireHostToken'], {
    hostKey: { value: 'retained-key' }, hostToken: { value: null }, tokenReady: { value: false },
    displayName: { value: 'Guest' }, session: {}, props: { roomName: '123456789', mode: 'web' },
    performance: { now: () => 1 }, console: { info() {} }, fetchHostToken: async () => null,
    getPendingHostTransfer: () => ({ hostKey: 'retained-key', expiresAt: Date.now() - 1 }),
    errorMsg: { value: '' }, localModerator: { value: true }, setStatus() {},
    clearPendingHostTransfer() { throw new Error('must retain uncertain pending') },
  })
  await c.acquireHostToken()
  assert.match(c.errorMsg.value, /待确认转让已过期/)
  assert.match(c.errorMsg.value, /创建者/)
  assert.equal(c.hostKey.value, 'retained-key')
  assert.equal(c.localModerator.value, false)
  assert.equal(c.tokenReady.value, true)
})
test('creator reclaim confirms current eligibility and never reports roles-committed as complete', async () => {
  for (const eligible of [false, true]) {
    let calls = 0
    const messages = []
    const c = functions('./src/components/MeetingStage.vue', ['confirmHostReclaim'], {
      jitsiApi: { value: {} }, status: { value: 'joined' }, props: { roomName: '123456789' },
      reclaimDialogOpen: { value: true }, reclaimBusy: { value: false },
      transferBusy: { value: false }, canShowHostReclaim: { value: eligible },
      reclaimTargetId: { value: 'current-host' }, getParticipantRole: () => 'moderator',
      requestHostReclaim: async () => { calls++ }, showStageToast: text => messages.push(text),
    })
    await c.confirmHostReclaim()
    assert.equal(calls, eligible ? 1 : 0)
    assert.equal(c.reclaimBusy.value, false)
    assert.equal(messages.some(text => text.includes('收回成功')), false)
    if (eligible) assert.equal(messages.some(text => text.includes('等待')), true)
  }
})

test('reclaim menu and dialog require eligibility and explicit confirmation', () => {
  const source = readFileSync(new URL('./src/components/MeetingStage.vue', import.meta.url), 'utf8')
  assert.match(source, /if \(!canShowHostReclaim.value/)
  assert.doesNotMatch(source, /creator-reclaim-button/)
  assert.match(source, /v-if="reclaimDialogOpen"/)
  assert.match(source, /@click="confirmHostReclaim"/)
})
test('shell close menu requires live moderator and host key, never toolbar role cache alone', () => {
  for (const [live, key] of [[false, 'key'], [true, ''], [true, 'key']]) {
    const c = functions('./src/components/MeetingStage.vue', ['requestCloseFromShell'], {
      status: { value: 'joined' }, customToolbar: { value: { closeFloatingMenus() {}, isModerator: () => true } },
      jitsiApi: { value: {} }, hostKey: { value: key },
      getJoinedModeratorConference: () => live ? {} : null,
      applyShellCloseMenuAnchor() {}, shellCloseMenuCanEndForAll: { value: true },
      shellCloseMenuOpen: { value: false }, requestLeaveAndClose() { throw Error('unexpected leave') },
    })
    assert.equal(c.requestCloseFromShell(), true)
    assert.equal(c.shellCloseMenuCanEndForAll.value, Boolean(live && key))
    assert.equal(c.shellCloseMenuOpen.value, true)
  }
})

test('shell end action rechecks live authority and credentials at click time', () => {
  for (const [live, key] of [[false, 'key'], [true, ''], [true, 'key']]) {
    let calls = 0
    const c = functions('./src/components/MeetingStage.vue', ['endForAllFromShellCloseMenu'], {
      customToolbar: { value: { endMeetingForAll() { calls++ } } },
      jitsiApi: { value: {} }, hostKey: { value: key },
      getJoinedModeratorConference: () => live ? {} : null,
    })
    c.endForAllFromShellCloseMenu()
    assert.equal(calls, live && key ? 1 : 0)
  }
})

test('overlay refresh reconciles missed role revocations even without an accessible document', () => {
  const removed = []
  let updates = 0
  const c = functions('./src/components/MeetingStage.vue', ['applyMeetingBannerOverlays', 'reconcileMeetingPermissions'], {
    jitsiApi: { value: {} }, localParticipantId: { value: 'me' },
    localModerator: { value: true }, localRole: { value: 'moderator' },
    participantMeetingBanners: { value: { host: {}, guest: {}, missing: {} } },
    getJoinedModeratorConference: () => null,
    getParticipantRole: (_, id) => id === 'host' ? 'moderator' : id === 'missing' ? '' : 'participant',
    setLocalModerator(value, role) { updates++; c.localModerator.value = value; c.localRole.value = role },
    removeParticipantMeetingBannerState: id => removed.push(id),
    getJitsiFrameDocument: () => null,
    removeMeetingBannerOverlay() {},
  })
  c.applyMeetingBannerOverlays()
  assert.equal(updates, 1)
  assert.equal(c.localModerator.value, false)
  assert.equal(c.localRole.value, 'participant')
  assert.deepEqual(removed, ['guest', 'missing'])
})

test('periodic permission reconciliation does not promote cached roles during disconnection', () => {
  const changes = []
  const c = functions('./src/components/MeetingStage.vue', ['reconcileMeetingPermissions'], {
    jitsiApi: { value: {} }, localParticipantId: { value: 'me' },
    localModerator: { value: true }, localRole: { value: 'moderator' },
    participantMeetingBanners: { value: {} },
    getJoinedModeratorConference: () => null, getParticipantRole: () => 'moderator',
    setLocalModerator: (...args) => changes.push(args), removeParticipantMeetingBannerState() {},
  })
  assert.equal(typeof c.reconcileMeetingPermissions, 'function')
  c.reconcileMeetingPermissions()
  assert.deepEqual(changes, [[false, '']])
})

test('permission reconciliation restores only live authority and leaves unchanged UI alone', () => {
  let joined = null
  const changes = []
  const c = functions('./src/components/MeetingStage.vue', ['reconcileMeetingPermissions'], {
    jitsiApi: { value: {} }, localParticipantId: { value: 'me' },
    localModerator: { value: false }, localRole: { value: '' },
    participantMeetingBanners: { value: {} },
    getJoinedModeratorConference: () => joined, getParticipantRole: () => 'moderator',
    setLocalModerator(value, role) {
      changes.push([value, role]); c.localModerator.value = value; c.localRole.value = role
    },
    removeParticipantMeetingBannerState() {},
  })
  c.reconcileMeetingPermissions()
  assert.equal(changes.length, 0)
  joined = {}
  c.reconcileMeetingPermissions()
  c.reconcileMeetingPermissions()
  assert.deepEqual(changes, [[true, 'moderator']])
})

test('server-driven leave settles the UI but preserves joining and switched rooms', () => {
  for (const scenario of ['ended', 'cleared', 'joining', 'switched', 'unknown', 'stale']) {
    let task, disposed = 0, left = 0
    const room = { isJoined: () => scenario === 'cleared' ? undefined : scenario === 'switched' }
    const api = { getIFrame: () => ({ contentWindow: { APP: {
      conference: { _room: room }, store: { getState: () => ({ 'features/base/conference': { joining: scenario === 'joining' ? {} : undefined } }) },
    } } }) }
    if (scenario === 'unknown') api.getIFrame = () => { throw new Error('unavailable') }
    const c = functions('./src/components/JitsiFrame.vue', ['handleConferenceLeft'], {
      props: { preserveOnRoomSwitch: true }, leaveRequested: false, api, closing: false,
      leaveSettlementTimer: undefined, window: { setTimeout(fn) { task = fn; return 1 }, clearTimeout() {} },
      disposeApi() { disposed++ }, emit(event) { if (event === 'left') left++ },
    })
    assert.equal(typeof c.handleConferenceLeft, 'function')
    c.handleConferenceLeft()
    if (scenario === 'stale') c.api = {}
    task?.()
    assert.equal(disposed, ['ended', 'cleared'].includes(scenario) ? 1 : 0, scenario)
    assert.equal(left, ['ended', 'cleared'].includes(scenario) ? 1 : 0, scenario)
  }
})
function functions(file, names, context) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const code = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(ast)).join('\n')
  vm.createContext(context)
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context
}
test('banner authorization uses real transport sender, not claimed owner, and rechecks role per message', () => {
  const adapter = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('./src/utils/meetingPermissions.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, adapter)
  const remote = new Map([['host', { role: 'moderator' }], ['guest', { role: 'participant' }]])
  const api = { getIFrame: () => ({ contentWindow: { APP: { store: { getState: () => ({
    'features/base/participants': { remote },
  }) } } } }) }
  const applied = []
  const c = functions('./src/components/MeetingStage.vue', ['parseMeetingBannerMessage', 'handleMeetingBannerMessage'], {
    ...adapter.exports, jitsiApi: { value: api }, MEETING_BANNER_SIGNAL: 'banner', MEETING_BANNER_REQUEST_SIGNAL: 'request',
    refreshMeetingSubject: async () => {},
    getEndpointMessage: p => p.data?.eventData?.text ?? p.eventData?.text,
    normalizeMeetingBannerState: s => s && typeof s.text === 'string' ? s : null,
    applyParticipantMeetingBannerState: (id, state) => applied.push({ id, text: state.text }),
  })
  const message = (sender, claimed = 'host') => ({ data: { senderInfo: { id: sender }, eventData: {
    participantId: 'host', senderInfo: { id: 'host' }, text: JSON.stringify({ type: 'banner', participantId: claimed, banner: { text: 'test', updatedAt: 1 } }),
  } } })
  c.handleMeetingBannerMessage(message('guest'))
  c.handleMeetingBannerMessage(message('missing'))
  const forged = message('guest'); delete forged.data.senderInfo
  c.handleMeetingBannerMessage(forged)
  assert.equal(applied.length, 0)
  c.handleMeetingBannerMessage(message('host', 'guest'))
  assert.deepEqual(applied, [{ id: 'host', text: 'test' }])
  remote.set('host', { role: 'participant' })
  c.handleMeetingBannerMessage(message('host'))
  remote.delete('host')
  c.handleMeetingBannerMessage(message('host'))
  c.jitsiApi.value = { getIFrame() { throw Error('cross origin') } }
  c.handleMeetingBannerMessage(message('host'))
  assert.equal(applied.length, 1, 'revoked, removed and unreadable senders fail closed')
})

test('local role revocation closes banner editing and global-end shell entry immediately', () => {
  const removed = []
  const c = functions('./src/components/MeetingStage.vue', ['setLocalModerator'], {
    localRole: { value: 'moderator' }, localModerator: { value: true }, hostKey: { value: 'key' },
    shellCloseMenuCanEndForAll: { value: true }, bannerPanelOpen: { value: true }, localParticipantId: { value: 'me' },
    removeParticipantMeetingBannerState: id => removed.push(id),
    hostToken: { value: 'token' }, props: { roomName: '123456789' },
    getPendingHostTransfer: () => null, clearTransferredHostKey() {},
    transferBusy: { value: true },
  })
  c.setLocalModerator(false, 'participant')
  assert.equal(c.localModerator.value, false)
  assert.equal(c.bannerPanelOpen.value, false)
  assert.equal(c.shellCloseMenuCanEndForAll.value, false)
  assert.deepEqual(removed, ['me'])
})

test('verified host demotion retires old credentials but does not erase pending replacement', () => {
  for (const pending of [null, { hostKey: 'new-key' }]) {
    const cleared = []
    let reloads = 0
    const c = functions('./src/components/MeetingStage.vue', ['setLocalModerator'], {
      localRole: { value: 'moderator' }, localModerator: { value: true }, hostKey: { value: 'old-key' },
      hostToken: { value: 'old-token' }, props: { roomName: '123456789' },
      shellCloseMenuCanEndForAll: { value: true }, bannerPanelOpen: { value: true }, localParticipantId: { value: 'me' },
      removeParticipantMeetingBannerState() {}, getPendingHostTransfer: () => pending,
      clearTransferredHostKey: (...args) => cleared.push(args),
      transferBusy: { value: false }, reloadMeetingIframe: async () => { reloads++ },
    })
    c.setLocalModerator(false, 'participant')
    assert.equal(c.hostKey.value, '')
    assert.equal(c.hostToken.value, null)
    assert.equal(cleared.length, pending ? 0 : 1)
    assert.equal(reloads, 0, 'Demotion must preserve the live media/XMPP session')
  }
})

test('remote role revocation removes previously accepted banner without altering local role', () => {
  const removed = []
  let localUpdates = 0
  const c = functions('./src/components/MeetingStage.vue', ['handleLocalRoleChanged'], {
    normalizeRoleChange: (id, role) => ({ participantId: id, role }), localParticipantId: { value: 'me' },
    removeParticipantMeetingBannerState: id => removed.push(id), setLocalModerator: () => localUpdates++,
  })
  c.handleLocalRoleChanged('host', 'participant')
  assert.deepEqual(removed, ['host'])
  assert.equal(localUpdates, 0)
})

test('stale moderator cache cannot open, save, hide or delete banners without a live moderator conference', async () => {
  for (const name of ['openBannerPanel', 'saveBannerPanel', 'hideBanner', 'deleteBannerLogoFromLibrary']) {
    let effects = 0
    const c = functions('./src/components/MeetingStage.vue', [name], {
      localModerator: { value: true }, jitsiApi: { value: {} }, hostKey: { value: 'key' },
      getJoinedModeratorConference: () => null,
      // Minimal valid drafts expose any work performed after the permission gate.
      bannerLogoSaving: { value: false }, bannerDraftText: { value: '' }, bannerDraftLogoUrl: { value: '' },
      bannerLogoFile: { value: null }, bannerDraftVisible: { value: false }, meetingBanner: { value: { text: '', updatedAt: 1 } },
      bannerDraftFontSize: { value: 30 }, bannerDraftColor: { value: '#FFFFFF' }, bannerDraftFontFamily: { value: '' },
      bannerDraftBgColor: { value: '' }, bannerLogoError: { value: '' }, bannerPanelOpen: { value: false },
      BANNER_TEXT_MAX_LENGTH: 80, BANNER_COLOR_DEFAULT: '#FFFFFF',
      customToolbar: { value: { closeFloatingMenus() { effects++ } } },
      clampBannerFontSize: v => v, normalizeBannerColor: v => v, normalizeBannerFontFamily: v => v, normalizeBannerBgColor: v => v,
      applyLocalMeetingBannerState: () => effects++, broadcastLocalMeetingBannerState: () => effects++,
      deleteBannerLogo: async () => effects++, bannerLogoLibraryList: { value: [] }, props: { roomName: '123456789' },
      setBannerLogoFile() {},
    })
    await c[name]({ url: '/cm/banner-logos/library/test.png' })
    assert.equal(effects, 0, `${name}: stale cached role must have no side effects`)
  }
})

test('banner upload completion cannot apply to a replaced or disconnected conference', async () => {
  for (const scenario of ['valid', 'replaced-api', 'replaced-room', 'lost']) {
    let effects = 0
    const api = {}, room = {}
    const c = functions('./src/components/MeetingStage.vue', ['saveBannerPanel'], {
      localModerator: { value: true }, jitsiApi: { value: api }, hostKey: { value: 'key' },
      getJoinedModeratorConference: () => c.current,
      bannerLogoSaving: { value: false }, bannerDraftText: { value: 'text' }, bannerDraftLogoUrl: { value: '' },
      bannerLogoFile: { value: {} }, bannerDraftVisible: { value: true },
      bannerDraftFontSize: { value: 30 }, bannerDraftColor: { value: '#FFFFFF' }, bannerDraftFontFamily: { value: '' },
      bannerDraftBgColor: { value: '' }, bannerLogoError: { value: '' }, bannerPanelOpen: { value: true },
      BANNER_TEXT_MAX_LENGTH: 80, BANNER_COLOR_DEFAULT: '#FFFFFF', props: { roomName: '123456789' },
      clampBannerFontSize: v => v, normalizeBannerColor: v => v, normalizeBannerFontFamily: v => v, normalizeBannerBgColor: v => v,
      applyLocalMeetingBannerState: () => effects++, broadcastLocalMeetingBannerState: () => effects++, setBannerLogoFile() {},
      uploadBannerLogo: async () => {
        if (scenario === 'replaced-api') c.jitsiApi.value = {}
        if (scenario === 'replaced-room') c.current = {}
        if (scenario === 'lost') c.current = null
        return '/cm/banner-logos/library/test.png'
      },
      saveMeetingBanner: async (_room, _key, state) => state,
      normalizeMeetingBannerState: state => state,
    })
    c.current = room
    await c.saveBannerPanel()
    assert.equal(effects, scenario === 'valid' ? 2 : 0, scenario)
  }
})

test('delete completion never clears the draft of a switched conference', async () => {
  const api = {}, room = {}, item = { url: '/cm/banner-logos/library/test.png' }
  const c = functions('./src/components/MeetingStage.vue', ['deleteBannerLogoFromLibrary'], {
    localModerator: { value: true }, hostKey: { value: 'key' }, jitsiApi: { value: api },
    getJoinedModeratorConference: () => room, props: { roomName: '123456789' },
    bannerLogoLibraryList: { value: [item] }, bannerDraftLogoUrl: { value: item.url }, bannerLogoFile: { value: null },
    deleteBannerLogo: async () => { c.jitsiApi.value = {} },
  })
  await c.deleteBannerLogoFromLibrary(item)
  assert.equal(c.bannerDraftLogoUrl.value, item.url)
  assert.equal(c.bannerLogoLibraryList.value.length, 1)
})
test('role event without local identity never grants local management', () => {
  const c = functions('./src/components/MeetingStage.vue', ['normalizeRoleChange', 'handleLocalRoleChanged'], {
    localParticipantId: { value: '' }, setLocalModerator: v => { c.moderator = v },
    getParticipantRole: () => '', jitsiApi: { value: null }, removeParticipantMeetingBannerState() {},
  })
  c.handleLocalRoleChanged({ id: 'other', role: 'moderator' })
  assert.notEqual(c.moderator, true)
})
test('late local moderator events cannot restore authority without a live conference', () => {
  for (const live of [false, true]) {
    let broadcasts = 0
    const c = functions('./src/components/MeetingStage.vue', ['handleLocalRoleChanged', 'setLocalModerator'], {
      normalizeRoleChange: (id, role) => ({ participantId: id, role }),
      localParticipantId: { value: 'me' }, jitsiApi: { value: {} },
      getJoinedModeratorConference: () => live ? {} : null,
      getParticipantRole: () => 'moderator',
      localRole: { value: '' }, localModerator: { value: false }, hostKey: { value: 'key' },
      shellCloseMenuCanEndForAll: { value: false }, bannerPanelOpen: { value: false },
      removeParticipantMeetingBannerState() {}, broadcastLocalMeetingBannerState() { broadcasts++ },
    })
    c.handleLocalRoleChanged('me', 'moderator')
    assert.equal(c.localModerator.value, live)
    assert.equal(c.shellCloseMenuCanEndForAll.value, live)
    assert.equal(c.localRole.value, live ? 'moderator' : '')
    assert.equal(broadcasts, live ? 1 : 0)
  }
})
test('delayed participant event after JWT rejoin cannot erase the current moderator credentials', () => {
  let cleared = 0, reloads = 0
  const c = functions('./src/components/MeetingStage.vue', ['handleLocalRoleChanged', 'setLocalModerator'], {
    normalizeRoleChange: (id, role) => ({ participantId: id, role }),
    localParticipantId: { value: 'me' }, jitsiApi: { value: {} },
    getJoinedModeratorConference: () => ({}), getParticipantRole: () => 'moderator',
    localRole: { value: 'moderator' }, localModerator: { value: true }, hostKey: { value: 'new-key' },
    hostToken: { value: 'new-jwt' }, props: { roomName: '123456789' },
    shellCloseMenuCanEndForAll: { value: true }, bannerPanelOpen: { value: false },
    getPendingHostTransfer: () => null, clearTransferredHostKey() { cleared++ },
    transferBusy: { value: false }, reloadMeetingIframe: async () => { reloads++ },
    removeParticipantMeetingBannerState() {}, broadcastLocalMeetingBannerState() {},
  })
  c.handleLocalRoleChanged('me', 'participant')
  assert.equal(c.hostKey.value, 'new-key')
  assert.equal(c.hostToken.value, 'new-jwt')
  assert.equal(c.localModerator.value, true)
  assert.equal(cleared, 0)
  assert.equal(reloads, 0)
})
test('JWT iframe rebuild waits for formal Jitsi leave before disposal and new connection', async () => {
  const effects = [], listeners = new Map()
  const source = {
    removeAllListeners() { effects.push('detach') },
    addListener(name, fn) { listeners.set(name, fn) },
    executeCommand(command) { effects.push(command) },
  }
  const c = functions('./src/components/JitsiFrame.vue', ['reloadWithTheme'], {
    api: source, reloadInProgress: false,
    disposeApi() { effects.push('dispose') }, init: async () => { effects.push('init') },
    window: { setTimeout() { return 1 }, clearTimeout() {} }, console,
  })
  const pending = c.reloadWithTheme()
  assert.deepEqual(effects, ['detach', 'hangup'])
  listeners.get('videoConferenceLeft')()
  await pending
  assert.deepEqual(effects, ['detach', 'hangup', 'dispose', 'init'])
})
test('page unload flushes MUC unavailable before removing the iframe', () => {
  const effects = []
  const room = { doLeave() { effects.push('unavailable-flushed') } }
  const c = functions('./src/components/JitsiFrame.vue', ['handleUnload'], {
    closing: false, api: { getIFrame: () => ({ contentWindow: { APP: { conference: { _room: { room } } } } }) },
    disposeApi() { effects.push('dispose') },
  })
  c.handleUnload({ persisted: true })
  assert.deepEqual(effects, [])
  c.handleUnload({ persisted: false })
  assert.deepEqual(effects, ['unavailable-flushed', 'dispose'])
})
test('unavailable iframe unload still disposes without claiming a confirmed leave', () => {
  let disposed = 0
  const c = functions('./src/components/JitsiFrame.vue', ['handleUnload'], {
    closing: false, api: { getIFrame() { throw new Error('cross-origin') } },
    disposeApi() { disposed++ },
  })
  c.handleUnload({ persisted: false })
  assert.equal(disposed, 1)
})
test('unconfirmed formal hangup never creates a second iframe session', async () => {
  const effects = []
  let timeout
  const c = functions('./src/components/JitsiFrame.vue', ['reloadWithTheme'], {
    api: { removeAllListeners() {}, addListener() {}, executeCommand() {} }, reloadInProgress: false,
    disposeApi() { effects.push('dispose') }, init: async () => { effects.push('init') },
    window: { setTimeout(fn) { timeout = fn; return 1 }, clearTimeout() {} },
    console: { warn() { effects.push('unconfirmed') } },
    emit(name, message) { effects.push(name); assert.match(message, /重新进入会议/) },
  })
  const pending = c.reloadWithTheme()
  timeout()
  await pending
  assert.deepEqual(effects, ['unconfirmed', 'reload-error'])
  assert.equal(c.reloadInProgress, false)
})
test('joining reconciles cached authority even when the iframe API is unavailable', () => {
  for (const available of [false, true]) {
    const calls = []
    const api = available ? {} : null
    const c = functions('./src/components/MeetingStage.vue', ['onJoined'], {
      setStatus() {}, meetingJoinedAt: 0, startElapsedTicker() {},
      localParticipantId: { value: '' }, jitsiFrame: { value: { getApi: () => api } },
      jitsiApi: { value: {} }, markRaw: value => value,
      getParticipantRole: () => 'moderator', setLocalModerator: () => calls.push('cached'),
      reconcileMeetingPermissions: () => calls.push('verified'),
      setupMeetingApiListeners() {}, androidEmbed: true, localModerator: { value: false },
      activeMeetingLayout: { value: 'default' }, applyMeetingLayout() {},
      participantCount: { value: 0 }, scheduleNativeChatStateSync() {}, largeVideoParticipantId: '',
      startMeetingBannerOverlaySync() {}, broadcastLocalMeetingBannerState() {},
      scheduleMeetingBannerStateSync() {}, reportJoined() {},
    })
    c.onJoined({ participantId: 'me' })
    assert.deepEqual(calls, ['verified'])
  }
})
test('toolbar end action cannot be called by a non-moderator', () => {
  let emitted = 0, commands = 0
  const c = functions('./src/components/CustomToolbar.vue', ['endMeetingForAll'], {
    moderator: { value: false }, endMenuOpen: { value: true }, endConferenceTimer: undefined,
    apiRef: { executeCommand() { commands++ } }, emit() { emitted++ },
    notifyRemoteParticipantsBeforeEndConference() { commands++ }, window: { setTimeout(fn) { fn(); return 1 } },
  })
  c.endMeetingForAll()
  assert.equal(commands, 0)
  assert.equal(emitted, 0)
})

for (const mode of ['web', 'desktop']) {
  test(`${mode} local leave never ends business based on cached participant count or retained host key`, async () => {
    for (const count of [0, 1, 2]) {
      const calls = []
      const c = functions('./src/components/MeetingStage.vue', ['onLeft'], {
        props: { mode }, participantCount: { value: count }, hostKey: { value: 'retained-key' },
        stopLocalRecording: async () => calls.push('stop-recording'),
        clearMeetingRuntimeState: () => calls.push('clear-runtime'),
        notifyMeetingEnded: async () => calls.push('business-end'),
        closeWindow: () => calls.push('close-window'), setStatus: status => calls.push(status),
        console: { warn() {} },
      })
      await c.onLeft()
      assert.deepEqual(calls, ['clear-runtime', 'stop-recording', mode === 'desktop' ? 'close-window' : 'left'], `cached count ${count}`)
    }
  })
}

test('terminal callbacks clear permissions before waiting for recording persistence', async () => {
  for (const name of ['onLeft', 'onKicked', 'onConferenceEnded']) {
    const calls = []
    let finish
    const recording = new Promise(resolve => { finish = resolve })
    const c = functions('./src/components/MeetingStage.vue', [name], {
      clearMeetingRuntimeState: () => calls.push('clear'),
      stopLocalRecording: () => { calls.push('recording'); return recording },
      clearCloseFallback() {}, props: { mode: 'web' },
      setStatus: status => calls.push(status), emit: event => calls.push(event),
    })
    const pending = c[name]()
    assert.deepEqual(calls, ['clear', 'recording'], name)
    finish()
    await pending
    assert.equal(calls[2], name === 'onKicked' ? 'kicked' : 'left')
  }
})

test('failed business end remains retryable and is not marked reported', async () => {
  const c = functions('./src/components/MeetingStage.vue', ['notifyMeetingEnded'], {
    endReported: false, hostKey: { value: 'key' }, props: { roomName: '123456789' },
    endMeeting: async () => { throw new Error('denied') }, console: { warn() {} },
  })
  await assert.rejects(() => c.notifyMeetingEnded(), /denied/)
  assert.equal(c.endReported, false)
})

test('business failure never dispatches room end or local hangup', async () => {
  let commands = 0
  const c = functions('./src/components/MeetingStage.vue', ['onEndForAll'], {
    endingForAll: false, endReported: false, localModerator: { value: true }, hostKey: { value: 'key' },
    jitsiApi: { value: { executeCommand() { commands++ } } }, closeShellCloseMenu() {},
    notifyMeetingEnded: async () => { throw new Error('denied') }, showStageToast: text => { c.toast = text },
    getJoinedModeratorConference: () => 'conference',
  })
  await c.onEndForAll()
  assert.equal(commands, 0)
  assert.match(c.toast, /尚未发送/)
  assert.equal(c.endingForAll, false)
})

test('command dispatch reports unconfirmed outcome instead of closing the window', async () => {
  const commands = []
  const c = functions('./src/components/MeetingStage.vue', ['onEndForAll'], {
    endingForAll: false, endReported: false, localModerator: { value: true }, hostKey: { value: 'key' },
    jitsiApi: { value: { executeCommand: command => commands.push(command) } }, closeShellCloseMenu() {},
    notifyMeetingEnded: async () => { c.endReported = true }, showStageToast: text => { c.toast = text },
    getJoinedModeratorConference: () => 'conference',
  })
  await c.onEndForAll()
  assert.deepEqual(commands, ['endConference'])
  assert.match(c.toast, /尚未确认/)
})

test('stale moderator cannot end business record without a joined conference', async () => {
  let business = 0, commands = 0
  const c = functions('./src/components/MeetingStage.vue', ['onEndForAll'], {
    endingForAll: false, endReported: false, localModerator: { value: true }, hostKey: { value: 'key' },
    jitsiApi: { value: { executeCommand() { commands++ } } }, closeShellCloseMenu() {},
    getJoinedModeratorConference: () => null,
    notifyMeetingEnded: async () => { business++ }, showStageToast: text => { c.toast = text },
  })
  await c.onEndForAll()
  assert.equal(business, 0)
  assert.equal(commands, 0)
  assert.match(c.toast, /连接|主持/)
})

test('end command failure remains unconfirmed and retry skips the already saved business end', async () => {
  let business = 0, commands = 0
  const room = {}
  const c = functions('./src/components/MeetingStage.vue', ['notifyMeetingEnded', 'onEndForAll'], {
    endingForAll: false, endReported: false, localModerator: { value: true }, hostKey: { value: 'key' },
    props: { roomName: '123456789' }, endMeeting: async () => { business++ },
    jitsiApi: { value: { executeCommand(command) {
      assert.equal(command, 'endConference')
      if (++commands === 1) throw new Error('dispatch failed')
    } } },
    closeShellCloseMenu() {}, getJoinedModeratorConference: () => room,
    showStageToast: text => { c.toast = text },
  })
  await c.onEndForAll()
  assert.match(c.toast, /记录已结束.*未确认/)
  assert.equal(c.endingForAll, false)
  await c.onEndForAll()
  assert.equal(business, 1)
  assert.equal(commands, 2)
  assert.match(c.toast, /尚未确认全员退出/)
})

test('duplicate end clicks while business request is pending dispatch only one command', async () => {
  let finish, business = 0, commands = 0
  const room = {}
  const c = functions('./src/components/MeetingStage.vue', ['notifyMeetingEnded', 'onEndForAll'], {
    endingForAll: false, endReported: false, localModerator: { value: true }, hostKey: { value: 'key' },
    props: { roomName: '123456789' }, endMeeting: () => { business++; return new Promise(resolve => { finish = resolve }) },
    jitsiApi: { value: { executeCommand() { commands++ } } }, closeShellCloseMenu() {},
    getJoinedModeratorConference: () => room, showStageToast() {},
  })
  const pending = c.onEndForAll()
  await c.onEndForAll()
  assert.equal(business, 1)
  assert.equal(commands, 0)
  finish()
  await pending
  assert.equal(commands, 1)
  assert.equal(c.endingForAll, false)
})

test('API replacement or local role loss during business end never dispatches to either session', async () => {
  for (const scenario of ['api', 'role']) {
    let commands = 0
    const room = {}, api = { executeCommand() { commands++ } }
    const c = functions('./src/components/MeetingStage.vue', ['onEndForAll'], {
      endingForAll: false, endReported: false, localModerator: { value: true }, hostKey: { value: 'key' },
      jitsiApi: { value: api }, closeShellCloseMenu() {}, getJoinedModeratorConference: () => room,
      notifyMeetingEnded: async () => {
        c.endReported = true
        if (scenario === 'api') c.jitsiApi.value = { executeCommand() { commands++ } }
        else c.localModerator.value = false
      }, showStageToast: text => { c.toast = text },
    })
    await c.onEndForAll()
    assert.equal(commands, 0, scenario)
    assert.match(c.toast, /未确认/)
    assert.equal(c.endingForAll, false)
  }
})

test('conference replaced or lost during business end never receives end command', async () => {
  for (const next of [null, {}]) {
    let current = {}, commands = 0
    const c = functions('./src/components/MeetingStage.vue', ['onEndForAll'], {
      endingForAll: false, endReported: false, localModerator: { value: true }, hostKey: { value: 'key' },
      jitsiApi: { value: { executeCommand() { commands++ } } }, closeShellCloseMenu() {},
      getJoinedModeratorConference: () => current,
      notifyMeetingEnded: async () => { c.endReported = true; current = next }, showStageToast: text => { c.toast = text },
    })
    await c.onEndForAll()
    assert.equal(commands, 0)
    assert.match(c.toast, /未确认/)
    assert.equal(c.endingForAll, false)
  }
})

test('joined moderator adapter rejects unknown, transition, disconnected and stale conference state', () => {
  const source = readFileSync(new URL('./src/utils/meetingPermissions.ts', import.meta.url), 'utf8')
  const c = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, c)
  assert.equal(typeof c.exports.getJoinedModeratorConference, 'function')
  const check = c.exports.getJoinedModeratorConference
  for (const scenario of ['valid', 'missing', 'joining', 'leaving', 'disconnected', 'stale', 'participant', 'unknown', 'signal-lost', 'signal-unknown']) {
    const room = { isJoined: () => scenario === 'unknown' ? undefined : scenario !== 'disconnected',
      getConnection: () => ({ xmpp: { connection: { connected: scenario === 'signal-unknown' ? undefined : scenario !== 'signal-lost' } } }) }
    const state = {
      'features/base/conference': { conference: scenario === 'missing' ? undefined : scenario === 'stale' ? {} : room,
        joining: scenario === 'joining' ? {} : undefined, leaving: scenario === 'leaving' ? {} : undefined },
      'features/base/participants': { local: { role: scenario === 'participant' ? 'participant' : 'moderator' } },
    }
    const api = { getIFrame: () => ({ contentWindow: { APP: { store: { getState: () => state }, conference: { _room: room } } } }) }
    assert.equal(check(api), scenario === 'valid' ? room : null, scenario)
  }
  assert.equal(check(null), null)
  assert.equal(check({ getIFrame() { throw Error('cross-origin') } }), null)
})

test('permission adapter reads only real iframe role and transport sender', () => {
  const source = readFileSync(new URL('./src/utils/meetingPermissions.ts', import.meta.url), 'utf8')
  const c = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, c)
  const { getParticipantRole, getEndpointSenderParticipantId } = c.exports
  const api = { getIFrame: () => ({ contentWindow: { APP: { store: { getState: () => ({
    'features/base/participants': { local: { id: 'me', role: 'participant' }, remote: new Map([['host', { role: 'moderator' }]]) },
  }) } } } }) }
  assert.equal(getParticipantRole(api, 'host'), 'moderator')
  assert.equal(getParticipantRole(api, 'me'), 'participant')
  assert.equal(getParticipantRole(api, 'missing'), '')
  assert.equal(getParticipantRole({ getIFrame() { throw new Error('cross origin') } }, 'host'), '')
  assert.equal(getEndpointSenderParticipantId({ eventData: { senderInfo: { id: 'host' } } }), '')
  assert.equal(getEndpointSenderParticipantId({ data: { senderInfo: { id: 'guest' }, eventData: { participantId: 'host' } } }), 'guest')
})

test('role label distinguishes verified participant, pending role and denied host intent', () => {
  const source = readFileSync(new URL('./src/utils/meetingPermissions.ts', import.meta.url), 'utf8')
  const c = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, c)
  assert.equal(typeof c.exports.getMeetingRoleLabel, 'function')
  const label = c.exports.getMeetingRoleLabel
  assert.equal(label('', false), '角色验证中')
  assert.equal(label('moderator', true), '主持人')
  assert.equal(label('participant', false), '普通参会者')
  assert.equal(label('none', true), '普通参会者（未获得主持权限）')
  assert.equal(label('unknown-new-role', true), '角色验证中')
})

test('toolbar follows verified parent role without reporting its default false as a role event', () => {
  const source = readFileSync(new URL('./src/components/MeetingStage.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /@moderator-change="setLocalModerator"/)
  assert.match(source, /role="status"[^>]*aria-live="polite"[^>]*>\s*\{\{ meetingRoleLabel \}\}/)
})

test('Jitsi config disables native moderator grants without removing mute and kick', () => {
  const c = functions('./src/components/JitsiFrame.vue', ['buildJitsiConfigOverwrite'], {
    PREJOIN_ENABLED: false, disabledDeviceNotifications: [], props: { theme: 'dark' },
    buildJitsiCustomTheme: () => ({}), isAndroidEmbed: () => false,
    HOST_TRANSFER_MENU_ID: 'cloudmeet-transfer-host',
    btoa: value => Buffer.from(value).toString('base64'),
  })
  const config = c.buildJitsiConfigOverwrite()
  assert.equal(config.remoteVideoMenu?.disableGrantModerator, true)
  assert.notEqual(config.remoteVideoMenu?.disableKick, true)
  assert.equal(config.disableRemoteMute, false)
  assert.equal(config.enableUserRolesBasedOnToken, false)
  assert.equal(config.customParticipantMenuButtons?.[0]?.id, 'cloudmeet-transfer-host',
    'Register the action before promotion; live authorization is checked at click time')
})

test('verified host iframe exposes transfer action in the participant menu', () => {
  const c = functions('./src/components/JitsiFrame.vue', ['buildJitsiConfigOverwrite'], {
    PREJOIN_ENABLED: false, disabledDeviceNotifications: [], props: { theme: 'dark', jwt: 'verified-token' },
    buildJitsiCustomTheme: () => ({}), isAndroidEmbed: () => false,
    HOST_TRANSFER_MENU_ID: 'cloudmeet-transfer-host',
    btoa: value => Buffer.from(value).toString('base64'),
  })
  const config = c.buildJitsiConfigOverwrite()
  assert.equal(config.customParticipantMenuButtons?.[0]?.id, 'cloudmeet-transfer-host')
  assert.equal(config.customParticipantMenuButtons?.[0]?.text, '设为主持人')
  assert.equal(config.remoteVideoMenu.disableGrantModerator, true)
})
