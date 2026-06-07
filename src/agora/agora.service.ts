import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RtcRole, RtcTokenBuilder } from 'agora-token';

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

    // RtcTokenBuilder.buildTokenWithUid expects tokenExpire and privilegeExpire
    // as seconds-from-now (not absolute timestamps).
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      expireSeconds,
      expireSeconds,
    );

    return { appId, token, channelName, uid };
  }
}
