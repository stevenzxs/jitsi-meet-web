# Desktop invitation preview

**Goal:** Replace automatic copying from the in-meeting desktop Invite action with a dialog preview and explicit Copy all information button.

**Approved design:** Reuse buildInviteText as the single source for preview and clipboard. Display selectable plain text, close control, and footer action labelled 复制全部信息. Keep host-only access and the web invite event unchanged. Never include host keys. Report clipboard failure truthfully. No deployment or push in this task.

**Implementation:** Add a focused DesktopInviteDialog component using a native modal dialog (focus containment, Escape, focus restoration). Mount it only while open. Wire MeetingStage's desktop action to open it. Keep homepage copy actions untouched. Add tested clipboard fallback logic; fallback must check execCommand's boolean and always remove temporary DOM.

**Verification:** Run failing regression tests first, implement, rerun targeted tests and build. Browser-check dialog preview, exact copied text, close/Escape, and failure state without joining or altering user meetings.
