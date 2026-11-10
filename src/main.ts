import './webview-compat.js';
import './android-credential-probe.js';
import { createApp } from 'vue';
import '@fontsource-variable/noto-sans-sc';
import '@fontsource/sora/400.css';
import '@fontsource/sora/600.css';
import '@fontsource/sora/700.css';
import '@fontsource/sora/800.css';
import './style.css';
import App from './App.vue';
import router from './router';
import { THEME_CHANGE_EVENT, applyTheme, getStoredTheme, installThemeStorageSync } from './utils/theme';
import type { ThemeMode } from './utils/theme';

const searchParams = new URLSearchParams(window.location.search);
const isDesktopEmbed = searchParams.get('desktop') === '1';
const isAndroidEmbed = searchParams.get('android') === '1';

/**
 * 主题切换（全局入口）：后续设置页面/开关直接调 window.setTheme('light' | 'dark')。
 * 默认规则：桌面端浅色（白色），Web 端深色；已有选择时优先用户设置。
 */
function setGlobalTheme(theme: ThemeMode): void {
  applyTheme(theme);
}

/**
 * 桌面端会议窗口的顶部栏属于 Electron 外壳，不在 Jitsi iframe 内部；
 * 任何主题来源（按钮切换、query 初始化、storage 跨窗口同步）都要同步通知父窗口。
 */
function notifyDesktopShellTheme(theme: ThemeMode): void {
  if (!isDesktopEmbed || window.parent === window) return;
  window.parent.postMessage({ type: THEME_CHANGE_EVENT, theme }, '*');
}

window.addEventListener(THEME_CHANGE_EVENT, ((event: Event) => {
  const theme = (event as CustomEvent<ThemeMode>).detail;
  if (theme === 'light' || theme === 'dark') {
    notifyDesktopShellTheme(theme);
  }
}) as EventListener);

window.setTheme = (theme: ThemeMode) => setGlobalTheme(theme);

window.addEventListener('message', (event) => {
  const data = event.data as { type?: string; theme?: ThemeMode } | null;
  if (!data || data.type !== THEME_CHANGE_EVENT || (data.theme !== 'light' && data.theme !== 'dark')) return;
  // 独立会议窗口不一定能收到 localStorage 的 storage 事件，桌面壳转发消息时在这里直接落主题。
  applyTheme(data.theme);
});

// 会议窗口由桌面壳打开时会带 theme query，优先使用它保证新窗口与主窗口同步。
const queryTheme = searchParams.get('theme');
const savedTheme = getStoredTheme();
const defaultTheme = isDesktopEmbed || isAndroidEmbed ? 'light' : 'dark';
const initialTheme =
  queryTheme === 'light' || queryTheme === 'dark' ? queryTheme : isAndroidEmbed ? 'light' : savedTheme ?? defaultTheme;
setGlobalTheme(initialTheme);
installThemeStorageSync();

if (isAndroidEmbed) {
  document.documentElement.classList.add('android-embed');
}

// Electron 桌面壳会追加 desktop=1，用于让 Web 页面切换到嵌入式布局。
if (isDesktopEmbed) {
  document.documentElement.classList.add('desktop-embed');

  // 首页需要纵向滚动，会议页需要固定满屏；用路由类名区分两种桌面嵌入场景。
  router.afterEach((to) => {
    document.documentElement.classList.toggle('desktop-meeting', to.name === 'meeting' || to.name === 'desktop-meeting');
  });
}

createApp(App).use(router).mount('#app');
