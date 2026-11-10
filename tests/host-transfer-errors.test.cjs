const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

const source = fs.readFileSync('src/utils/hostTransferClient.ts', 'utf8')
const tree = ts.createSourceFile('transfer.ts', source, ts.ScriptTarget.Latest, true)
function request(error) {
  const context = { makeIq: () => ({}), error, connection: { jid: 'test', sendIQ: (_, ok, fail) => fail(error) } }
  const functions = tree.statements.filter(n => ts.isFunctionDeclaration(n)
    && ['iqRequest', 'hostTransferRequestError'].includes(n.name.text))
  vm.runInNewContext(ts.transpile(functions.map(n => n.getText(tree)).join('\n')), context)
  return context.iqRequest(context.connection, {}, 'room', 'transfer', {})
}
function stanza(condition, namespace = 'urn:ietf:params:xml:ns:xmpp-stanzas') {
  return { children: [{ localName: 'error', children: [{ localName: condition, namespaceURI: namespace }] }],
    textContent: 'PRIVATE_HOST_KEY_AND_JWT', outerHTML: 'PRIVATE_HOST_KEY_AND_JWT' }
}
for (const [condition, expected] of [
  ['service-unavailable', /未启用主持人转让/], ['not-allowed', /无权/],
  ['conflict', /状态冲突/], ['remote-server-timeout', /内部服务/],
  ['resource-constraint', /繁忙/],
]) test(`transfer ${condition} has safe actionable feedback`, async () => {
  await assert.rejects(request(stanza(condition)), error => expected.test(error.message)
    && !error.message.includes('PRIVATE_'))
})
test('null IQ failure is an uncertain timeout, not permission denial', async () => {
  await assert.rejects(request(null), /超时.*尚未确认/)
})
test('untrusted condition namespace and unknown errors never echo stanza contents', async () => {
  await assert.rejects(request(stanza('service-unavailable', 'untrusted')), error =>
    /请求失败/.test(error.message) && !error.message.includes('PRIVATE_'))
})
