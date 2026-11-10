/**
 * 生成主持人密钥（hostKey）：预创建会议时生成，并随会议记录保存。
 * 凭它向签发服务换主持人 JWT；泄露 = 主持人权限，需妥善保管。
 * 去掉了易混字符（0/O/1/I），格式 XXXX-XXXX-XXXX-XXXX。
 */
export function generateHostKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const array = new Uint32Array(16);
  crypto.getRandomValues(array);
  let raw = '';
  for (let i = 0; i < 16; i++) {
    raw += chars[array[i] % chars.length];
  }
  return raw.match(/.{4}/g)!.join('-');
}
