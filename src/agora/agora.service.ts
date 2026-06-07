import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'crypto';

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(v: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); return b; }
function u32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }
function packStr(s: string | Buffer): Buffer {
  const bytes = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  return Buffer.concat([u16(bytes.length), bytes]);
}

@Injectable()
export class AgoraService {
  generateToken(channelName: string, uid: number, expireSeconds = 3600): {
    appId: string;
    token: string;
    channelName: string;
    uid: number;
  } {
    const appId = process.env.AGORA_APP_ID ?? '';
    const appCertificate = process.env.AGORA_APP_CERTIFICATE ?? '';

    if (!appId || !appCertificate) {
      throw new ServiceUnavailableException('No active Agora key configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const expiredTs = now + expireSeconds;
    const salt = (Math.floor(Math.random() * 0x7fffffff) + 1) >>> 0;
    const uidStr = uid === 0 ? '' : String(uid);

    const privileges: [number, number][] = [
      [1, expiredTs], [2, expiredTs], [3, expiredTs], [4, expiredTs],
    ];
    const privBuf = Buffer.concat([
      u16(privileges.length),
      ...privileges.flatMap(([k, v]) => [u16(k), u32(v)]),
    ]);

    const msg = Buffer.concat([packStr(uidStr), u32(expiredTs), privBuf]);
    const hmacInput = Buffer.concat([
      Buffer.from(appId, 'utf8'), u32(now), u32(salt), msg,
    ]);
    const sig = createHmac('sha256', Buffer.from(appCertificate, 'utf8'))
      .update(hmacInput).digest();

    const content = Buffer.concat([
      packStr(sig), u32(now), u32(salt),
      u32(crc32(Buffer.from(channelName, 'utf8'))),
      u32(crc32(Buffer.from(uidStr, 'utf8'))),
      packStr(msg),
    ]);

    return {
      appId,
      token: '006' + appId + content.toString('base64'),
      channelName,
      uid,
    };
  }
}
