# Directed Recording Modes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Add persistent host-camera/shared-screen recording choices with isolated target microphone audio and layout-independent recording.

**Architecture:** Keep existing recording IPC/file/transcode pipeline. Replace frame capture with a dedicated stable Canvas/Web Audio output controlled by a same-origin Jitsi media adapter. Settings and recording locks must cover both native Electron and Web settings entry points.

**Tech Stack:** Vue 3, TypeScript, Electron, MediaRecorder, Canvas captureStream, Web Audio, Node assert, browser integration tests.

---

## Scope and safety

- Read `AGENTS.md` and Web `AGENTS.md`. Do not change the configured public Jitsi origin.
- Preserve existing unrelated typography edits in `PollingParticipantInfo.vue` and `scripts/test-polling-card.cjs`.
- No deployment, publishing, git commits or packaging unless separately requested. Keep work in current checkouts; no agent delegation without approval.
- Follow `2026-10-21-recording-modes-design.md` as the behavior contract.

### Task 1: Verify actual media contracts (read-only gate)

**状态：✅ 完成（2026-10-21）**。探针 `jitsi-meet-cfg/tests/recording-media-contract-probe.cjs`（一次性会议 + synthetic 设备，202 直链 BOSH；104 公网入口当日宕机），证据 `docs/evidence/recording-media-contract/contract-472182526.json`。实测契约已回填设计文档"Task 1 媒体契约实测记录"节：mic/desktop 音频按 `videoType` 分离、桌面视频条目 `mediaType='screenshare'`、停止共享 = 桌面轨道 `muted:true` 驻留、静音/关摄像头 = `muted:true`、mic 轨道身份跨共享稳定、camera 开关重建轨道。门禁结论：**严格麦克风隔离可保证**（按 videoType 判别），实施不阻塞。限制：业务 Prosody 转移模块未加载于当前视频栈，角色翻转实测不可达，转 Task 6 真实验收。

**Inspect:** Web `src/utils/pollingLayout.ts`, `src/components/MeetingStage.vue`; Jitsi iframe runtime `features/base/tracks`, participants, screen-sharing state and `jitsiTrack.getTrack/getOriginalStream/isAudioTrack/isVideoTrack/isMuted` APIs.

1. Inspect current recording tests and main/preload/renderer IPC boundaries.
2. Use a disposable meeting to inspect local and remote camera, microphone, desktop and desktop-audio entries. Use synthetic devices, not private meetings.
3. Verify whether screen sound and microphone are separate on the receiver. Verify how actual business host transfer maps to moderator state.
4. Record exact contract and fixtures in design doc; block implementation if strict microphone-only isolation cannot be guaranteed.
5. Capture role-transfer and screen-stop intermediate states to avoid treating transient replacement as end.

### Task 2: Persistent modes and settings contract

**状态：✅ 完成（2026-10-21）**。Electron 新增共享模块 `src/recording-settings.js`（UMD：main require / renderer `<script>` 双入口，单一实现），`mode: 'host-camera' | 'shared-screen'`（默认 host-camera，旧配置自动落入）贯通 main.js、renderer.js、index.html 录制设置面板（单选组）；Web `desktopSettings.ts` 增加 `mode` 字段与规范化，`DesktopHomeView.vue` 录制页签加单选组，`MeetingStage.vue` DesktopSettings 接口同步。测试先行：`node scripts/test-recording-settings.cjs` 两端通过（web 断言规范化全边界 + 保存载荷带 mode；electron 断言主进程/渲染层两种目录语义 + mode 边界 + 旧字段回归）。录制锁跨窗口禁用属 Task 5。

**Modify:** Electron `src/main.js`, `src/renderer.js`, `src/index.html`; Web `src/stores/desktopSettings.ts`, `src/views/DesktopHomeView.vue`, MeetingStage settings interface.
**Create tests:** Web `scripts/test-recording-settings.cjs`; Electron `scripts/test-recording-settings.cjs`.

1. Write failing tests: missing/unknown mode → host-camera; valid shared-screen survives read/save/broadcast; directory and recordAudioFile retained.
2. Run `node scripts/test-recording-settings.cjs` in each repository; verify intended failure.
3. Add `mode: 'host-camera' | 'shared-screen'` at all normalization boundaries, default host-camera.
4. Add labelled radio groups with explanatory text in both settings views. Preserve keyboard navigation and current theme.
5. Test normalization and restart persistence. Do not silently retain the old frame-capture mode.

### Task 3: Pure target selection and microphone isolation

**状态：✅ 完成（2026-10-21）**。新增 Web `src/utils/recordingSources.ts`：纯函数 `selectRecordingSource(snapshot, mode)`（host-camera 选 moderator 的 camera+mic；shared-screen 选活跃桌面轨道及其共享者的 mic，身份 `participantId:trackId`）+ `getModeratorParticipantId` + 同源 store 适配器 `createRecordingSourcesAdapter`（getState/subscribe，跨域返回 null 兜底）。契约严格按 Task 1 实测：麦克风 = `audio && videoType!=='desktop'`（0 条=无声合法，≥2 条=`ambiguous-mic` 拒绝）；桌面音频永不入选、不做混音/回采降级；共享停止 = 桌面轨道驻留 `muted:true`（`no-active-share`），多人活跃共享 = `ambiguous-share` 拒绝随机；`ended` 轨道视为缺席；本地参与者按 `local` 标记匹配。测试先行：`node scripts/test-recording-sources.cjs` 通过（12 组夹具：本地/远端主持、转移后目标切换、无主持、静音、关摄像头、共享+电脑声排除、无声不降级、停止驻留、接替换绑、多共享拒绝、双麦克风拒绝、ended 缺席）。

**Create:** Web `src/utils/recordingSources.ts`, `scripts/test-recording-sources.cjs`.

1. Write fixtures for local/remote host, host transfer, no host, muted audio, camera off, shared screen, shared audio exclusion, source ended and replacement.
2. Run `node scripts/test-recording-sources.cjs`; verify missing implementation failure.
3. Implement typed adapter with `getState/subscribe` access and a pure source selector. Return target ID, video/microphone tracks, mute flags, and share identity/end status.
4. Reject ambiguous or mixed audio; never use an audio element, loopback stream or aggregate conference stream as fallback.
5. Run selection tests; assert microphone audio stays associated with the chosen participant and local matching uses the local flag.

### Task 4: Stable media output engine

**状态：✅ 完成（2026-10-21）**。新增 Web `src/utils/directedRecording.ts`：固定 1920×1080 Canvas（黑底 contain 不裁切）+ AudioContext 单一 destination；输出流（canvas 视频轨 + destination 音频轨）在 start 时创建、源切换全程身份稳定；调度用 setInterval（非 rAF），可注入（`deps` 覆盖 video/AudioContext/canvas/MediaStream/scheduler，node 可测）；applySource 代次防护防迟到的 play() 回刷旧源；静音/缺席即黑屏+静音输出（destination 空输入=静音，永不接扬声器）；共享模式绑定首个活跃共享身份，身份变化（停止或换人）触发 `onShareEnded` 且仅一次；dispose 幂等、只停自建轨道/关 AudioContext/停调度，借用的 Jitsi 源轨道永不停止。测试先行：`node scripts/test-directed-recording.cjs` 通过（输出身份稳定、黑屏、仅目标 mic 连接、代次防护、共享结束一次、dispose 不动源轨道、启动阻断文案）。

**Create:** Web `src/utils/directedRecording.ts`, `scripts/test-directed-recording.cjs`.

1. Write failing lifecycle tests with fake owned/source tracks and injected scheduler: output identity stable on source switches; black when muted; reconnect only target audio; dispose never stops source tracks; screen-ended callback once.
2. Implement a fixed-size canvas output and AudioContext destination, hidden source video, contain drawing and black reset before switching sources. Never draw UI DOM.
3. Ensure output always has audio, even when target microphone starts missing; connect silence without using speakers to avoid echo.
4. Keep source replacement asynchronous operations generation-guarded, so late video play events cannot restore an old host.
5. Dispose own outputs, subscriptions, nodes and scheduling exactly once. Provide explicit startup/ended/error callbacks.
6. Run `node scripts/test-directed-recording.cjs` and browser media tests; verify recorded file is playable with continuous timestamps.

### Task 5: Integrate recording start/stop and cross-window setting lock

**状态：✅ 完成（2026-10-21，自动化部分）**。Web `MeetingStage.vue`：`startLocalRecording` 改为定向引擎路径（mode 来自设置→adapter.select→阻断文案→engine.start/applySource→recorders 挂输出流），保留分块/会话/转码协议；`getDisplayMedia`/`prepareDesktopRecordingCapture` 调用移除（壳侧 capture-prepare IPC 保留兼容）；store 订阅驱动引擎换源；`resetLocalRecordingState` 统一释放引擎+退订（停止/失败/离开/卸载全覆盖）；共享结束回调走既有保存路径（重入保护保证一次）。Electron：`recording-settings.js` 新增 `applyRecordingModeLock`（会话存在期间拒绝 mode 变更、其余设置照常，比较用规范化 mode）；`settings-save` 主进程边界强制；`desktop-settings-changed` 广播增加 `recordingActive`（向后兼容的第二参数/字段）；会话 start/finish/cancel 与会议窗口 closed 兜底均广播翻转锁；renderer 录制中单选禁用 + 模式被强制回退时提示「录制期间不可切换录制模式」；web 帧消息带 `recordingActive`（DesktopHomeView 可用）。测试：`node scripts/test-recording-integration.cjs`（启动阻断/静音换源不断流/共享停止+手动停止竞态仅一次 finish/回滚 cancel/源轨道零停止）与 electron `scripts/test-recording-lock.cjs`（锁语义 5 组 + main/renderer 接线断言）通过；全部既有录制/轮询回归通过。剩余：Task 6 真实 Electron 验收。

**Modify:** Web `src/components/MeetingStage.vue`; Electron `src/main.js`, `src/preload.js`, `src/renderer.js`; Web desktop settings store and view.
**Create:** Web `scripts/test-recording-integration.cjs`; Electron `scripts/test-recording-lock.cjs`.

1. Test mode-based startup, unavailable target errors, startup rollback, manual stop vs automatic stop races, file write completion, no source-track stop.
2. Replace `prepareDesktopRecordingCapture/getDisplayMedia` path for these modes with directed engine; retain existing chunk/session/transcode logic.
3. Store engine separately from output stream; dispose on failure, stop and component teardown. Shared source ended calls existing save path once.
4. Lock mode at main-process recording-session boundary and broadcast active recording status to both settings surfaces. Renderer-only disabled controls are insufficient across windows.
5. Unlock on finish/cancel/window close, reject mode mutation while any recording session is active, continue allowing unrelated settings changes.
6. Run integration and lock tests, then all pre-existing recording regression tests. Keep old bridge compatibility only where needed; do not broaden IPC permissions.

### Task 6: Verification and delivery

**状态：✅ 完成并关闭（用户手动验收确认）**。用户最终反馈“已手动验证，都标记完成”，剩余真实双端媒体、主持权交接、共享音频隔离、最小化/长时及完整录制行为均按用户手动验收通过关闭。自动化证据及此前失败记录保持原样，不视为自动化全通过。Electron最终交付为out下r4安装包与免安装ZIP；详情见工作区`docs/recording-release-acceptance-20261021.md`最终结论。

1. Run all added tests and existing polling/recording tests with fail-fast exit handling.
2. Run Web `npm run build` and `npm run check:webview-syntax`; run Electron JS syntax checks.
3. Browser integration: use synthetic red/blue host videos and distinct sine-wave microphones plus a third screen-audio frequency. Verify decoded recording pixels/frequencies prove correct source isolation, black continuation, and stable output across transfer.
4. Real Electron acceptance: camera off/on; host transfer; local vs remote targets; shared-stop saves; manual stop races; minimized recording; independent audio file; no UI overlay in recorded pixels.
5. Report what is automated versus manually verified. Do not claim audio isolation on real Jitsi from mocks alone.
6. No deployment/package release without authorization; if requested later, follow Web public-origin and service-isolation deployment gates.
