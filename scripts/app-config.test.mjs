import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/config/appConfig.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source.replaceAll('import.meta.env', '({})'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { resolveJitsiServerUrl } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('same-origin mode follows configured deployment domain without a rebuild', () => {
  assert.equal(resolveJitsiServerUrl('same-origin', 'https://jks.zxs888.cn'), 'https://jks.zxs888.cn')
  assert.equal(resolveJitsiServerUrl('same-origin', 'https://next.example.com'), 'https://next.example.com')
})
test('explicit external deployment URLs remain supported', () => {
  assert.equal(resolveJitsiServerUrl('https://meet.example.com/', 'https://app.example.com'), 'https://meet.example.com')
})
