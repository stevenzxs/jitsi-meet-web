# Room password setup verification

## Root cause reproduced

The deployed desktop page was exercised against the official public origin in an isolated browser context. No production files or server configuration were changed.

Test room 955226377 (milliseconds relative to iframe navigation):

- 4146.7: joined, moderator=false, locked=false.
- 4151.7: external API password command received, moderator=false.
- 4173.4: moderator=true, locked=false.

`JitsiConference.lock()` rejects non-moderators. The old joined handler sent only one host password command and did not verify success. Server ownership is granted asynchronously after online authorization. This reproduces the race rather than merely inferring it from source.

The reported room 251628236 also returned `get_password() ~= nil` = false in a read-only Prosody shell query. Password contents were not printed. This observation alone does not establish that room's earlier state.

## Fix

Guard host initialization until joined conference moderator authority is available. Send the password only while authorized, retry at most once per second while awaiting lock confirmation, stop after success or disposal, and report failure after 15 seconds. No Android notification suppression or server permission change.

## Local-build test

Only the test browser's `/cm/` asset requests were intercepted and served from the local production build, preserving the official iframe origin. This is not a deployment.

Test room 909239537:

- 5146.6: joined, moderator=false, locked=false.
- 5254.3: moderator=true, locked=false.
- 5357.0: password command received, moderator=true.
- 5535.2: locked=true.

Connected Android m66Pro entered through the native join form with the test room password. Read-only server inspection then confirmed password protection=true and three occupants: desktop moderator, focus, Android participant. A separate direct Jitsi guest without a password was blocked: passwordRequired=true, joined=false. No second password entry was performed on Android. The transient notification was not continuously recorded; absence throughout entry is not asserted solely from the final screenshot.

Android screenshot: `C:\Users\ZL\AppData\Local\Temp\opencode\lock-fixed.png`; UI dump: same directory `lock-fixed.xml`.

## Automated verification

- `node --test room-password.test.mjs`: 4/4 passed.
- `npm run build`: Vue type check and production build passed.
- Full `node --test *.test.mjs`: 124/127 passed; three failures in app-config.test.mjs and meeting-role.test.mjs also reproduce with HEAD JitsiFrame.vue supplied in memory. No baseline files were overwritten.
- `git diff --check`: passed.

## Electron retest

Development single-instance locking was subsequently disabled only when `app.isPackaged` is false in the Electron repository; packaged release locking remains unchanged. An isolated development Electron instance successfully ran alongside the existing user client, with an independent user/session directory.

Its browser context alone served the local web build through request interception; there was no server deployment. Electron created test room 545201936 and its actual Jitsi iframe reported joined=true, moderator=true, locked=true. Android entered via the native room/password form. A subsequent read-only Prosody inspection confirmed password protection=true and desktop moderator + focus + Android participant present. Screenshot: `C:\Users\ZL\AppData\Local\Temp\opencode\electron-debug-lock.png`.

Electron tests: `node --test scripts/*.test.cjs`, 90/90 passed, including development lock bypass and packaged-release lock enforcement. `node --check src/main.js` and `git diff --check` passed.

## Earlier limitation (resolved for development retest)

An isolated Electron launch was blocked by Chromium's Windows singleton lock. The existing user Electron process was not terminated. Actual Electron-binary end-to-end retest remains pending; the tested desktop page is the same web implementation but is not equivalent evidence for the Electron shell.

Changes are uncommitted and undeployed. Existing Android history-empty-state edits in D:\jm are unrelated and preserved.
