import { post } from './request';

const HOST_KEY_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;

interface HostTokenResponse {
  token: string;
  expiresAt: string;
}

/**
 * 向服务端申请主持人令牌。
 * 前端只提交会议号、主持人密钥和昵称；Jitsi app_secret、JWT 签名和过期时间控制都在 jitsi-meet-api 完成。
 */
export async function fetchHostToken(
  roomName: string,
  hostKey: string,
  displayName: string,
  _expiresAt?: number,
): Promise<string | null> {
  const key = hostKey.trim();
  if (!HOST_KEY_RE.test(key)) return null;
  try {
    const data = await post<HostTokenResponse>(`/open/desktop/meetings/${roomName}/host-token`, {
      hostKey: key,
      displayName: displayName || '主持人',
    });
    return data.token || null;
  } catch (error) {
    console.warn('申请主持人令牌失败', error);
    return null;
  }
}
