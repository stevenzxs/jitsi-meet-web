import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/components/MeetingStage.vue', import.meta.url), 'utf8')

test('meeting role remains a live announcement without visible layout space', () => {
  assert.match(source, /class="meeting-role" role="status" aria-live="polite"/)
  const styles = source.match(/\.meeting-role\s*\{([^}]+)\}/)?.[1] || ''
  for (const declaration of [
    'position: absolute',
    'width: 1px',
    'height: 1px',
    'padding: 0',
    'overflow: hidden',
    'clip-path: inset(50%)',
    'white-space: nowrap',
  ]) {
    assert.ok(styles.includes(declaration), `Missing visually hidden rule: ${declaration}`)
  }
  assert.doesNotMatch(styles, /display:\s*none|visibility:\s*hidden/)
})
