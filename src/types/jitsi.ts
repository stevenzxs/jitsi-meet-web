declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options?: JitsiExternalAPIOptions,
    ) => JitsiMeetExternalAPI;
  }
}

export interface JitsiParticipantInfo {
  participantId?: string;
  id?: string;
  displayName?: string;
  email?: string;
  isHidden?: boolean;
  isJigasi?: boolean;
  videoMuted?: boolean;
}

export interface JitsiRoomInfo {
  isMainRoom?: boolean;
  id?: string;
  jid?: string;
  participants?: JitsiParticipantInfo[];
}

export interface JitsiExternalAPIOptions {
  roomName: string;
  width?: string | number;
  height?: string | number;
  parentNode?: HTMLElement | null;
  configOverwrite?: Record<string, unknown>;
  interfaceConfigOverwrite?: Record<string, unknown>;
  /** Jitsi 新版本支持的主题配置；旧版本会忽略该字段。 */
  customTheme?: Record<string, unknown>;
  userInfo?: { displayName?: string; email?: string };
  lang?: string;
  devices?: unknown;
  invitees?: unknown;
}

export interface JitsiDevice {
  label?: string;
  deviceId?: string;
}

export interface JitsiDeviceMap {
  audioInput?: JitsiDevice[];
  audioOutput?: JitsiDevice[];
  videoInput?: JitsiDevice[];
}

export interface JitsiMeetExternalAPI {
  executeCommand(name: string, ...args: unknown[]): void;
  addListener(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
  removeAllListeners(event?: string): void;
  getIFrame(): HTMLIFrameElement | undefined;
  isAudioMuted(): Promise<boolean>;
  isVideoMuted(): Promise<boolean>;
  invite(invitees: unknown[]): void;
  /** 返回会议中所有参与者信息（含自己），用于入会时初始化成员计数。 */
  getParticipantsInfo(): JitsiParticipantInfo[];
  /** 返回房间与成员详情，优先用于读取成员视频开启状态。 */
  getRoomsInfo?(includeHidden?: boolean): Promise<{ rooms?: JitsiRoomInfo[] } | JitsiRoomInfo[]>;
  /** 获取当前可用的音频输入/输出与视频设备列表。 */
  getAvailableDevices(): Promise<JitsiDeviceMap>;
  setAudioInputDevice(label: string, deviceId: string): Promise<unknown>;
  setAudioOutputDevice(label: string, deviceId: string): Promise<unknown>;
  setVideoInputDevice(label: string, deviceId: string): Promise<unknown>;
  /** 获取当前正在共享屏幕的参与者 id 列表，用于限制同一会议只允许一人共享。 */
  getContentSharingParticipants(): Promise<Array<string | number>>;
  dispose(): void;
}

export {};
