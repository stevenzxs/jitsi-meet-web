# jitsi-meet-web 部署日志

## 部署时间
**2026-09-10 16:59:15 (UTC+8)**

## 问题描述
- **现象**: 点击"更多"按钮后，在更多设置界面中点击摄像头切换按钮时，意外触发视频会议的全屏/退出全屏事件
- **影响**: 用户体验问题，操作行为不符合预期

## 根本原因
在 `CustomToolbar.vue` 的全局点击监听器 `handleDocumentClick` 中，未排除 Android 更多抽屉（`.mobile-more-layer`）内部的点击事件。

虽然摄像头切换按钮使用了 `@click.stop` 等事件阻止指令，但 Android WebView 在合成事件时可能绕过这些阻止，导致：
1. 全局监听器被触发
2. 关闭了设备选择面板
3. 事件继续冒泡到会议界面，触发全屏切换

## 修复内容

### 文件: `src/components/CustomToolbar.vue`
**位置**: 第 579-580 行

**修改前**:
```typescript
// Android 的更多抽屉由遮罩层自行处理关闭，避免 WebView 合成 click 时被全局监听立即收起。
if (!inMenu && !inTrigger && !inDevicePop && !inDeviceCaret) {
  endMenuOpen.value = false
  devicePanel.value = null
}
```

**修改后**:
```typescript
// Android 的更多抽屉由遮罩层自行处理关闭，避免 WebView 合成 click 时被全局监听立即收起。
const inMobileMore = origin ? Boolean(origin.closest('.mobile-more-layer')) : false
if (!inMenu && !inTrigger && !inDevicePop && !inDeviceCaret && !inMobileMore) {
  endMenuOpen.value = false
  devicePanel.value = null
}
```

## 部署流程

### 1. 本地构建验证
- ✅ TypeScript 类型检查通过
- ✅ Vite 构建成功
- ✅ 代码语法检查通过

### 2. 服务器部署 (115.190.243.21)

#### 2.1 备份
```bash
备份位置: /opt/jitsi-app/jitsi-meet-web-package.bak.20260910_165915
```

#### 2.2 停止旧容器
```bash
docker stop jitsi-app-web-1
docker rm jitsi-app-web-1
```

#### 2.3 重新构建镜像
```bash
cd /opt/jitsi-app
docker compose build web
```

构建结果:
- 镜像ID: `f911cc76fefb`
- 镜像大小: 84.1MB (压缩: 25.9MB)
- 构建时间: ~2分钟

#### 2.4 启动新容器
```bash
docker compose up -d web
```

### 3. 部署验证

#### 容器状态
```
CONTAINER ID   IMAGE                  STATUS         PORTS
d2fa1b271fd8   jitsi-meet-web:local   Up 48 seconds  127.0.0.1:9000->80/tcp
```

#### 服务健康检查
- ✅ HTTP 响应: 302 (正常重定向)
- ✅ 响应时间: 0.002s
- ✅ 页面标题: "云会议 · CloudMeet"
- ✅ 静态资源加载正常

#### 系统资源
- 磁盘使用: 15G/40G (40%)
- 容器端口: 127.0.0.1:9000 -> 80

## 测试建议

### Android 端测试步骤
1. 打开视频会议
2. 点击"更多"按钮，打开更多设置界面
3. 在更多设置界面中点击"摄像头切换"按钮
4. **预期结果**: 仅切换摄像头，不触发全屏事件
5. 点击其他更多设置选项（麦克风、设备选择等）
6. **预期结果**: 仅执行对应功能，不触发全屏事件

### 回归测试
- [ ] 正常的全屏/退出全屏功能仍然可用
- [ ] 点击会议界面空白区域可以切换全屏
- [ ] 结束菜单的点击外部关闭功能正常
- [ ] 设备选择面板的点击外部关闭功能正常

## 回滚方案

如需回滚，执行以下命令：
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
- Docker Compose: `/opt/jitsi-app/docker-compose.yml`

## 下一步
1. 通知 QA 团队进行 Android 端测试
2. 监控生产环境日志，确认无新增异常
3. 收集用户反馈，验证修复效果
4. 如测试通过，删除备份镜像和旧版本文件
