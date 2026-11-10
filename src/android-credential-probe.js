// Non-sensitive transport capability probe only. No credential access.
(function () {
  if (new URLSearchParams(window.location.search).get('credentialBridge') === '1') return;
  if (new URLSearchParams(window.location.search).get('android') !== '1'
      || window.parent === window) return;
  const match = /^\/cm\/desktop\/meeting\/([0-9]{9})$/.exec(window.location.pathname);
  if (!match) return;
  const room = match[1];
  let port = null;
  let closed = false;
  window.addEventListener('message', function (event) {
    const data = event.data;
    if (closed || port || event.source !== window.parent || event.origin !== 'null'
        || !data || data.type !== 'cloudmeet-credential-connect' || data.version !== 1
        || data.room !== room || typeof data.channelId !== 'string'
        || !event.ports || event.ports.length !== 1) return;
    port = event.ports[0];
    port.start();
    port.postMessage({ type: 'probe', version: 1, room: room,
      channelId: data.channelId, sequence: 1 });
  });
  window.addEventListener('pagehide', function () {
    closed = true;
    if (port) port.close();
  });
  window.parent.postMessage({ type: 'cloudmeet-credential-ready', version: 1,
    room: room, path: window.location.pathname }, '*');
})();
