import { createAndroidCredentialEndpoint } from './androidCredentialEndpoint.js';
import { acceptNativeCredentials } from './androidCredentialStorage.js';

/** Bootstrap readiness is not host authority; MeetingStage still verifies JWT. */
export function createAndroidCredentialGate(options) {
  let closed = false;
  let ready = false;
  const endpoint = createAndroidCredentialEndpoint({ parent: options.parent, room: options.room,
    accept(payload) {
      if (closed || ready || typeof payload.displayName !== 'string' || !payload.displayName.trim()
          || payload.displayName.length > 256 || typeof payload.subject !== 'string'
          || (payload.endTime !== undefined && (!Number.isSafeInteger(payload.endTime) || payload.endTime <= 0))) return { ok: false };
      const existing = options.getSession(options.room);
      if (existing && existing.hostKey !== payload.hostKey) {
        try {
          const credentials = JSON.parse(options.storage.getItem('jitsi-meet-credentials-v1') ?? '{}');
          if (existing.hostKey !== credentials[options.room]?.hostKey
              || (payload.hostState !== 'pending' && existing.hostKey !== '')) return { ok: false };
        } catch { return { ok: false }; }
      }
      const accepted = acceptNativeCredentials(options.storage, options.room, payload);
      if (!accepted.ok) return { ok: false };
      const effectiveHostKey = accepted.hostKey;
      const session = { roomName: options.room, subject: payload.subject, password: payload.password,
        displayName: payload.displayName.trim(), createdAt: Date.now(), host: !!effectiveHostKey,
        hostKey: effectiveHostKey,
        ...(payload.endTime ? { endTime: payload.endTime } : {}) };
      options.saveSession(session);
      const saved = options.getSession(options.room);
      if (!saved || saved.hostKey !== session.hostKey || saved.password !== session.password
          || saved.displayName !== session.displayName || saved.endTime !== session.endTime) return { ok: false };
      ready = true;
      cancelTimeout();
      options.onState('ready', payload.hostKey);
      return { ok: true };
    },
  });
  const unlisten = options.listen(event => endpoint.connect(event));
  function close() {
    if (closed) return;
    closed = true;
    endpoint.close();
    unlisten();
    cancelTimeout();
  }
  const cancelTimeout = options.schedule(() => {
    if (closed || ready) return;
    close();
    options.onState('error');
  });
  options.onState('waiting');
  options.parent.postMessage({ type: 'cloudmeet-credential-ready', version: 1,
    room: options.room, path: options.path }, '*');
  return { close, sync(state) { if (!closed && ready) return endpoint.send({ ...state, type: 'credential-state' }); return false; } };
}
