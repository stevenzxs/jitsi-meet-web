import type { RecordingMode } from './recordingSources'

export interface RecordingJob {
  start(): Promise<void>
  finish(cancel: boolean): Promise<void>
  dispose(): Promise<void>
}

/** One user action, independent outputs. A failed output never discards its siblings. */
export function createRecordingGroup(deps: {
  create(mode: RecordingMode, onEnded: () => Promise<void>): Promise<RecordingJob>
  onChanged(active: boolean): void
  onError(error: unknown): void
}) {
  const jobs = new Set<RecordingJob>()
  const finishing = new Map<RecordingJob, Promise<void>>()
  const endedDuringStart = new Set<RecordingJob>()
  let starting = false
  let stopped = false
  let stopping: Promise<void> | null = null

  function finish(job: RecordingJob, cancel = false): Promise<void> {
    const existing = finishing.get(job)
    if (existing) return existing
    if (!jobs.has(job)) return Promise.resolve()
    const pending = (async () => {
      try { await job.finish(cancel) }
      catch (error) { deps.onError(error) }
      finally {
        try { await job.dispose() } catch (error) { deps.onError(error) }
        jobs.delete(job)
        finishing.delete(job)
        if (!starting) deps.onChanged(jobs.size > 0)
      }
    })()
    finishing.set(job, pending)
    return pending
  }

  return {
    get active() { return jobs.size > 0 },
    async start(modes: RecordingMode[]) {
      if (!modes.length) throw new Error('请至少选择一种录制模式')
      if (starting || jobs.size || stopped) throw new Error('录制任务不可重复启动')
      starting = true
      try {
        for (const mode of modes) {
          let job: RecordingJob | null = null
          let ended = false
          const onEnded = async () => {
            ended = true
            if (job) {
              if (starting) endedDuringStart.add(job)
              else await finish(job)
            }
          }
          job = await deps.create(mode, onEnded)
          jobs.add(job)
          if (stopped || ended) throw new Error('录制启动已取消或共享已结束')
          await job.start()
          if (stopped || ended) throw new Error('录制启动已取消或共享已结束')
        }
      } catch (error) {
        await Promise.all([...jobs].map(job => finish(job, true)))
        throw error
      } finally {
        starting = false
        await Promise.all([...endedDuringStart].map(job => finish(job)))
        endedDuringStart.clear()
        deps.onChanged(jobs.size > 0)
      }
    },
    stop(cancel = false): Promise<void> {
      stopped = true
      if (!stopping) stopping = Promise.all([...jobs].map(job => finish(job, cancel))).then(() => undefined)
      return stopping
    },
  }
}
