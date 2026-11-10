export interface RecordingFinishResult {
  converting?: boolean
  videoFormat?: 'mp4' | 'webm'
}

export function getRecordingFinishMessage(result: RecordingFinishResult): string {
  if (result.converting) return '录屏已结束，MP4 正在后台转换'
  return result.videoFormat === 'webm' ? 'MP4 转换失败，录屏已保存为 WebM' : '录制已保存为 MP4'
}

type TranscodeOutcome = 'complete' | 'failed'

function getTranscodeOutcomeMessage(outcome: TranscodeOutcome): string {
  return outcome === 'complete' ? 'MP4 转换完成，录屏已保存' : 'MP4 转换失败，录屏已保存为 WebM'
}

export class RecordingTranscodeTracker {
  private pending = new Map<string, { acknowledged: boolean; outcome?: TranscodeOutcome }>()

  start(sessionId: string): void {
    this.pending.set(sessionId, { acknowledged: false })
  }

  finish(sessionId: string, result: RecordingFinishResult): string {
    const pending = this.pending.get(sessionId)
    if (!result.converting || !pending) {
      this.pending.delete(sessionId)
      return getRecordingFinishMessage(result)
    }
    pending.acknowledged = true
    if (!pending.outcome) return getRecordingFinishMessage(result)
    this.pending.delete(sessionId)
    return getTranscodeOutcomeMessage(pending.outcome)
  }

  outcome(sessionId: string, outcome: TranscodeOutcome): string | null {
    const pending = this.pending.get(sessionId)
    if (!pending) return null
    pending.outcome = outcome
    if (!pending.acknowledged) return null
    this.pending.delete(sessionId)
    return getTranscodeOutcomeMessage(outcome)
  }

  cancel(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  clear(): void {
    this.pending.clear()
  }
}
