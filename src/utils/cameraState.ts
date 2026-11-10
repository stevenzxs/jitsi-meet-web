import { ref } from 'vue'
import type { JitsiMeetExternalAPI } from '../types/jitsi'
import { isCameraFailureNotification } from './deviceNotifications'

const cameraStates = new WeakMap<JitsiMeetExternalAPI, ReturnType<typeof createCameraState>>()

/** Start observing before joining: the toolbar mounts after initial device errors. */
export function getCameraState(api: JitsiMeetExternalAPI) {
  let state = cameraStates.get(api)
  if (!state) {
    state = createCameraState(api)
    cameraStates.set(api, state)
  }
  return state
}

export function disposeCameraState(api: JitsiMeetExternalAPI): void {
  cameraStates.get(api)?.dispose()
  cameraStates.delete(api)
}

export function createCameraState(api: JitsiMeetExternalAPI) {
  const muted = ref(true)
  let failed = false
  let disposed = false
  let sharing = false
  let muteRequested = false
  let retry: 'none' | 'muting' | 'opening' = 'none'
  let retryStartedAt = 0
  let version = 0
  let syncSequence = 0
  const cleanups: Array<() => void> = []

  function on(name: string, handler: (event: any) => void): void {
    api.addListener(name, handler)
    cleanups.push(() => api.removeListener(name, handler))
  }

  function beginRetry(): void {
    retry = 'opening'
    retryStartedAt = Date.now()
    version++
    // Stay visually off until Jitsi confirms that video actually opened.
    api.executeCommand('toggleVideo')
  }

  function applyMuted(value: boolean, confirmedByEvent = false): void {
    if (value) {
      muteRequested = false
      if (retry === 'muting') {
        beginRetry()
      }
    } else if (confirmedByEvent && retry === 'opening') {
      failed = false
      retry = 'none'
    }
    muted.value = failed || value
  }

  async function sync(): Promise<void> {
    const currentVersion = version
    const sequence = ++syncSequence
    try {
      const value = await api.isVideoMuted()
      if (!disposed && currentVersion === version && sequence === syncSequence) {
        applyMuted(Boolean(value))
      }
    } catch {
      // Preserve the last confirmed state if the iframe is unavailable.
    }
  }

  async function ensureMuted(): Promise<void> {
    const currentVersion = version
    try {
      const value = await api.isVideoMuted()
      if (disposed || currentVersion !== version) return
      if (value) {
        applyMuted(true)
      } else if (!sharing && !muteRequested) {
        // A camera with no frames can still be logically unmuted in Jitsi.
        // Close that track so the next "enable video" retries opening it.
        muteRequested = true
        api.executeCommand('toggleVideo')
      }
    } catch {
      // A failed query must never turn the camera indicator back on.
      if (!disposed && currentVersion === version && retry === 'muting') retry = 'none'
    }
  }

  function unavailable(): void {
    console.log('[CameraState] unavailable() called, state:', { failed, retry, disposed, timestamp: new Date().toISOString() })
    if (disposed) return
    muted.value = true
    if (failed && retry === 'none') {
      console.log('[CameraState] Already failed, skipping')
      return
    }
    version++
    failed = true
    retry = 'none'
    console.log('[CameraState] Marked as failed, calling ensureMuted()')
    void ensureMuted()
  }

  async function toggle(): Promise<void> {
    console.log('[CameraState] toggle() called, state:', { failed, retry, disposed, muted: muted.value, timestamp: new Date().toISOString() })
    if (disposed) return
    if (retry !== 'none') {
      // WebView can lose Jitsi's mute event while Android is in the background.
      // A stale request must not make every later tap a no-op.
      if (Date.now() - retryStartedAt < 2500) return
      retry = 'none'
      muteRequested = false
    }
    if (failed) {
      if (sharing) return
      version++
      retry = 'muting'
      retryStartedAt = Date.now()
      console.log('[CameraState] Failed state, calling ensureMuted()')
      await ensureMuted()
    } else {
      version++
      console.log('[CameraState] Normal toggle, calling executeCommand')
      // Stay visually off until Jitsi confirms that video actually opened.
      api.executeCommand('toggleVideo')
    }
  }

  /**
   * Clear a latched failure before a deliberate device switch so the new
   * camera gets a real open attempt. A genuine failure re-latches via
   * cameraError / notificationTriggered / videoAvailabilityChanged.
   */
  function resetFailure(): void {
    if (disposed) return
    if (!failed && retry === 'none') return
    console.log('[CameraState] resetFailure(), state:', { failed, retry, timestamp: new Date().toISOString() })
    failed = false
    retry = 'none'
    version++
  }

  on('cameraError', unavailable)
  on('notificationTriggered', (event: unknown) => {
    if (isCameraFailureNotification(event)) unavailable()
  })
  on('videoAvailabilityChanged', (event: unknown) => {
    const available = typeof event === 'boolean' ? event
      : event && typeof event === 'object'
        ? ((event as { available?: boolean; isAvailable?: boolean }).available
          ?? (event as { isAvailable?: boolean }).isAvailable)
        : undefined
    if (available === false) unavailable()
    // Detecting hardware again does not prove that the camera can send video.
  })
  on('videoMuteStatusChanged', (event: unknown) => {
    if (disposed) return
    syncSequence++
    const value = typeof event === 'boolean' ? event
      : event && typeof event === 'object' ? (event as { muted?: unknown }).muted : undefined
    if (typeof value === 'boolean') {
      version++
      applyMuted(value, true)
      if (!value && failed && retry === 'none') void ensureMuted()
    }
  })
  on('screenSharingStatusChanged', (event: unknown) => {
    sharing = typeof event === 'boolean' ? event
      : Boolean(event && typeof event === 'object' && (event as { on?: boolean }).on)
  })

  return {
    muted,
    sync,
    toggle,
    unavailable,
    resetFailure,
    dispose() {
      disposed = true
      version++
      cleanups.forEach((cleanup) => cleanup())
    },
  }
}
