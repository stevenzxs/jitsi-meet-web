/** One-shot host lock setup. Joining and moderator authorization are asynchronous. */
export function createRoomPasswordGuard(options: {
  read: () => { moderator: boolean; locked: boolean } | undefined
  lock: () => void
  failed: () => void
  deadline: number
}): (now: number) => boolean {
  let finished = false
  let lastAttempt = -Infinity
  return now => {
    if (finished) return true
    const state = options.read()
    if (state?.locked) {
      finished = true
      return true
    }
    if (now >= options.deadline) {
      finished = true
      options.failed()
      return true
    }
    if (state?.moderator && now - lastAttempt >= 1000) {
      lastAttempt = now
      options.lock()
    }
    return false
  }
}
