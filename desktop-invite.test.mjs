import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

test('invitation dialog inherits meeting theme without teleporting outside its scope', () => {
  const source = fs.readFileSync('src/components/DesktopInviteDialog.vue', 'utf8')
  assert.doesNotMatch(source, /<Teleport/)
  assert.match(source, /showModal\(\)/)
  for (const token of ['--panel-solid', '--bg-2', '--text-hi', '--text-mid', '--line', '--overlay-bg', '--shadow-card']) {
    assert.ok(source.includes(`var(${token})`), `dialog must use theme token ${token}`)
  }
  assert.doesNotMatch(source, /#202733|#141b26|#f5f7fa|#c6d0df|#ffffff1[4a]/)
})

test('desktop toolbar opens preview instead of automatically copying', () => {
  const source = fs.readFileSync('src/components/MeetingStage.vue', 'utf8')
  assert.match(source, /desktopInviteOpen.value = true/)
  assert.match(source, /<DesktopInviteDialog/)
  assert.doesNotMatch(source, /void copyDesktopInvite\(\)/)
})

test('dialog previews and copies the exact same invitation with explicit footer action', () => {
  const source = fs.readFileSync('src/components/DesktopInviteDialog.vue', 'utf8')
  assert.match(source, /\{\{ inviteText \}\}/)
  assert.match(source, /copyInvitationText\(inviteText.value\)/)
  assert.match(source, /复制全部信息/)
  assert.match(source, /showModal\(\)/)
  assert.match(source, /@cancel.prevent/)
  assert.doesNotMatch(source, /hostKey|v-html/)
})

test('clipboard fallback succeeds only when legacy copy really succeeds', async () => {
  const source = fs.readFileSync('src/utils/invitationClipboard.ts', 'utf8')
  const js = ts.transpile(source, { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 })
  const { copyInvitationText } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  let copied = '', removed = 0
  const element = { value: '', style: {}, setAttribute() {}, select() {}, remove() { removed++ } }
  const document = { createElement: () => element, body: { appendChild() {} }, execCommand: () => true }
  await copyInvitationText('all\n邀请', { clipboard: { writeText: async text => { copied = text } }, document })
  assert.equal(copied, 'all\n邀请')
  const clipboard = { writeText: async () => { throw Error('denied') } }
  await copyInvitationText('fallback', { clipboard, document })
  assert.equal(element.value, 'fallback')
  assert.equal(removed, 1)
  document.execCommand = () => false
  await assert.rejects(copyInvitationText('failure', { clipboard, document }))
  assert.equal(removed, 2)
})
