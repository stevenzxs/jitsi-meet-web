import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const file = new URL('./src/config/appConfig.ts', import.meta.url)
const source = readFileSync(file, 'utf8')
const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const selected = ast.statements
  .filter(node => ts.isFunctionDeclaration(node)
    && ['trimTrailingSlash', 'resolveJitsiServerUrl'].includes(node.name?.text))
  .map(node => node.getText(ast))
  .join('\n')
const code = ts.transpileModule(selected, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const context = { exports: {} }
vm.runInNewContext(code, context)
const { resolveJitsiServerUrl } = context.exports

test('public and internal entries load Jitsi from their own browser origin', () => {
  const configured = 'https://118.193.36.35:8443/'
  assert.equal(resolveJitsiServerUrl(configured, 'https://104.244.90.25:8443'), 'https://104.244.90.25:8443')
  assert.equal(resolveJitsiServerUrl(configured, 'https://192.168.199.202'), 'https://192.168.199.202')
  assert.equal(resolveJitsiServerUrl(configured, 'https://118.193.36.35:8443'), 'https://118.193.36.35:8443')
})

test('development and explicitly configured external Jitsi hosts keep their configured URL', () => {
  assert.equal(resolveJitsiServerUrl('https://104.244.90.25:8443', 'http://localhost:5173'), 'https://104.244.90.25:8443')
  assert.equal(resolveJitsiServerUrl('https://jitsi.example.com/', 'https://app.example.com'), 'https://jitsi.example.com')
})
