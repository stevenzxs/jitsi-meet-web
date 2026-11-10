import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'

const filename = new URL('../src/components/MeetingStage.vue', import.meta.url)
const { descriptor, errors } = parse(readFileSync(filename, 'utf8'))
assert.deepEqual(errors, [])
const rules = []
for (const style of descriptor.styles) {
  const compiled = compileStyle({ source: style.content, filename: filename.pathname,
    id: 'data-v-polling-test', scoped: style.scoped })
  assert.deepEqual(compiled.errors, [])
  compiled.rawResult.root.walkRules(rule => rules.push(rule))
}

function declaration(selector, property) {
  let value
  for (const rule of rules) {
    if (!rule.selectors.some(item => item.replace(/\[data-v-polling-test\]/g, '') === selector)) continue
    rule.walkDecls(property, decl => { value = decl.value })
  }
  return value
}

test('fullscreen polling covers the bottom area even while the floating toolbar is hidden', () => {
  assert.equal(declaration('.meeting-stage--fullscreen .meeting-stage__polling', 'bottom'), '0')
})

test('windowed polling still reserves toolbar space and fullscreen toolbar stays above polling', () => {
  assert.equal(declaration('.meeting-stage__polling', 'bottom'), 'var(--custom-toolbar-height)')
  assert.ok(Number(declaration('.meeting-stage--fullscreen .meeting-stage__toolbar-slot', 'z-index'))
    > Number(declaration('.meeting-stage__polling', 'z-index')))
})
