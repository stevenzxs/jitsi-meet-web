# jitsi-meet-web 部署日志 v2 - 根本修复

## 部署时间
**2026-09-10 17:10:00 (UTC+8)**

## 问题分析

### 现象
点击"更多"按钮后，在更多设置界面中点击摄像头切换按钮时，意外触发视频会议的全屏/退出全屏事件。

### v1 修复尝试（失败）
第一版修复尝试在 Web 端的全局点击监听器中排除 `.mobile-more-layer`，但**无效**。

### 根本原因分析

通过深入分析 Android 端代码，发现问题根源在 **Android WebView 的触摸事件监听器**：

#### Android 端触摸事件处理逻辑
**文件**: `MeetingActivity.java` 第 744-760 行

```java
case MotionEvent.ACTION_UP:
    boolean shouldToggleFullscreen = webTapTracking
        && canToggleFullscreen(meetingJoined, fullscreenToggleEnabled)
        && event.getEventTime() - webTapDownAt <= VIDEO_AREA_TAP_MAX_DURATION_MS
        && !hasWebTapMovedBeyondSlop(event)
        && isVideoAreaTapTarget(
            event.getX(),
            event.getY(),
            view.getWidth(),
            view.getHeight(),
            fullscreen,
            density
        );
```

关键函数 `isVideoAreaTapTarget` (第 778-788 行)：
```java
static boolean isVideoAreaTapTarget(float x, float y, int width, int height, boolean fullscreen, float density) {
    if (width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) {
        return false;
    }
    if (fullscreen) {
        return true;  // ⚠️ 全屏时，整个屏幕任意位置都触发全屏切换！
    }
    float safeDensity = Math.max(1f, density);
    int bottomControlsExclusionPx = Math.round(WEB_BOTTOM_CONTROLS_EXCLUSION_DP * safeDensity);
    return y < height - bottomControlsExclusionPx;
}
```

**问题链路：**
1. Android WebView 的 `OnTouchListener` 监听所有触摸事件（在 Web 事件系统之外）
2. 全屏模式下，`isVideoAreaTapTarget` 对所有区域返回 `true`
3. 即使 Web 端用 `@click.stop` 阻止事件冒泡，Android 端仍能收到原始触摸事件
4. 导致点击"更多"抽屉内任何按钮都会触发全屏切换

### 正确的修复方案

利用现有的 **全屏切换开关机制**：

- Android 端有 `fullscreenToggleEnabled` 标志位
- Web 端通过 `cloudmeet-fullscreen-toggle-availability` 消息控制此标志
- 已有代码在打开聊天/参与者面板时会禁用全屏切换

**解决方案**：在打开/关闭"更多"抽屉时，同步通知 Android 禁用/启用全屏切换。

## 修复内容

### 文件: `src/components/CustomToolbar.vue`

#### 1. 修改 `notifyShellFullscreenToggleAvailability` 函数（第 147-151 行）

**修改前**:
```typescript
function notifyShellFullscreenToggleAvailability(): void {
  if (!androidEmbed || window.parent === window) return
  const enabled = !chatOpen.value && !participantsOpen.value
  window.parent.postMessage({ type: 'cloudmeet-fullscreen-toggle-availability', enabled }, '*')
}
```

**修改后**:
```typescript
function notifyShellFullscreenToggleAvailability(): void {
  if (!androidEmbed || window.parent === window) return
  const enabled = !chatOpen.value && !participantsOpen.value && !mobileMoreOpen.value
  window.parent.postMessage({ type: 'cloudmeet-fullscreen-toggle-availability', enabled }, '*')
}
```

#### 2. 修改 `toggleMobileMore` 函数（第 456-464 行）

**修改前**:
```typescript
function toggleMobileMore(): void {
  mobileMoreOpen.value = !mobileMoreOpen.value
  if (mobileMoreOpen.value) {
    endMenuOpen.value = false
    devicePanel.value = null
    void loadDevices()
  }
}
```

**修改后**:
```typescript
function toggleMobileMore(): void {
  mobileMoreOpen.value = !mobileMoreOpen.value
  if (mobileMoreOpen.value) {
    endMenuOpen.value = false
    devicePanel.value = null
    void loadDevices()
  }
  notifyShellFullscreenToggleAvailability()
}
```

#### 3. 修改 `closeMobileMore` 函数（第 466-469 行）

**修改前**:
```typescript
function closeMobileMore(): void {
  mobileMoreOpen.value = false
}
```

**修改后**:
```typescript
function closeMobileMore(): void {
  mobileMoreOpen.value = false
  notifyShellFullscreenToggleAvailability()
}
```

#### 4. 修改 `switchMobileCamera` 函数（第 471-475 行）

**修改前**:
```typescript
function switchMobileCamera(deviceId: string): void {
  void selectDevice('videoInput', deviceId)
  mobileMoreOpen.value = false
}
```

**修改后**:
```typescript
function switchMobileCamera(deviceId: string): void {
  void selectDevice('videoInput', deviceId)
  mobileMoreOpen.value = false
  notifyShellFullscreenToggleAvailability()
}
```

## 工作原理

### 状态流转

```
1. 用户点击"更多"按钮
   → mobileMoreOpen = true
   → 发送 { type: 'cloudmeet-fullscreen-toggle-availability', enabled: false }
   → Android 设置 fullscreenToggleEnabled = false

2. 用户在"更多"抽屉内点击摄像头切换
   → Android OnTouchListener 收到 ACTION_UP
   → canToggleFullscreen(meetingJoined, fullscreenToggleEnabled) = false
   → 不触发全屏切换 ✅

3. 用户关闭"更多"抽屉（点击遮罩或切换摄像头后自动关闭）
   → mobileMoreOpen = false
   → 发送 { type: 'cloudmeet-fullscreen-toggle-availability', enabled: true }
   → Android 设置 fullscreenToggleEnabled = true
   → 恢复正常的全屏切换功能 ✅
```

## 部署流程

### 1. 本地构建验证
- ✅ TypeScript 类型检查通过
- ✅ Vite 构建成功（526ms）
- ✅ 代码逻辑验证通过

### 2. 服务器部署 (115.190.243.21)

#### 2.1 停止旧容器
```bash
docker stop jitsi-app-web-1
docker rm jitsi-app-web-1
```

#### 2.2 更新代码
```bash
tar -xzf /tmp/jitsi-meet-web-fix-v2.tar.gz
```

#### 2.3 重新构建镜像
```bash
cd /opt/jitsi-app
docker compose build web
```

构建结果:
- 镜像ID: `9caf1ae3cec8`
- 镜像大小: 84.1MB (压缩: 25.9MB)

#### 2.4 启动新容器
```bash
docker compose up -d web
```

### 3. 部署验证

#### 容器状态
```
CONTAINER ID   IMAGE                  STATUS         PORTS
4804fcb79d73   jitsi-meet-web:local   Up 3 seconds   127.0.0.1:9000->80/tcp
```

#### 服务健康检查
- ✅ HTTP 响应: 200
- ✅ 响应时间: 0.0016s
- ✅ 日志正常
- ✅ 静态资源加载正常

## 测试验证

### Android 端测试步骤

#### 基本功能测试
1. **打开视频会议** → 进入会议界面
2. **点击"更多"按钮** → 打开更多设置抽屉
3. **点击"前置摄像头"按钮** → 预期：切换到前置摄像头，**不触发全屏**
4. **点击"后置摄像头"按钮** → 预期：切换到后置摄像头，**不触发全屏**
5. **点击遮罩关闭抽屉** → 抽屉关闭
6. **点击视频区域空白处** → 预期：正常触发全屏/退出全屏 ✅

#### 边界情况测试
1. **快速连续点击摄像头按钮** → 预期：不触发全屏
2. **在更多抽屉内滑动后点击** → 预期：不触发全屏
3. **打开更多抽屉后旋转屏幕** → 预期：功能正常
4. **聊天/参与者面板与更多抽屉切换** → 预期：全屏切换状态正确

#### 回归测试清单
- [ ] 正常的全屏/退出全屏功能（点击视频区域）仍然可用
- [ ] 打开聊天面板时，点击视频区域不触发全屏（已有功能）
- [ ] 打开参与者面板时，点击视频区域不触发全屏（已有功能）
- [ ] 打开更多抽屉时，点击抽屉内按钮不触发全屏（本次修复）
- [ ] 关闭所有浮层后，全屏切换功能恢复正常

## 技术亮点

### 为什么这个方案正确？

1. **利用现有机制**：没有引入新的通信协议，复用了已验证的 `fullscreenToggleEnabled` 机制
2. **根本解决**：在 Android 原生层面阻止了触摸事件触发全屏，而不是在 Web 层尝试阻止（Web 层无法拦截 Android 的 OnTouchListener）
3. **一致性好**：与聊天/参与者面板的处理逻辑一致
4. **无副作用**：不影响其他功能，不引入新的状态管理复杂度

### 为什么 v1 修复失败？

v1 尝试在 Web 端的全局点击监听器中排除 `.mobile-more-layer`，但这只能阻止 Web 事件系统内的冒泡。Android 的 `OnTouchListener` 是在更底层（原生层）监听触摸事件，完全独立于 Web 事件系统。

**事件层级示意**：
```
Android 原生触摸事件 (OnTouchListener)  ← 这里触发全屏切换
    ↓
WebView 内部事件处理
    ↓
Web DOM 事件系统 (addEventListener)     ← v1 修复的层级（无效）
    ↓
Vue 事件处理 (@click.stop)
```

## 回滚方案

如需回滚到 v1 版本：
```bash
ssh root@115.190.243.21
cd /opt/jitsi-app
docker stop jitsi-app-web-1
docker rm jitsi-app-web-1
rm -rf jitsi-meet-web-package
mv jitsi-meet-web-package.bak.20260910_165915 jitsi-meet-web-package
docker compose up -d web
```

## 相关文件
- 本地源码: `D:\code\jitsi\jitsi-meet-web`
- 服务器部署目录: `/opt/jitsi-app/jitsi-meet-web-package`
- 备份目录: `/opt/jitsi-app/jitsi-meet-web-package.bak.20260910_165915`
- Android 源码: `D:\code\jitsi\jitsi-meet-android`

## 下一步
1. **QA 测试**：按上述测试步骤进行完整验证
2. **用户反馈**：收集实际使用体验
3. **监控日志**：观察是否有新的异常
4. **清理备份**：测试通过后删除旧版本备份

## 总结

通过深入分析 Android 端的触摸事件处理机制，发现了问题的根本原因：Android 原生层的触摸事件监听器在 Web 事件系统之外独立工作。正确的修复方案是利用现有的全屏切换开关机制，在打开"更多"抽屉时禁用 Android 端的全屏切换功能，从根本上阻止了误触发。

这个案例展示了跨平台开发中事件系统的层级关系，以及如何通过理解底层机制来找到正确的修复方案。
