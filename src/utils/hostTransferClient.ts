import type { JitsiMeetExternalAPI } from '../types/jitsi'
import { getJoinedModeratorConference, getParticipantRole } from './meetingPermissions'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { clearPendingHostTransfer, clearTransferredHostKey, getCreatorRecoveryKey, getPendingHostTransfer, saveMeetingCredentials,
  savePendingHostTransfer, saveSession, getSession, type PendingHostTransfer } from '../stores/meeting'

const NS = 'urn:cloudmeet:host-control:1'
const RETRY_MS = 5000
export const HOST_TRANSFER_MENU_ID = 'cloudmeet-transfer-host'

const reclaimRequests = new WeakMap<object, { room: string; session: string; operation: string; at: number; busy: boolean }>()

export function canReclaimHost(api: JitsiMeetExternalAPI, room: string, confirmedHost: boolean): boolean {
  return !confirmedHost && Boolean(getCreatorRecoveryKey(room)) && Boolean(transport(api, room))
}

/** Keep uncertain operations in memory for this exact connection only. The creator
 * capability is read afresh, never copied into retry storage or error messages. */
export async function requestHostReclaim(api: JitsiMeetExternalAPI, room: string): Promise<string> {
  const live = transport(api, room)
  const credential = getCreatorRecoveryKey(room)
  if (!live || !credential) throw new Error('创建者凭据或当前会议连接不可用')
  let request = reclaimRequests.get(live.connection)
  if (request?.busy) throw new Error('收回请求正在处理中')
  if (!request || request.room !== room || request.session !== live.connection.jid || Date.now() - request.at >= 300000) {
    request = { room, session: live.connection.jid, operation: `reclaim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
      at: Date.now(), busy: false }
    reclaimRequests.set(live.connection, request)
  }
  request.busy = true
  try {
    const reply = await iqRequest(live.connection, live.doc, live.roomJid, 'reclaim',
      { operationId: request.operation, creatorCredential: credential })
    if (transport(api, room)?.connection !== live.connection || live.connection.jid !== request.session
        || reply.getAttribute('from') !== live.roomJid
        || child(reply, 'reclaim')?.getAttribute('operationId') !== request.operation
        || child(reply, 'reclaim')?.getAttribute('state') !== 'roles-committed') {
      throw new Error('收回结果尚未核实，请稍后重试')
    }
    // First credential delivery may have preceded listener installation or failed
    // to persist. Exact live owner claim redelivers; this IQ is not completion.
    void iqRequest(live.connection, live.doc, live.roomJid, 'claim', {}).catch(() => {})
    return request.operation
  } finally { request.busy = false }
}

type StropheConnection = {
  connected: boolean
  jid: string
  addHandler(handler: (stanza: Element) => boolean, ns?: string | null, name?: string | null): unknown
  deleteHandler(handler: unknown): void
  sendIQ(stanza: Element, success: (stanza: Element) => void,
    error: (stanza: Element | null) => void, timeout?: number): void
}

function child(stanza: Element, name: string): Element | null {
  return Array.from(stanza.children).find(item => item.localName === name && item.namespaceURI === NS) ?? null
}

function makeIq(doc: Document, roomJid: string, from: string, name: string, attributes: Record<string, string>): Element {
  const iq = doc.createElementNS('jabber:client', 'iq')
  // Strophe's serializer reads explicit attributes, not DOM namespaceURI.
  iq.setAttribute('xmlns', 'jabber:client')
  iq.setAttribute('to', roomJid)
  iq.setAttribute('from', from)
  iq.setAttribute('type', 'set')
  const command = doc.createElementNS(NS, name)
  command.setAttribute('xmlns', NS)
  for (const [key, value] of Object.entries(attributes)) command.setAttribute(key, value)
  iq.appendChild(command)
  return iq
}

// Never echo stanza XML/text: an error may contain the original credential IQ.
function hostTransferRequestError(stanza: Element | null): Error {
  if (!stanza) return new Error('主持权限请求超时，结果尚未确认，请保留当前页面并检查会议状态')
  const error = Array.from(stanza.children).find(item => item.localName === 'error')
  const condition = Array.from(error?.children ?? []).find(item =>
    item.namespaceURI === 'urn:ietf:params:xml:ns:xmpp-stanzas' && item.localName !== 'text')?.localName
  const messages: Record<string, string> = {
    'service-unavailable': '当前会议服务未启用主持人转让，请联系管理员',
    'not-allowed': '当前会话无权执行此主持权限操作',
    'forbidden': '当前会话无权执行此主持权限操作',
    'conflict': '主持权限状态冲突，请检查成员和待确认操作后重试',
    'remote-server-timeout': '主持权限内部服务暂不可用，结果尚未确认，请勿重复创建操作',
    'resource-constraint': '主持权限服务繁忙，请稍后重试',
  }
  return new Error((condition && messages[condition]) || '主持权限请求失败，结果尚未确认，请检查会议状态')
}

function iqRequest(connection: StropheConnection, doc: Document, roomJid: string,
  name: string, attributes: Record<string, string>): Promise<Element> {
  return new Promise((resolve, reject) => {
    try {
      connection.sendIQ(makeIq(doc, roomJid, connection.jid, name, attributes), resolve,
        stanza => reject(hostTransferRequestError(stanza)), 10000)
    } catch (error) { reject(error) }
  })
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function makeHostTransferProof(key: string, room: string, operation: string,
  target: string, expectedInstance: string, instance: string, nonce: string): Promise<string> {
  const encoder = new TextEncoder()
  const message = ['host-transfer-rebind-v1', room, operation, target,
    expectedInstance, instance, nonce].join('\n')
  return base64url(hmac(sha256, encoder.encode(key), encoder.encode(message)))
}

/** The menu supplies only a participant ID. Resolve its current MUC occupant
 * from Jitsi's live room before asking Prosody to transfer authority. */
export async function requestHostTransfer(api: JitsiMeetExternalAPI, roomName: string,
  participantId: string): Promise<string> {
  const conference = getJoinedModeratorConference(api) as {
    room?: { members?: Record<string, { jid?: string; role?: string; affiliation?: string; isFocus?: boolean }>;
      myroomjid?: string }
  } | null
  const live = transport(api, roomName)
  const targetRole = getParticipantRole(api, participantId)
  if (!conference || !live || !/^[A-Za-z0-9_-]{1,64}$/.test(participantId)
      || (targetRole !== 'participant' && targetRole !== 'none')) {
    throw new Error('当前主持人或目标成员身份尚未确认')
  }
  const target = `${live.roomJid}/${participantId}`
  const occupant = conference.room?.members?.[target]
  if (!occupant || !conference.room?.myroomjid || target === conference.room.myroomjid
      || occupant.isFocus || occupant.role !== 'participant'
      || (occupant.affiliation && occupant.affiliation !== 'none')
      || typeof occupant.jid !== 'string' || !/^[^\s@/]+@[^\s/]+\/[^\s]+$/.test(occupant.jid)) {
    throw new Error('目标成员已离会或不能接任主持人')
  }
  // Operation IDs are uniqueness tokens, not authorization secrets. Prosody
  // binds the request to the authenticated source and target XMPP sessions.
  const operationId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  const response = await iqRequest(live.connection, live.doc, live.roomJid, 'transfer',
    { operationId, target })
  if (transport(api, roomName)?.connection !== live.connection
      || response.getAttribute('from') !== live.roomJid
      || child(response, 'transfer')?.getAttribute('operationId') !== operationId
      || child(response, 'transfer')?.getAttribute('state') !== 'roles-committed') {
    throw new Error('主持人转让结果尚未确认')
  }
  return operationId
}

/** Access the actual joined conference and its live XMPP transport. Unsupported
 * or cross-origin iframe versions fail closed; a peer message cannot supply it. */
function transport(api: JitsiMeetExternalAPI, roomName: string):
  { connection: StropheConnection; roomJid: string; doc: Document } | null {
  try {
    const frame = api.getIFrame()?.contentWindow as (Window & { APP?: any }) | null
    const app = frame?.APP
    const conference = app?.conference?._room
    const state = app?.store?.getState()?.['features/base/conference']
    if (!conference || state?.conference !== conference || state.joining || state.leaving
        || conference.isJoined?.() !== true) return null
    const roomJid = conference.room?.roomjid
    const wrapper = conference.getConnection?.()?.xmpp?.connection
      ?? conference.connection?.xmpp?.connection
    const connection: StropheConnection | undefined = wrapper?._stropheConn ?? wrapper
    if (typeof roomJid !== 'string' || !roomJid.startsWith(`${roomName}@`)
        || !connection?.connected || typeof connection.jid !== 'string'
        || !connection.jid.includes('@') || !connection.jid.includes('/')
        || typeof connection.addHandler !== 'function'
        || typeof connection.sendIQ !== 'function' || typeof connection.deleteHandler !== 'function'
        || !frame?.document) return null
    return { connection, roomJid, doc: frame.document }
  } catch { return null }
}

export function attachHostTransferClient(api: JitsiMeetExternalAPI, roomName: string, handlers: {
  onComplete(key: string): Promise<void> | void
  onError(message: string): void
}): () => void {
  const live = transport(api, roomName)
  if (!live) return () => {}
  const { connection, roomJid, doc } = live
  let stopped = false
  let retryTimer: number | undefined
  let claimTimer: number | undefined
  let running = false
  let claiming = false
  const current = () => !stopped && transport(api, roomName)?.connection === connection

  const finish = async (pending: PendingHostTransfer) => {
    if (getPendingHostTransfer(roomName)?.operationId !== pending.operationId) return
    await handlers.onComplete(pending.hostKey)
    clearPendingHostTransfer(roomName, pending.operationId)
  }

  const acknowledge = async (pending: PendingHostTransfer) => {
    const result = await iqRequest(connection, doc, roomJid, 'ack', { operationId: pending.operationId })
    if (!current() || getPendingHostTransfer(roomName)?.operationId !== pending.operationId
        || result.getAttribute('from') !== roomJid
        || child(result, 'ack')?.getAttribute('state') !== 'complete'
        || child(result, 'ack')?.getAttribute('operationId') !== pending.operationId) {
      throw new Error('Host transfer acknowledgement was not verified')
    }
    await finish(pending)
  }

  const recover = async (pending: PendingHostTransfer) => {
    const response = await iqRequest(connection, doc, roomJid, 'recover', { operationId: pending.operationId })
    const challenge = child(response, 'challenge')
    const attr = (name: string) => challenge?.getAttribute(name) ?? ''
    const expected = attr('expectedRoomInstance')
    const instance = attr('roomInstance')
    const nonce = attr('nonce')
    const expires = Number(attr('expiresAt'))
    if (!current() || getPendingHostTransfer(roomName)?.operationId !== pending.operationId
        || response.getAttribute('from') !== roomJid
        || attr('roomName') !== roomName || attr('operationId') !== pending.operationId
        || attr('targetSession') !== connection.jid
        || !/^[A-Za-z0-9_-]{1,128}$/.test(expected)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(instance) || instance === expected
        || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)
        || !Number.isFinite(expires) || expires <= Date.now() / 1000) {
      throw new Error('Host transfer recovery challenge was not verified')
    }
    const proof = await makeHostTransferProof(pending.hostKey, roomName, pending.operationId,
      connection.jid, expected, instance, nonce)
    if (!current() || getPendingHostTransfer(roomName)?.operationId !== pending.operationId) return
    const rebound = await iqRequest(connection, doc, roomJid, 'rebind',
      { operationId: pending.operationId, nonce, proof })
    if (!current() || rebound.getAttribute('from') !== roomJid
        || child(rebound, 'rebind')?.getAttribute('state') !== 'roles-committed'
        || child(rebound, 'rebind')?.getAttribute('operationId') !== pending.operationId) {
      throw new Error('Host transfer role recovery was not verified')
    }
    await acknowledge(pending)
  }

  const attempt = async (pending: PendingHostTransfer, firstAck = false) => {
    if (running || !current()) return
    running = true
    try {
      if (firstAck) await acknowledge(pending)
      else await recover(pending)
    } catch (error) {
      if (current() && getPendingHostTransfer(roomName)?.operationId === pending.operationId) {
        // The API may have committed /complete while its IQ response was lost.
        // A fresh host JWT is issued only after that durable fence opens.
        try { await finish(pending) }
        catch { if (current()) handlers.onError((error as Error).message) }
      }
    } finally {
      running = false
      const latest = getPendingHostTransfer(roomName)
      if (current() && latest && latest.operationId !== pending.operationId) {
        void attempt(latest, true)
      }
      if (current() && getPendingHostTransfer(roomName)?.operationId === pending.operationId
          && pending.expiresAt > Date.now()) {
        retryTimer = window.setTimeout(() => void attempt(pending, firstAck), RETRY_MS)
      }
    }
  }

  const messageHandler = (message: Element): boolean => {
    if (!current() || message.getAttribute('from') !== roomJid
        || message.getAttribute('type') !== 'normal') return true
    const revoked = child(message, 'revoked')
    if (revoked) {
      const pending = getPendingHostTransfer(roomName)
      if (pending && pending.operationId === revoked.getAttribute('operationId')) {
        try {
          clearTransferredHostKey(roomName, pending.hostKey)
          clearPendingHostTransfer(roomName, pending.operationId)
        } catch { handlers.onError('已撤销的主持人凭据清理失败') }
      }
      return true
    }
    const credential = child(message, 'credential')
    const operationId = credential?.getAttribute('operationId') ?? ''
    const hostKey = credential?.getAttribute('hostKey') ?? ''
    const identity = credential?.getAttribute('identity') ?? ''
    const previousOperationId = credential?.getAttribute('previousOperationId') ?? ''
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(operationId) || !hostKey || hostKey.length > 128
        || !/^host-v1-[A-Za-z0-9_-]{43}$/.test(identity)) return true
    const prior = getPendingHostTransfer(roomName)
    if (prior && prior.operationId !== operationId && prior.expiresAt > Date.now()
        && previousOperationId !== prior.operationId) return true
    const pending = { operationId, hostKey, expiresAt: Date.now() + 300000 }
    try {
      savePendingHostTransfer(roomName, pending)
      saveMeetingCredentials(roomName, { hostKey, password: getSession(roomName)?.password ?? '' })
      const session = getSession(roomName)
      if (session) saveSession({ ...session, hostKey })
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      void attempt(pending, true)
    } catch { handlers.onError('主持人密钥保存失败，转让尚未确认') }
    return true
  }
  const listener = connection.addHandler(messageHandler, NS, 'message')
  const pending = getPendingHostTransfer(roomName)
  if (pending && pending.expiresAt > Date.now()) void attempt(pending)
  const checkMissingCredential = async () => {
    if (!current()) return
    if (!claiming && !getPendingHostTransfer(roomName) && !getSession(roomName)?.hostKey
        && getJoinedModeratorConference(api)) {
      claiming = true
      try { await iqRequest(connection, doc, roomJid, 'claim', {}) }
      catch { /* No pending transfer for this participant is normal. */ }
      finally { claiming = false }
    }
    if (current()) claimTimer = window.setTimeout(() => void checkMissingCredential(), RETRY_MS)
  }
  claimTimer = window.setTimeout(() => void checkMissingCredential(), RETRY_MS)
  return () => {
    stopped = true
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    if (claimTimer !== undefined) window.clearTimeout(claimTimer)
    connection.deleteHandler(listener)
  }
}
