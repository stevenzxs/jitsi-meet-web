import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/components/MeetingStage.vue', import.meta.url), 'utf8')

// Execute the actual layout helpers without mounting the meeting or joining a room.
function loadHelpers(fullscreen) {
  const names = ['getStrictGridMetrics', 'readAppliedStrictGridDims', 'strictGridDimsAlreadyApplied']
  const functions = names.map(name => {
    const start = source.indexOf(`function ${name}(`)
    assert.notEqual(start, -1)
    return source.slice(start, source.indexOf('\n}', start) + 2)
  }).join('\n')
  const { outputText } = ts.transpileModule(functions, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  return runInNewContext(`${outputText}\n({ getStrictGridMetrics, strictGridDimsAlreadyApplied })`, {
    fullscreen: { value: fullscreen },
    STRICT_GRID_OUTER_MARGIN: 14,
    STRICT_GRID_TILE_MARGIN: 4,
    STRICT_GRID_SCROLL_SIZE: 7,
    STRICT_GRID_ASPECT_RATIO: 16 / 9,
    getRecord: value => value && typeof value === 'object' ? value : undefined,
  })
}

function storeWith(metrics) {
  return { getState: () => ({ 'features/filmstrip': { tileViewDimensions: {
    gridDimensions: { columns: metrics.columns, rows: metrics.rows },
    thumbnailSize: { width: metrics.width, height: metrics.height },
    filmstripWidth: metrics.filmstripWidth,
    filmstripHeight: metrics.filmstripHeight,
    hasScroll: metrics.hasScroll,
  } } }) }
}

for (const fullscreen of [true, false]) {
  test(`three participants: 4/2 split transitions must update dimensions (fullscreen=${fullscreen})`, () => {
    const helpers = loadHelpers(fullscreen)
    const metrics = count => helpers.getStrictGridMetrics(count, 3, 1920, 1080, true, fullscreen ? 0 : 14)
    const four = metrics(4)
    const two = metrics(2)
    assert.equal(two.rowsPerPage, 1)
    assert.ok(two.filmstripHeight < four.filmstripHeight)
    assert.equal(helpers.strictGridDimsAlreadyApplied(storeWith(four), two), false)
    assert.equal(helpers.strictGridDimsAlreadyApplied(storeWith(two), four), false)
    assert.equal(helpers.strictGridDimsAlreadyApplied(storeWith(two), two), true)
  })
}

for (const field of ['filmstripWidth', 'filmstripHeight', 'hasScroll']) {
  test(`a change in ${field} must not be skipped`, () => {
    const helpers = loadHelpers(true)
    const metrics = helpers.getStrictGridMetrics(2, 3, 1920, 1080, true, 0)
    const changed = { ...metrics, [field]: field === 'hasScroll' ? !metrics[field] : metrics[field] + 7 }
    assert.equal(helpers.strictGridDimsAlreadyApplied(storeWith(metrics), changed), false)
  })
}
