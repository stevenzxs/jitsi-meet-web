// Task 3 (web): pure directed-recording source selection + microphone isolation.
// Run: node scripts/test-recording-sources.cjs
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = readFileSync(path.join(__dirname, '../src/utils/recordingSources.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText
const moduleExports = {}
vm.runInNewContext(code, { exports: moduleExports, console })

const {
  getModeratorParticipantId,
  selectRecordingSource,
  normalizeRecordingMode,
} = moduleExports
for (const name of ['getModeratorParticipantId', 'selectRecordingSource', 'normalizeRecordingMode']) {
  assert.equal(typeof moduleExports[name], 'function', `${name} must be exported`)
}
assert.equal(normalizeRecordingMode('composite'), 'composite')

// --- fixtures ---
const track = (over = {}) => ({
  participantId: 'p1', local: false, mediaType: 'video', videoType: 'camera',
  muted: false, jitsiTrack: { getId: () => 't1', getType: () => 'video', getVideoType: () => 'camera', isMuted: () => false },
  ...over,
})
const mic = (participantId, over = {}) => track({
  participantId, mediaType: 'audio', videoType: null,
  jitsiTrack: { getId: () => `${participantId}-mic`, getType: () => 'audio', getVideoType: () => null, isMuted: () => false },
  ...over,
})
const camera = (participantId, over = {}) => track({
  participantId, mediaType: 'video', videoType: 'camera',
  jitsiTrack: { getId: () => `${participantId}-cam`, getType: () => 'video', getVideoType: () => 'camera', isMuted: () => false },
  ...over,
})
const desktop = (participantId, over = {}) => track({
  participantId, mediaType: 'screenshare', videoType: 'desktop',
  jitsiTrack: { getId: () => `${participantId}-desk`, getType: () => 'video', getVideoType: () => 'desktop', isMuted: () => false },
  ...over,
})
const desktopAudio = (participantId, over = {}) => track({
  participantId, mediaType: 'audio', videoType: 'desktop',
  jitsiTrack: { getId: () => `${participantId}-desk-audio`, getType: () => 'audio', getVideoType: () => 'desktop', isMuted: () => false },
  ...over,
})
const state = (local, remotes, tracks) => ({
  participants: { local, remote: remotes },
  tracks,
})

{
  const snapshot = state({ id: 'host', role: 'moderator' }, [{ id: 'sharer', role: 'participant' }], [
    camera('local', { local: true }), mic('local', { local: true }), desktop('sharer'), mic('sharer'), desktopAudio('sharer'),
  ])
  const selected = selectRecordingSource(snapshot, 'composite')
  assert.equal(selected.mode, 'composite')
  assert.equal(selected.video.track.videoType, 'desktop')
  assert.equal(selected.overlay.track.videoType, 'camera')
  assert.equal(selected.microphones.length, 2)
  assert.ok(selected.microphones.every(m => m.track.videoType !== 'desktop'))
  const ownShare = selectRecordingSource(state({ id: 'host', role: 'moderator' }, [], [
    camera('local', { local: true }), mic('local', { local: true }), desktop('local', { local: true }),
  ]), 'composite')
  assert.equal(ownShare.microphones.length, 1, 'host sharing uses a single microphone')
  assert.equal(selectRecordingSource(state({ id: 'host', role: 'moderator' }, [], []), 'composite').reason, 'no-active-share')
}

{
  const selected = selectRecordingSource(state({ id: 'me', role: 'moderator' }, [], [
    desktop('local', { local: true }), mic('local', { local: true }), desktopAudio('local', { local: true }),
  ]), 'shared-screen')
  assert.equal(selected.reason, '', 'Own shared screen must be recordable')
  assert.equal(selected.targetId, 'me')
  assert.equal(selected.microphone.track.videoType, null, 'Exclude own desktop audio')
}

// local entries carry participantId 'local' and must match by the local flag
const localTrack = (over = {}) => track({ participantId: 'local', local: true, ...over })
const localMic = (over = {}) => localTrack({
  mediaType: 'audio', videoType: null,
  jitsiTrack: { getId: () => 'local-mic', getType: () => 'audio', getVideoType: () => null, isMuted: () => false },
  ...over,
})
const localCamera = (over = {}) => localTrack({
  mediaType: 'video', videoType: 'camera',
  jitsiTrack: { getId: () => 'local-cam', getType: () => 'video', getVideoType: () => 'camera', isMuted: () => false },
  ...over,
})

// --- mode normalization ---
assert.equal(normalizeRecordingMode('shared-screen'), 'shared-screen')
assert.equal(normalizeRecordingMode('host-camera'), 'host-camera')
for (const junk of [undefined, null, '', 'x']) assert.equal(normalizeRecordingMode(junk), 'host-camera')

// --- host selection ---
{
  const s = state({ id: 'me', role: 'moderator' }, [], [localMic(), localCamera()])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.targetId, 'me')
  assert.equal(sel.video.present, true)
  assert.equal(sel.microphone.present, true)
  assert.equal(sel.microphone.muted, false)
  assert.equal(sel.reason, '')
  assert.equal(getModeratorParticipantId(s.participants), 'me')
}
{
  // 本地不是主持人 → 取远端第一个 moderator
  const s = state({ id: 'me', role: 'participant' },
    [{ id: 'host1', role: 'participant' }, { id: 'host2', role: 'moderator' }],
    [mic('host2'), camera('host2'), mic('host1'), camera('host1')])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.targetId, 'host2')
  assert.equal(sel.microphone.track.jitsiTrack.getId(), 'host2-mic', 'mic must belong to the chosen host')
}
{
  // 角色转移后：旧主持变 participant，新主持为 moderator → 目标切换
  const s = state({ id: 'me', role: 'participant' },
    [{ id: 'old-host', role: 'participant' }, { id: 'new-host', role: 'moderator' }],
    [mic('new-host'), camera('new-host'), mic('old-host'), camera('old-host')])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.targetId, 'new-host', 'after transfer the moderator must become the target')
}
{
  const s = state({ id: 'me', role: 'participant' }, [{ id: 'a', role: 'participant' }], [mic('a')])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.targetId, '')
  assert.equal(sel.reason, 'no-host')
}

// --- mute / camera-off flags ---
{
  const mutedMic = mic('host', { muted: true, jitsiTrack: { getId: () => 'host-mic', getType: () => 'audio', getVideoType: () => null, isMuted: () => true } })
  const s = state({ id: 'me', role: 'participant' }, [{ id: 'host', role: 'moderator' }], [mutedMic, camera('host')])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.microphone.muted, true, 'muted mic must surface the conference mute state')
  assert.equal(sel.microphone.present, true)
}
{
  const offCam = camera('host', { muted: true, jitsiTrack: { getId: () => 'host-cam', getType: () => 'video', getVideoType: () => 'camera', isMuted: () => true } })
  const s = state({ id: 'me', role: 'participant' }, [{ id: 'host', role: 'moderator' }], [mic('host'), offCam])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.video.muted, true, 'camera-off must surface as muted video (black screen contract)')
}

// --- shared screen mode ---
{
  const s = state({ id: 'me', role: 'participant' },
    [{ id: 'sharer', role: 'participant' }],
    [desktop('sharer'), mic('sharer')])
  const sel = selectRecordingSource(s, 'shared-screen')
  assert.equal(sel.targetId, 'sharer')
  assert.equal(sel.share.active, true)
  assert.equal(sel.share.ended, false)
  assert.equal(sel.share.identity, 'sharer:sharer-desk')
  assert.equal(sel.microphone.track.jitsiTrack.getId(), 'sharer-mic', 'shared mode mic = sharer microphone')
  assert.equal(sel.reason, '')
}
{
  // 共享电脑声音必须排除：sharer 同时有 desktop audio 与 mic
  const s = state({ id: 'me', role: 'participant' },
    [{ id: 'sharer', role: 'participant' }],
    [desktop('sharer'), desktopAudio('sharer'), mic('sharer')])
  const sel = selectRecordingSource(s, 'shared-screen')
  assert.equal(sel.microphone.track.jitsiTrack.getId(), 'sharer-mic')
  assert.notEqual(sel.microphone.track.videoType, 'desktop', 'desktop audio must never be selected')
}
{
  // sharer 只有桌面音频、无麦克风 → 无声（静音），绝不降级到桌面音频
  const s = state({ id: 'me', role: 'participant' },
    [{ id: 'sharer', role: 'participant' }],
    [desktop('sharer'), desktopAudio('sharer')])
  const sel = selectRecordingSource(s, 'shared-screen')
  assert.equal(sel.microphone.present, false, 'no microphone → silence, not desktop audio')
  assert.equal(sel.microphone.track, null)
}
{
  // 共享停止：desktop 条目驻留但 muted:true → active=false（不静默接续下一次）
  const stopped = desktop('sharer', { muted: true, jitsiTrack: { getId: () => 'sharer-desk', getType: () => 'video', getVideoType: () => 'desktop', isMuted: () => true } })
  const s = state({ id: 'me', role: 'participant' }, [{ id: 'sharer', role: 'participant' }], [stopped, mic('sharer')])
  const sel = selectRecordingSource(s, 'shared-screen')
  assert.equal(sel.share.active, false, 'muted lingering desktop track means share stopped')
  assert.equal(sel.share.identity, 'sharer:sharer-desk')
  assert.equal(sel.reason, 'no-active-share')
}
{
  // 换人接替：旧共享 muted 驻留 + 新共享 active → 绑定新共享身份（不接续）
  const oldStopped = desktop('sharer-a', { muted: true, jitsiTrack: { getId: () => 'desk-a', getType: () => 'video', getVideoType: () => 'desktop', isMuted: () => true } })
  const s = state({ id: 'me', role: 'participant' },
    [{ id: 'sharer-a', role: 'participant' }, { id: 'sharer-b', role: 'participant' }],
    [oldStopped, desktop('sharer-b'), mic('sharer-b')])
  const sel = selectRecordingSource(s, 'shared-screen')
  assert.equal(sel.targetId, 'sharer-b')
  assert.equal(sel.share.active, true)
  assert.equal(sel.share.identity, 'sharer-b:sharer-b-desk', 'replacement must bind the new share identity')
  assert.equal(sel.microphone.track.jitsiTrack.getId(), 'sharer-b-mic')
}
{
  // 多活跃共享 → 拒绝随机选择
  const s = state({ id: 'me', role: 'participant' },
    [{ id: 'a', role: 'participant' }, { id: 'b', role: 'participant' }],
    [desktop('a'), desktop('b'), mic('a'), mic('b')])
  const sel = selectRecordingSource(s, 'shared-screen')
  assert.equal(sel.reason, 'ambiguous-share')
  assert.equal(sel.share.active, false)
}

// --- ambiguity / safety ---
{
  // 同一目标两条麦克风候选 → 拒绝（混合音频风险）
  const s = state({ id: 'me', role: 'participant' }, [{ id: 'host', role: 'moderator' }],
    [mic('host'), mic('host', { jitsiTrack: { getId: () => 'host-mic-2', getType: () => 'audio', getVideoType: () => null, isMuted: () => false } }), camera('host')])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.reason, 'ambiguous-mic')
  assert.equal(sel.microphone.present, false)
}
{
  // 轨道 ended → 视为缺席（不绘制不过期轨道）
  const endedCam = camera('host', { jitsiTrack: { getId: () => 'host-cam', getType: () => 'video', getVideoType: () => 'camera', isMuted: () => false, getTrack: () => ({ readyState: 'ended' }) } })
  const s = state({ id: 'me', role: 'participant' }, [{ id: 'host', role: 'moderator' }], [mic('host'), endedCam])
  const sel = selectRecordingSource(s, 'host-camera')
  assert.equal(sel.video.present, false, 'ended camera track counts as absent')
  assert.equal(sel.video.muted, true)
}

console.log('PASS web recording sources (pure selection + microphone isolation)')
