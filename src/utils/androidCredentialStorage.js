const CREDENTIALS = 'jitsi-meet-credentials-v1';
const CREATOR = 'jitsi-meet-creator-recovery-v1';
const PENDING = 'jitsi-meet-pending-host-transfer-v1';
const SCHEDULED = 'jitsi-meet-scheduled-v1';

function readMap(storage, key) {
  const value = JSON.parse(storage.getItem(key) ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credential storage');
  return value;
}

/** Storage acknowledgement only, never proof of server authority.
 * Conflicts require reconciliation, not overwriting a possibly newer key.
 * On partial failure retain saved data for an idempotent retry; never ack.
 */
export function acceptNativeCredentials(storage, room, payload) {
  const failed = { ok: false };
  if (typeof room !== 'string' || !/^\d{9}$/.test(room) || !payload || payload.room !== room
      || typeof payload.creatorRecoveryKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.creatorRecoveryKey)
      || typeof payload.hostKey !== 'string' || payload.hostKey.length > 128
      || !['active', 'pending', 'revoked'].includes(payload.hostState ?? 'active')
      || (payload.hostState !== 'revoked' && !payload.hostKey)
      || (payload.hostState === 'revoked' && payload.hostKey)
      || typeof payload.password !== 'string' || payload.password.length > 128) return failed;
  try {
    const credentials = readMap(storage, CREDENTIALS);
    const creators = readMap(storage, CREATOR);
    const pending = readMap(storage, PENDING);
    const scheduled = JSON.parse(storage.getItem(SCHEDULED) ?? '[]');
    const receipt = pending[room];
    const validPending = receipt && /^[A-Za-z0-9_-]{1,64}$/.test(receipt.operationId)
      && typeof receipt.hostKey === 'string' && receipt.hostKey.length > 0
      && receipt.hostKey.length <= 128 && Number.isFinite(receipt.expiresAt);
    const pendingReopen = payload.hostState === 'pending' && validPending
      && receipt.hostKey === payload.hostKey;
    const pendingAdvance = payload.hostState === 'active' && validPending
      && pending[room].hostKey !== payload.hostKey
      && credentials[room]?.hostKey === payload.hostKey;
    const revokedReopen = payload.hostState === 'revoked' && credentials[room]?.hostKey === ''
      && !Object.hasOwn(pending, room);
    const revokedReconcile = payload.hostState === 'active' && !!payload.hostKey
      && credentials[room]?.hostKey === '' && !Object.hasOwn(pending, room)
      && Array.isArray(scheduled) && scheduled.every(item => item?.roomName !== room || item.hostKey === '');
    if (!Array.isArray(scheduled) || (Object.hasOwn(pending, room) && !pendingReopen && !pendingAdvance)
        || (Object.hasOwn(creators, room) && creators[room] !== payload.creatorRecoveryKey)
        || (!pendingReopen && !pendingAdvance && !revokedReopen && !revokedReconcile && Object.hasOwn(credentials, room) && (credentials[room]?.hostKey !== payload.hostKey
          || credentials[room]?.password !== payload.password))
        || (!pendingReopen && !revokedReopen && !revokedReconcile && scheduled.some(item => item?.roomName === room && item.hostKey !== payload.hostKey))
        || (payload.hostState === 'pending' && !pendingReopen)
        || (payload.hostState === 'revoked' && !revokedReopen)) return failed;
    // Persist the independent recovery capability first. A host write failure
    // must not lose the only lawful way to reconcile server-side authority.
    creators[room] = payload.creatorRecoveryKey;
    storage.setItem(CREATOR, JSON.stringify(creators));
    if (readMap(storage, CREATOR)[room] !== payload.creatorRecoveryKey) return failed;
    if (!pendingReopen && !pendingAdvance && !revokedReopen && !revokedReconcile) {
      credentials[room] = { hostKey: payload.hostKey, password: payload.password };
      storage.setItem(CREDENTIALS, JSON.stringify(credentials));
    }
    const saved = readMap(storage, CREDENTIALS)[room];
    const savedPending = readMap(storage, PENDING)[room];
    return { ok: pendingReopen ? savedPending?.hostKey === payload.hostKey
      : pendingAdvance ? savedPending?.hostKey === pending[room].hostKey && saved?.hostKey === payload.hostKey
      : revokedReopen || revokedReconcile ? saved?.hostKey === ''
      : saved?.hostKey === payload.hostKey && saved?.password === payload.password,
    hostKey: pendingAdvance ? pending[room].hostKey
      : revokedReopen || revokedReconcile ? '' : payload.hostKey };
  } catch {
    return failed;
  }
}
