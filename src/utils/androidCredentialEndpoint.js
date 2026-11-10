/** Private port receiver. The public window message carries no credentials.
 * Caller must bind lifecycle to the current verified meeting navigation.
 * A storage ack deliberately does not assert ACTIVE server authority.
 */
export function createAndroidCredentialEndpoint(options) {
  let port = null;
  let closed = false;
  let received = 0;
  let sent = 0;
  let channelId = '';
  return {
    connect(event) {
      const data = event.data;
      if (closed || port || event.source !== options.parent || event.origin !== 'null'
          || !data || data.type !== 'cloudmeet-credential-connect' || data.version !== 1
          || data.room !== options.room || typeof data.channelId !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}$/.test(data.channelId)
          || !event.ports || event.ports.length !== 1) return false;
      channelId = data.channelId;
      port = event.ports[0];
      port.onmessage = function (message) {
        const payload = message.data;
        if (closed || !payload || payload.version !== 1 || payload.room !== options.room
            || payload.channelId !== channelId || payload.type !== 'bootstrap'
            || !Number.isSafeInteger(payload.sequence) || payload.sequence <= received) return;
        received = payload.sequence;
        let ok = false;
        try { ok = options.accept(payload)?.ok === true; } catch { /* No secret diagnostics on wire. */ }
        port.postMessage({ type: 'bootstrap-ack', ok, version: 1, room: options.room,
          channelId, sequence: ++sent });
      };
      port.start();
      return true;
    },
    send(payload) {
      if (closed || !port) return false;
      port.postMessage({ ...payload, version: 1, room: options.room, channelId, sequence: ++sent });
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      if (port) {
        port.onmessage = null;
        port.close();
      }
    },
  };
}
