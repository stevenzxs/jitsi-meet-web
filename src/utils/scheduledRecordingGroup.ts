import type { RecordingJob } from './recordingGroup'
import type { RecordingMode } from './recordingSources'

interface Entry {
  key: string
  job: RecordingJob | null
  starting: boolean
  ended: boolean
}

/** An armed user action owns independent output segments and a single source subscription. */
export function createRecordingGroup(deps: {
  readyKey(mode: RecordingMode): string | null
  subscribe(listener: () => void): () => void
  create(mode: RecordingMode, onEnded: () => Promise<void>): Promise<RecordingJob>
  onChanged(active: boolean): void
  onError(error: unknown): void
}) {
  const entries = new Map<RecordingMode, Entry>()
  const blocked = new Map<RecordingMode, string>()
  let modes: RecordingMode[] = []
  let armed = false
  let used = false
  let stopped = false
  let cancelOnStop = false
  let unsubscribe: (() => void) | null = null
  let pending = Promise.resolve()
  let queued = false

  async function finish(mode: RecordingMode, entry: Entry, cancel = false) {
    try { await entry.job?.finish(cancel) }
    catch (error) { deps.onError(error) }
    finally {
      try { await entry.job?.dispose() } catch (error) { deps.onError(error) }
      if (entries.get(mode) === entry) entries.delete(mode)
    }
  }

  async function reconcile() {
    for (const mode of modes) {
      const key = stopped ? null : deps.readyKey(mode)
      const previous = entries.get(mode)
      if (previous && (stopped || previous.ended || previous.key !== key)) {
        blocked.set(mode, previous.key)
        await finish(mode, previous, stopped && cancelOnStop)
      }
      if (stopped) continue
      if (!key) { blocked.delete(mode); continue }
      if (entries.has(mode) || blocked.get(mode) === key) continue
      const entry: Entry = { key, job: null, starting: true, ended: false }
      entries.set(mode, entry)
      try {
        entry.job = await deps.create(mode, async () => {
          entry.ended = true
          // A job may await this callback inside start(); never await our own queue.
          if (!entry.starting) await refresh()
        })
        if (stopped || entry.ended) throw new Error('录制启动已取消')
        await entry.job.start()
        if (stopped || entry.ended || deps.readyKey(mode) !== key) {
          blocked.set(mode, key)
          await finish(mode, entry, true)
        }
      } catch (error) {
        blocked.set(mode, key)
        await finish(mode, entry, true)
        if (!stopped) deps.onError(error)
      } finally { entry.starting = false }
    }
  }

  function refresh(): Promise<void> {
    if (!queued) {
      queued = true
      pending = pending.then(async () => {
        queued = false
        await reconcile()
      }).catch(error => { deps.onError(error) })
    }
    return pending
  }

  return {
    get active() { return armed },
    get runningCount() { return entries.size },
    refresh,
    async start(selected: RecordingMode[]) {
      if (used || stopped) throw new Error('录制任务不可重复启动')
      if (!selected.length) throw new Error('请至少选择一种录制模式')
      if (!selected.some(mode => deps.readyKey(mode))) throw new Error('当前没有可启动的录制模式')
      used = true
      modes = [...new Set(selected)]
      armed = true
      unsubscribe = deps.subscribe(() => { if (!stopped) void refresh() })
      deps.onChanged(true)
      await refresh()
      if (stopped) return
      if (!entries.size) {
        armed = false
        stopped = true
        unsubscribe?.(); unsubscribe = null
        deps.onChanged(false)
        throw new Error('录制模式启动失败')
      }
    },
    async stop(cancel = false) {
      stopped = true
      cancelOnStop ||= cancel
      armed = false
      unsubscribe?.(); unsubscribe = null
      deps.onChanged(false)
      await refresh()
    },
  }
}
