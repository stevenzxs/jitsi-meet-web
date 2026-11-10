import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { parse } from 'acorn'

// Chromium 83 supports ES2020 but not logical assignment (||=, &&=, ??=).
// Check the emitted dependencies too: source-only checks miss minifier output.
const assets = new URL('../dist/assets/', import.meta.url)
const files = (await readdir(assets)).filter(file => file.endsWith('.js'))
assert(files.length > 0, 'build assets missing; run npm run build first')
for (const file of files) {
  const source = await readFile(new URL(file, assets), 'utf8')
  try {
    parse(source, { ecmaVersion: 2020, sourceType: 'module' })
  } catch (error) {
    throw new Error(`${file} is not WebView 83 syntax compatible: ${error.message}`)
  }
}
console.log(`WebView 83 syntax: ${files.length} emitted JS assets passed (not a runtime acceptance)`)
