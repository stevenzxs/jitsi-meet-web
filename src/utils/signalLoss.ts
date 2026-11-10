export interface SignalSnapshot {
  conference: object
  connected: unknown
  transitioning: boolean
  recovering?: boolean
}

/** stable-11146-2's XmppConnection retries stream resume up to three times.
 * Its connected getter is false throughout backoff/offline waits. Keep this
 * version-specific adapter here, rather than treating that getter as failure.
 */
export function isXmppRecovering(connection: any): boolean {
  const retries = connection?._resumeTask?.retryCount
  if (!connection?._stropheConn?.streamManagement?.getResumeToken?.()) return false
  if (typeof retries === 'number' && retries >= 1 && retries <= 3) return true
  // CONNECTED/ATTACHED remains set until Strophe receives the socket close
  // callback, which can itself wait during an outage. This precedes RESUMING.
  const socketState = connection?._stropheConn?._proto?.socket?.readyState
  return retries === 0 && (connection?._status === 5 || connection?._status === 11)
    && (socketState === 2 || socketState === 3)
}

/** Local-only watchdog. Never interprets connection loss as remote room termination. */
export function createSignalLossMonitor(options: {
  read: () => SignalSnapshot | null
  onLost: () => void
  now: () => number
  schedule: (tick: () => void) => number
  cancel: (timer: number) => void
}): () => void {
  let stopped = false
  let previous: object | undefined
  let since: number | undefined
  const stop = () => {
    if (stopped) return
    stopped = true
    options.cancel(timer)
  }
  const timer = options.schedule(() => {
    if (stopped) return
    let state: SignalSnapshot | null
    try { state = options.read() } catch { state = null }
    if (!state || state.transitioning || state.recovering || state.connected !== false) {
      previous = undefined
      since = undefined
      return
    }
    const time = options.now()
    if (state.conference !== previous) {
      previous = state.conference
      since = time
    }
    if (since !== undefined && time - since >= 8000) {
      stop()
      options.onLost()
    }
  })
  return stop
}
