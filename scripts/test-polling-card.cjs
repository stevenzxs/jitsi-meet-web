const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const context = vm.createContext({ exports: {} })
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/utils/pollingLayout.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context)
const avatar = context.exports.getTileAvatar
assert.equal(typeof avatar, 'function', 'Polling must use the grid avatar rules')
for (const [name, initials] of [['张三', '张'], ['Alice Smith', 'AS'], ['alice@example.com', 'A'], ['Alice Smith (我)', 'AS'], ['😀', '😀'], ['', '']]) {
  assert.equal(avatar(name, 'member').initials, initials)
}
assert.equal(avatar('甲', 'same-id').color, avatar('乙', 'same-id').color, 'Rename must not change participant color')
const info = context.exports.getPollingParticipantInfo
const state = {
  'features/base/participants': { local: { id: 'host', name: '主持人', role: 'moderator' }, remote: new Map() },
  'features/base/tracks': [], 'features/base/config': { disableModeratorIndicator: true },
}
const api = { getIFrame: () => ({ contentWindow: { APP: { store: { getState: () => state } } } }) }
assert.equal(info(api, 'host').showModerator, false)
state['features/base/config'].disableModeratorIndicator = false
assert.equal(info(api, 'host').showModerator, true)
const component = fs.readFileSync(path.join(__dirname, '../src/components/PollingParticipantInfo.vue'), 'utf8')
assert.ok(component.includes(':style="nameStyle"'), 'Only the participant name must receive native typography')
for (const property of ['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing']) {
  assert.ok(component.includes(`${property}: nativeTypography.${property}`), `Match grid name ${property}`)
}
assert.match(component, /\.polling-card-name\s*\{[^}]*font-weight:\s*700/, 'Name must remain bold when native card is unavailable')
assert.ok(component.includes('v-if="!hasVideo"'), 'Camera off must show avatar')
assert.ok(component.includes('v-if="info.audioMuted === true"'), 'Only muted audio gets an icon, like grid')
assert.ok(component.includes('info.showModerator'), 'Respect native moderator indicator configuration')
assert.ok(!component.includes('getContainedVideoInsets'), 'Use grid card anchor, not a separate video-bounds anchor')
const stage = fs.readFileSync(path.join(__dirname, '../src/components/MeetingStage.vue'), 'utf8')
assert.ok(stage.includes('@dblclick="openParticipantMainView(pollingHostId)"'))
assert.ok(stage.includes('@dblclick="openParticipantMainView(pollingRightParticipantId)"'))
assert.ok(stage.includes('openParticipantMainView(participantId)'), 'Grid and polling must share the main-view action')
console.log('PASS independent polling card: grid avatar, stable color, native status rules, card anchors and shared double-click')
