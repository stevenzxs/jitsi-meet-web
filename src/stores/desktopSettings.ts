import { inDesktopShell } from './user'

export interface DesktopSettings {
  recording: {
    directory: string
    recordAudioFile: boolean
    /** 旧单选字段，仅用于兼容历史配置。 */
    mode: 'host-camera' | 'shared-screen'
    modes: Array<'host-camera' | 'shared-screen' | 'composite'>
  }
  video: {
    tilePollingSeconds: number
  }
}

const TILE_POLLING_SECONDS_MIN = 15
const TILE_POLLING_SECONDS_MAX = 7200
const TILE_POLLING_SECONDS_DEFAULT = 60

function normalizeTilePollingSeconds(value: unknown): number {
  if (value === undefined || value === null || value === '') return TILE_POLLING_SECONDS_DEFAULT
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return TILE_POLLING_SECONDS_DEFAULT
  const rounded = Math.round(seconds)
  if (rounded <= 0) return 0
  return Math.min(TILE_POLLING_SECONDS_MAX, Math.max(TILE_POLLING_SECONDS_MIN, rounded))
}

export function normalizeDesktopSettings(settings: unknown): DesktopSettings {
  const raw = settings && typeof settings === 'object' ? settings as Partial<DesktopSettings> & { video?: { tilePollingMinutes?: number } } : {}
  const legacyMinutes = Number(raw.video?.tilePollingMinutes)
  const seconds = raw.video?.tilePollingSeconds
    ?? (Number.isFinite(legacyMinutes) ? legacyMinutes * 60 : undefined)
  return {
    recording: {
      directory: typeof raw.recording?.directory === 'string' ? raw.recording.directory : '',
      recordAudioFile: Boolean(raw.recording?.recordAudioFile),
      mode: raw.recording?.mode === 'shared-screen' ? 'shared-screen' : 'host-camera',
      modes: Array.isArray(raw.recording?.modes)
        ? (['host-camera', 'shared-screen', 'composite'] as const).filter(mode => raw.recording!.modes.includes(mode))
        : [raw.recording?.mode === 'shared-screen' ? 'shared-screen' : 'host-camera'],
    },
    video: {
      tilePollingSeconds: normalizeTilePollingSeconds(seconds),
    },
  }
}

function request<T>(type: string, responseType: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!inDesktopShell()) return Promise.reject(new Error('仅桌面客户端支持此设置'))
  const requestId = `desktop-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', listener)
      reject(new Error('桌面设置服务无响应'))
    }, 3000)
    const listener = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const data = event.data as { type?: string; requestId?: string; error?: string } | null
      if (data?.type !== responseType || data.requestId !== requestId) return
      window.clearTimeout(timer)
      window.removeEventListener('message', listener)
      if (data.error) reject(new Error(data.error))
      else resolve(data as T)
    }
    window.addEventListener('message', listener)
    window.parent.postMessage({ type, requestId, ...payload }, '*')
  })
}

export function requestDesktopSettings(): Promise<DesktopSettings> {
  return request<{ settings?: unknown }>('cloudmeet-desktop-settings-get', 'cloudmeet-desktop-settings')
    .then((response) => normalizeDesktopSettings(response.settings))
}

// Navigation only: credentials and native VPN operations stay in the local shell.
export function openDesktopPreferences(): Promise<void> {
  return request('cloudmeet-preferences-open', 'cloudmeet-preferences-opened')
    .then(() => undefined)
    .catch(() => { throw new Error('无法打开客户端偏好，请升级并重启桌面客户端') })
}

export function openDesktopVpnSettings(): Promise<void> {
  return request('cloudmeet-vpn-settings-open', 'cloudmeet-vpn-settings-opened')
    .then(() => undefined)
    .catch(() => { throw new Error('无法打开本地 VPN 配置，请确认已安装并重启新版桌面客户端') })
}

export function saveDesktopSettings(settings: DesktopSettings): Promise<DesktopSettings> {
  const normalized = normalizeDesktopSettings(settings)
  if (!normalized.recording.modes.length) return Promise.reject(new Error('请至少选择一种录制模式'))
  return request<{ settings?: unknown }>('cloudmeet-desktop-settings-save', 'cloudmeet-desktop-settings-saved', { settings: normalized })
    .then((response) => normalizeDesktopSettings(response.settings))
}

export function chooseDesktopRecordingDirectory(): Promise<DesktopSettings> {
  return request<{ settings?: unknown }>('cloudmeet-recording-directory-choose', 'cloudmeet-recording-directory-chosen')
    .then((response) => normalizeDesktopSettings(response.settings))
}

export function openDesktopRecordingDirectory(directory: string): Promise<{ ok: boolean; error?: string }> {
  return request<{ result?: { ok?: boolean; error?: string } }>(
    'cloudmeet-recording-directory-open',
    'cloudmeet-recording-directory-opened',
    { directory },
  ).then((response) => ({ ok: Boolean(response.result?.ok), error: response.result?.error }))
}

export function onDesktopSettingsChanged(handler: (settings: DesktopSettings, recordingActive: boolean) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent) return
    const data = event.data as { type?: string; settings?: unknown; recordingActive?: boolean } | null
    if (data?.type === 'cloudmeet-desktop-settings-changed') handler(normalizeDesktopSettings(data.settings), Boolean(data.recordingActive))
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}
