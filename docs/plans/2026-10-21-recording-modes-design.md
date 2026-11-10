# Electron 定向媒体录制设计

## 已确认需求

- 设置 → 录制增加持久化单选模式：`host-camera`（录制主持人视频）、`shared-screen`（录制共享屏幕）。旧配置默认 `host-camera`。
- 录制主持人模式：只采集当前主持人的摄像头与麦克风。角色转移自动切换来源，同一文件继续；关摄像头保持黑屏录制，开摄像头恢复。
- 共享模式：只采集会议中已经共享的屏幕及共享者麦克风，排除共享电脑声音。共享结束自动停止并保存，不接续下一次共享。
- 不采集界面、姓名、标识、弹窗；与当前布局、可见成员、轮询状态无关。
- 静音必须遵循会议状态；不主动申请额外麦克风权限，不绕过静音。
- 保留目录、独立音频文件、分块写入与转码。独立音频文件使用同一目标麦克风音源。
- 录制期间禁用模式切换，停止后可修改。

## 现有结构

- Web `src/components/MeetingStage.vue` 使用 getDisplayMedia 与 MediaRecorder，负责分块和保存协议。
- Electron `src/main.js` 授权捕获会议 frame，并处理文件写入、设置持久化和转码。
- Electron `src/index.html` / `src/renderer.js` 有原生设置；Web `src/views/DesktopHomeView.vue` 另有桌面设置入口，两处必须一致。
- Web `src/stores/desktopSettings.ts` 与 main.js / renderer.js 各自规范化设置，新增模式必须贯通全部边界。

## 方案选择

1. 推荐：固定尺寸 Canvas 视频输出 + Web Audio 固定目标音频输出。仅替换输入，保持 MediaRecorder 输入轨道稳定。
2. 不选：直接把原始视频/音频轨道交给 MediaRecorder 并动态增删。摄像头重建和角色切换容易导致录制失败。
3. 不选：继续捕获会议 frame。无法可靠排除布局与弹窗，也无法保证音频仅来自指定成员。

## 模块与生命周期

- 独立媒体适配器读取同源 iframe store，严格区分 camera、desktop 和 microphone，避免选择混音或桌面音频。
- 固定画布黑底、contain 不裁切，建议 1920×1080 / 30fps；声音通过单一 AudioContext destination 输出；无目标音频时输出静音。
- 以 store 变化刷新目标并额外监听 track ended。主持人模式每次重算角色，先断开旧音频，再接新来源。
- 共享模式启动时绑定具体共享源身份；不能因下一位共享者接替而悄悄续录。瞬态轨道替换与真实结束须结合共享状态辨别。
- 选择器不可无声降级到会议混音。若当前 Jitsi 将共享音频和麦克风合并且不能分离，必须明确报错或阻止有风险的音频输入，并在实施前验证能力。
- 不停止借用的 Jitsi 源轨道，只释放自己创建的输出轨道、连接、定时器、订阅及 video 元素。
- 窗口最小化时仍需验证绘制调度不被节流；不能仅以 requestAnimationFrame 循环作为验收依据。

## 错误与边界

- 无主持人或共享：阻止开始并显示明确提示；主持人存在但关摄像头允许黑屏开始。
- 录制中暂时无主持人：黑屏静音继续，不切换到任意普通成员。
- 多主持人：沿用会议已定义的主持人判定；若多个 moderator 与业务主持人不一致，需核实权威来源，不另造规则。
- 多共享：跟随当前会议确定的共享源；若不存在唯一来源，提示选择或拒绝启动，不能随机选取。
- 共享停止触发一次保存；离会、手动停止、轨道结束同时发生时必须幂等。

## 验收

本地/远端主持人、角色交接、摄像头开关、麦克风静音/恢复、共享停止、共享者离会、布局切换、最小化、长时录制、转码失败保留原文件；用不同频率音源证明其他成员和共享电脑声音不被录入。

本设计确认不包含服务器部署、提交推送或安装包发布；后续按用户授权执行。

## Task 1 媒体契约实测记录（2026-10-21，一次性会议 + synthetic 设备）

探针：`jitsi-meet-cfg/tests/recording-media-contract-probe.cjs`；证据：`docs/evidence/recording-media-contract/contract-*.json`（202 直链，104 公网入口当日宕机；探测把 iframe 内联 config 的 ws/bosh 改指 202 BOSH，因宿主 Nginx 无 WS Upgrade）。

**接收端轨道模型（`features/base/tracks` 条目，全部实测确认）：**

| 轨道 | mediaType | videoType | jitsiTrack.getType() | jitsiTrack.getVideoType() |
|---|---|---|---|---|
| 麦克风音频（本地/远端） | `audio` | `null` | `audio` | `null` |
| 摄像头视频 | `video` | `camera` | `video` | `camera` |
| 桌面视频（远端） | **`screenshare`** | `desktop` | `video` | `desktop` |
| 桌面音频（若存在） | `audio` | `desktop`（按同模型推断，本环境未出现） | `audio` | `desktop` |

- **麦克风与共享声音在接收端天然分离**：按 `videoType` 判别，桌面音频永远不会与麦克风混淆。适配器选麦克风 = `mediaType==='audio' && videoType!=='desktop'`；选桌面视频 = `videoType==='desktop'`（勿用 mediaType，桌面视频条目是 `screenshare`）。同机制已被 `pollingLayout.getParticipantCameraTrack` 生产验证。
- **静音/关摄像头语义**：远端成员静音 → 其 mic 轨道 `muted:true`（会议状态直读，录制须遵循）；关摄像头 → camera 轨道 `muted:true`（轨道保留，不删除）；开摄像头恢复 `muted:false`。黑屏契约 = 目标 camera 轨道 `muted:true` 或缺席。
- **共享停止信号**：远端桌面轨道**不消失**，变 `muted:true` 并驻留 store；`active` 共享 = 存在 `videoType==='desktop' && muted!==true` 的轨道。停止事件须结合该信号 + track `ended` 判别，不能等条目消失。
- **轨道身份稳定性**：成员 mic 轨道 `trackId` 在共享开始/停止全程不变；camera 开关会重建 camera 轨道（新 `trackId`，`-0-N` 递增），mic 不受影响。
- **共享伴随音频**：本环境 `toggleShareScreen` 共享未携带桌面音频（成员本地仅出现桌面视频轨道，无本地桌面音频轨道）；但原始 `getDisplayMedia({audio:true})` 在本环境可返回桌面音频轨（`audioTracks:1`）。适配器必须按 `videoType==='desktop'` 排除，且"不排除"不得静默降级为会议混音。
- **环境限制**：业务 Prosody `urn:cloudmeet:host-control:1` 模块未加载于当前共享视频栈（transfer IQ 回 `service-unavailable`），角色翻转的实测在本探针不可达；角色权威源仍为 `features/base/participants` 的 `role`（与轮询布局同一依赖，已生产验证）。角色翻转时的轨道稳定性改在 Task 6 真实 Electron 验收（业务转移已部署的环境）补齐。
- **测试环境注意**：headless fake 设备偶发 gUM 失败（`gum.not_found`）与创建者幽灵会话（需优雅离开后置）；探针已内置重试。
