// Keep device discovery and failures out of the meeting's notification overlay.
// Jitsi still emits notificationTriggered for disabled notifications.
const cameraFailureNotifications = [
  'deviceError.cameraError',
  'deviceError.cameraPermission',
  'dialog.cameraNotSendingDataTitle',
  'dialog.cameraNotSendingData',
  'dialog.cameraConstraintFailedError',
]

export const disabledDeviceNotifications = [
  'notify.newDeviceAudioTitle',
  'notify.newDeviceCameraTitle',
  'notify.multipleAudioDevicesTitle',
  ...cameraFailureNotifications,
  'deviceError.microphoneError',
  'deviceError.microphonePermission',
  'dialog.micNotSendingDataTitle',
  'dialog.micNotSendingData',
  'toolbar.noAudioSignalTitle',
  'toolbar.noisyAudioInputTitle',
]

export function isCameraFailureNotification(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  const { title, description } = event as { title?: unknown; description?: unknown }
  return cameraFailureNotifications.some((key) => key === title || key === description)
}
