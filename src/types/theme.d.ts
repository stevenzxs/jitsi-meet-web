import type { ThemeMode } from '../utils/theme'

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options?: JitsiExternalAPIOptions,
    ) => JitsiMeetExternalAPI;
    /** 全局主题切换：由桌面壳和会议 iframe 共用同一个主题类型。 */
    setTheme?: (theme: ThemeMode) => void;
  }
}

export {}
