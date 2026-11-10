/**
 * 全站主题工具：
 * 统一管理浅色 / 深色主题的读写、跨窗口同步，以及 Jitsi 主题配置生成。
 */
export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'cloudmeet-theme'
export const THEME_CHANGE_EVENT = 'cloudmeet-theme-changed'

/**
 * 读取当前窗口已保存的主题。
 * 这里只做最轻量的持久化读取，避免各组件重复写 localStorage 访问逻辑。
 */
export function getStoredTheme(): ThemeMode | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/**
 * 从当前文档状态推断主题。
 * 优先读根节点上的 data-theme，其次回退到 localStorage，最后默认深色。
 */
export function getCurrentTheme(): ThemeMode {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark') return attr
  return getStoredTheme() ?? 'dark'
}

/**
 * 把主题写入当前窗口，并广播给同一窗口内的组件。
 * 跨窗口同步由 storage 事件负责，这里只负责本窗口即时刷新。
 */
export function applyTheme(theme: ThemeMode, persist = true): void {
  const root = document.documentElement
  // 始终保留明确的主题属性，方便同源 Jitsi iframe 和 custom.css 识别暗色分支。
  root.setAttribute('data-theme', theme)

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      /* ignore */
    }
  }

  // 同窗口事件用于驱动页面内的 Jitsi 重建和按钮文案同步。
  window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: theme }))
}

/**
 * 监听本窗口内的主题变化事件。
 * 返回清理函数，方便组件在卸载时移除监听。
 */
export function onThemeChange(handler: (theme: ThemeMode) => void): () => void {
  const listener = (event: Event): void => {
    const theme = (event as CustomEvent<ThemeMode>).detail
    if (theme === 'light' || theme === 'dark') {
      handler(theme)
    }
  }
  window.addEventListener(THEME_CHANGE_EVENT, listener as EventListener)
  return () => window.removeEventListener(THEME_CHANGE_EVENT, listener as EventListener)
}

/**
 * 同步其他窗口对主题的修改。
 * 只有本窗口不是写入方时，storage 事件才会触发；这里接住后再应用到当前窗口。
 */
export function installThemeStorageSync(): void {
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return
    const next = event.newValue
    if (next !== 'light' && next !== 'dark') return
    if (getCurrentTheme() === next) return
    applyTheme(next, false)
  })
}

/**
 * 生成 Jitsi 的 customTheme。
 * 这里只覆盖基础色板，细碎的界面修饰仍交给 custom.css 兜底。
 */
export function buildJitsiCustomTheme(theme: ThemeMode): Record<string, unknown> {
  const light = theme === 'light'
  return {
    palette: {
      // 使用 Jitsi 官方 custom-theme 色板键；未知键不会参与主题计算。
      uiBackground: light ? '#f3f6fb' : '#040404',
      ui01: light ? '#ffffff' : '#131519',
      ui02: light ? '#edf2f8' : '#242528',
      ui03: light ? '#dde5ef' : '#2b2d31',
      ui04: light ? '#cdd7e4' : '#3b3d42',
      ui05: light ? '#aebbd0' : '#5c6068',
      action01: light ? '#2563eb' : '#4086f4',
      action01Hover: light ? '#1d4ed8' : '#5b96ff',
      action01Active: light ? '#1e40af' : '#2f6fd6',
      action02: light ? '#edf2f8' : '#2b2d31',
      action02Hover: light ? '#dde5ef' : '#3b3d42',
      action02Active: light ? '#cdd7e4' : '#4b4e55',
      disabled01: light ? '#c4cedd' : '#585b63',
      actionDanger: light ? '#dc2626' : '#f05262',
      actionDangerHover: light ? '#b91c1c' : '#ff6875',
      actionDangerActive: light ? '#991b1b' : '#d83f50',
      text01: light ? '#16202e' : '#ffffff',
      text02: light ? '#46566d' : '#d6dde8',
      text03: light ? '#7a899d' : '#9aa6b6',
      text04: light ? '#243244' : '#ffffff',
      textError: light ? '#dc2626' : '#ff8791',
      icon01: light ? '#16202e' : '#ffffff',
      icon02: light ? '#46566d' : '#d6dde8',
      icon03: light ? '#7a899d' : '#9aa6b6',
      iconError: light ? '#dc2626' : '#ff8791',
      field01: light ? '#edf2f8' : '#2b2d31',
      field02: light ? '#ffffff' : '#131519',
      link01: light ? '#2563eb' : '#75a7ff',
      link01Hover: light ? '#1d4ed8' : '#9fc1ff',
      link01Active: light ? '#1e40af' : '#5b96ff',
      success01: light ? '#059669' : '#2dd4bf',
      success02: light ? '#d1fae5' : '#164e49',
      warning01: light ? '#d97706' : '#f59e0b',
      warning02: light ? '#fef3c7' : '#5a4010',
      bottomSheet: light ? '#ffffff' : '#1f2024',
    },
    typography: {
      // 只传官方支持的字重字段，字体族继续由 custom.css 和 Jitsi 默认样式控制。
      font: {
        weightRegular: 400,
        weightSemiBold: 600,
        weightBold: 700,
      },
    },
  }
}
