# Multi-output recording implementation plan

**Goal:** 三种可多选录制输出（主持人、共享屏幕、共享为主且主持人右下角小窗的合成），共享工具栏录屏仅主持人可见。

**Architecture:** modes 数组为新配置，兼容旧 mode；每种输出独立引擎、MediaRecorder、磁盘会话和转码，由任务组统一开始/停止。合成使用固定 Canvas，麦克风混音按参与者去重，不录电脑共享音频。共享结束只停止依赖共享的输出。

**Tech Stack:** Electron、Vue/TypeScript、Canvas、Web Audio、MediaRecorder、Node test runner。

## Scope / constraints

- 修改 Electron 设置/文件名/共享悬浮栏及 Web 录制运行时与对应测试。
- 不更改服务器地址、证书、VPN，不部署、不打包安装器，不覆盖其他工作。
- 旧设置保留之前单选；新设置不可为空；录制期间锁定模式集合。
- 开始前检查全部选中输出的源；缺少共享则明确提示，避免默默少录。共享结束保存共享与合成，主持人输出继续。
- 不允许权限失效期间继续启动；撤销主持权保存全部已启动输出。每路保存、失败、转码均隔离。

## Steps

1. 为配置多选、旧值兼容、集合锁及悬浮栏权限添加失败测试，完成 Electron/Web 配置和复选框。
2. 为合成画布、音频去重和资源释放添加失败测试；扩展定向引擎，保持借用轨道不被停止。
3. 为多路任务生命周期添加失败测试，实现独立写入/停止/清理；MeetingStage 接入统一任务组；Electron 文件名加入模式。
4. 运行录制测试、权限测试、Electron VPN/设置回归、Web build、git diff --check；记录未执行的真实会议验证。

## Verification

`node --test scripts/*recording*.cjs tests/host-media-permissions.test.cjs` (Web)

`node --test scripts/*recording*.cjs` and `npm run test:vpn` (Electron)

`npm run build` (Web), `node --check src/renderer.js` (Electron).

## Checkpoint

2026-10-27：用户已确认三种独立输出和主持人权限方案；采用已推荐的右下角小窗。两仓库开始时均干净。当前仅源码执行，最终以新验证结果为准。

实现完成：配置新增 modes 数组，保留 legacy mode；录制引擎支持合成/去重混音，任务组隔离各输出；两套设置界面改复选框；主进程输出模式文件名；共享悬浮栏缺少权限时 hidden 并有明确 CSS，初始也隐藏。

验证：Web 录制/反馈/权限测试 22 项通过，`npm run build` 通过；Electron 录制/设置回归 12 项通过（含真实 FFmpeg 转码和播放解码）；VPN 51 项通过；两仓库 diff --check 通过。修正了旧启动测试缺少离线入口桩、旧共享桥测试缺少主持权限桩的问题。

尚未执行：真实双端会议下的三路长时间录制、CPU/磁盘压力、麦克风听感和可视布局验收；未部署 Web，未打包安装器，未提交 git。后续上线必须同时更新 Web 和 Electron，沿用 AGENTS.md 的 118 来源/证书约束。
