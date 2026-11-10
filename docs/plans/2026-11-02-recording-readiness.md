# Independent Recording Readiness Implementation Plan

**Goal:** Start ready selected outputs immediately; wait for unavailable sources and create a new file for each later share.

**Architecture:** Add a source-aware recording coordinator around existing per-output jobs. Keep the recording action armed until explicit stop, even while every selected output is waiting. Preserve Canvas engines, disk sessions and source ownership.

**Approved behavior:** At least one selected mode must be ready at the initial click. Other selected modes wait without creating files. Ending or replacing a share saves its shared-screen/composite files; a new share creates new files. Host-camera output remains continuous. Stop, permission revocation and leaving cancel subscriptions and waiting outputs.

**Tech Stack:** Vue, TypeScript, Jitsi Redux subscriptions, MediaRecorder, node:test.

## Task 1 — Coordinator (test first)
- Create `src/utils/scheduledRecordingGroup.ts` and `tests/scheduled-recording-group.test.mjs`.
- Run `node --test tests/scheduled-recording-group.test.mjs` before implementation and observe failures.
- Cover partial readiness, repeated notifications, share end/restart/replacement, independent failure, waiting-only stop, and stop racing startup.
- Serialize transitions; never overlap files for one mode; cancel a partially started job on stop/failure; dispose all owned jobs.

## Task 2 — Meeting integration
- Update `src/components/MeetingStage.vue` to use the coordinator.
- Replace all-mode preflight with at-least-one-ready preflight. Use a stable key for host and share identity for share-dependent outputs.
- Subscribe once for waiting outputs; retain per-output source updates. Report started and waiting counts without claiming waiting files already exist.
- Keep the record button active while armed, so stop cancels waiting work.

## Task 3 — Verification
- Run coordinator tests, `node scripts/test-multi-recording.cjs`, directed-recording tests and both fullscreen regressions.
- Run `npm run build` and `git diff --check`.
- No push or deployment without a new explicit request. Real Electron acceptance: host-only start, first share, end share, second share, explicit stop, then another share must not record.
