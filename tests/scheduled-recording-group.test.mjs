import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function harness(options = {}) {
  const exports = {}
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/utils/scheduledRecordingGroup.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports })
  const keys = { 'host-camera': 'host', 'shared-screen': null, composite: null }
  const jobs = [], errors = [], states = []
  let listener, removed = false
  const group = exports.createRecordingGroup({
    readyKey: mode => keys[mode],
    subscribe(fn) { listener = fn; return () => { removed = true } },
    onChanged: state => states.push(state), onError: error => errors.push(error),
    async create(mode, onEnded) {
      const job = { mode, onEnded, finished: [], disposed: false,
        async start() {
          await options.start?.(mode)
          if (options.fail === mode) throw new Error('start failure')
        },
        async finish(cancel) { this.finished.push(cancel) },
        async dispose() { this.disposed = true },
      }
      jobs.push(job)
      return job
    },
  })
  return { group, keys, jobs, errors, states, get removed() { return removed },
    async notify() { listener?.(); await group.refresh() },
  }
}

test('ready host starts alone; later shares start independent files without duplicates', async () => {
  const h = harness()
  await h.group.start(['host-camera', 'shared-screen', 'composite'])
  assert.equal(h.jobs.length, 1)
  h.keys['shared-screen'] = h.keys.composite = 'share1'
  await h.notify()
  await h.notify()
  assert.equal(h.jobs.length, 3)
  h.keys['shared-screen'] = h.keys.composite = null
  await h.notify()
  assert.deepEqual(h.jobs[1].finished, [false])
  assert.deepEqual(h.jobs[2].finished, [false])
  assert.equal(h.jobs[0].disposed, false)
  h.keys['shared-screen'] = h.keys.composite = 'share2'
  await h.notify()
  assert.equal(h.jobs.length, 5)
  await h.group.stop()
  assert.ok(h.jobs.every(job => job.disposed))
  assert.equal(h.removed, true)
  h.keys['shared-screen'] = 'share3'
  await h.notify()
  assert.equal(h.jobs.length, 5)
})

test('direct share replacement saves before starting a new job', async () => {
  const h = harness()
  h.keys['shared-screen'] = 'a'
  await h.group.start(['shared-screen'])
  h.keys['shared-screen'] = 'b'
  await h.notify()
  assert.deepEqual(h.jobs[0].finished, [false])
  assert.equal(h.jobs.length, 2)
  await h.group.stop()
})

test('waiting-only session remains armed and stop cancels waiting', async () => {
  const h = harness()
  h.keys['shared-screen'] = 'a'
  await h.group.start(['shared-screen'])
  h.keys['shared-screen'] = null
  await h.notify()
  assert.equal(h.group.active, true)
  assert.equal(h.states.at(-1), true)
  await h.group.stop()
  assert.equal(h.group.active, false)
  h.keys['shared-screen'] = 'b'
  await h.notify()
  assert.equal(h.jobs.length, 1)
})

test('failed output never cancels host or retries on every store update', async () => {
  const h = harness({ fail: 'shared-screen' })
  h.keys['shared-screen'] = 'a'
  await h.group.start(['host-camera', 'shared-screen'])
  await h.notify()
  assert.equal(h.jobs.length, 2)
  assert.equal(h.jobs[0].disposed, false)
  assert.deepEqual(h.jobs[1].finished, [true])
  assert.equal(h.errors.length, 1)
  await h.group.stop()
})

test('ended callback saves once and does not restart the ended share identity', async () => {
  const h = harness()
  h.keys['shared-screen'] = 'a'
  await h.group.start(['shared-screen'])
  await h.jobs[0].onEnded()
  await h.notify()
  assert.deepEqual(h.jobs[0].finished, [false])
  assert.equal(h.jobs.length, 1)
  h.keys['shared-screen'] = 'b'
  await h.notify()
  assert.equal(h.jobs.length, 2)
  await h.group.stop()
})

test('stop during startup cancels partially started output and prevents later modes', async () => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const h = harness({ start: () => new Promise(resolve => { release = resolve; entered() }) })
  h.keys['shared-screen'] = 'a'
  const start = h.group.start(['host-camera', 'shared-screen'])
  await waiting
  const stop = h.group.stop()
  release()
  await Promise.allSettled([start, stop])
  assert.equal(h.jobs.length, 1)
  assert.deepEqual(h.jobs[0].finished, [true])
  assert.equal(h.jobs[0].disposed, true)
  assert.equal(h.removed, true)
})

test('nothing ready refuses to arm', async () => {
  const h = harness()
  await assert.rejects(h.group.start(['shared-screen']), /没有可启动/)
  assert.equal(h.group.active, false)
  assert.equal(h.jobs.length, 0)
})
