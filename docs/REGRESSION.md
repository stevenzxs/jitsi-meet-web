# 回归测试入口与覆盖清单

## 每次迭代必须运行

```sh
npm ci
npm run verify
```

`npm test` 自动收集根目录、scripts/、tests/ 中的 `*.test.mjs`、`*.test.cjs` 和 `test-*.cjs`。新用例放在这些目录，遵循名称约定，不要只运行当前修改文件的测试。`verify` 在用例通过后执行 TypeScript/Vite 构建和全部产出 JS 的 WebView 83 语法检查。命令失败即不得称为回归通过，不以构建通过代替测试通过。CI 可在安装依赖后直接调用此命令；本仓库尚未接入真实 CI 服务。

Node test runner 将部分旧脚本按“文件”计数，其他用例按 test() 计数，故汇总数字不是用户行为或覆盖率百分比。

## 2026-11-07 审计及补齐

| 领域 | 已有/新增自动化证据 | 层级与限制 |
| --- | --- | --- |
| origin、API 前缀、协议 | app-config.test.mjs、scripts/app-config.test.mjs | 执行真实配置函数；外网 TLS 需集成验收 |
| 入会凭据、密码、Android 入口 | meeting-credentials、room-password、desktop-invite、tests/android-credential-* | 函数、事件、存储边界；不是实际 Android 安装测试 |
| 主持人权限、转让/收回、降权 | meeting-role、host-transfer-client、tests/seamless-host-transfer、host-media-permissions | 实际函数与异步状态；Prosody 实际角色仍需多端 |
| 全屏/尺寸/宫格 | scripts/test-main-video-resize、test-fullscreen-main-video、tests/window-resize-lifecycle、strict-grid-dimensions、polling-fullscreen-styles | 新增旧尺寸释放、成员栏扣除、默认分支执行、六轮往返、旧 timer 取消、隐藏/销毁边界；CSS 静态断言不是视觉验收 |
| 轮询 | scripts/test-polling-* | 修复缺失的权限上下文，增加降权后不可改组/通知壳；真实视频切换另验 |
| 会标、主题、视频画面定位 | meeting-banner-sync、toolbar-styles、video-picture-rect | 状态/几何算法及样式约束；视觉布局另验 |
| 录制、共享、权限丢失 | scripts/test-*recording*、tests/scheduled-recording-group、host-media-permissions | 异步生命周期、等待/取消/保存失败/多输出；浏览器实际编码和文件播放另验 |
| 断线、重连提示、设备反馈 | signal-loss、device-feedback、recording-feedback | 状态及事件；不证明网络恢复和媒体可达 |

### 断线恢复合同（115 实机诊断补充）

`signal-loss.test.mjs` 与 `tests/signal-resume-frame.test.cjs` 现包含 XMPP stream resume 超过8秒不退会、恢复成功、重试耗尽后重新计算终态宽限、缺token/旧版本兼容、Frame实际函数集成及旧API/离会/销毁回调保护。不能只用底层 `connected=false` 判断最终退会：stable-11146-2 的 getter 在WebSocket关闭时立即false，但 `_resumeTask.retryCount` 1–3且持有smacks token时仍在恢复（含等待网络在线）。还有已CONNECTED/ATTACHED、socket进入CLOSING/CLOSED而Strophe未回调的握手阶段，此时retryCount仍0也必须保留会话；超过3次或无token才回归原有持续断开判定。此版本适配必须随上游变更重新核对，不能将恢复中变成无限自动创建新会话。

完整基线有 4 个失败：旧 origin 测试仍以 104 为配置入口、降权测试仍要求重载（与无缝转让相冲突）、Jitsi 菜单测试缺常量且仍期待不注册菜单、轮询测试缺权限函数。逐一核对生产代码与现有专项测试后修正测试，未为通过测试改变业务行为。后续不得删除这类安全/状态断言，应同步行为合同。

## 发布前必须补做的真实集成/人工用例

1. 同源页面加载新资源；右侧成员→宫格→右侧成员；窗口/最大化/全屏各往返至少 6 轮，校验真实 video 边界和 Jitsi preferred 尺寸，无留白、无宫格闪屏。
2. 至少两端主持人转让/收回，转让不重连，源端立即丧失会标、录制、主持人操作权限；旧事件不能恢复权限。
3. 三端或关闭 P2P 验证 JVB 双向音视频、共享切换、退出/重连及断网恢复。
4. 录制启动/保存/权限丢失/共享结束、多输出独立文件，实际播放；设备拒绝授权有明确反馈。
5. Android 真实 WebView 旋转、全屏、证书和入会；语法通过不等于设备兼容。

这批新增的是离线行为回归，不宣称完整 Vue DOM 挂载、浏览器 E2E、视觉截图自动比对或真实媒体覆盖。上述缺口未被标为“已自动化”。测试报告应分别列自动化/实机通过、失败和未验证。
