import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('WebView 83 own-property fallback handles null prototypes and shadowed methods', async () => {
  const source = await readFile(new URL('../src/webview-compat.js', import.meta.url), 'utf8')
  const context = vm.createContext({})
  vm.runInContext('delete Object.hasOwn', context)
  vm.runInContext(source, context)
  assert.equal(vm.runInContext(`(() => {
    const value = Object.create(null); value.key = undefined; value.hasOwnProperty = false;
    return Object.hasOwn(value, 'key') && !Object.hasOwn(value, 'missing')
      && !Object.hasOwn({}, 'toString') && Object.hasOwn('abc', 0);
  })()`, context), true)
  assert.throws(() => vm.runInContext('Object.hasOwn(null, "x")', context), /null|undefined/)
})

test('modern native Object.hasOwn is preserved', async () => {
  const source = await readFile(new URL('../src/webview-compat.js', import.meta.url), 'utf8')
  const context = vm.createContext({})
  vm.runInContext('globalThis.original = Object.hasOwn', context)
  vm.runInContext(source, context)
  assert.equal(vm.runInContext('original === Object.hasOwn', context), true)
})
