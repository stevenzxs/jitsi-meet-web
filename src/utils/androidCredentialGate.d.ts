import type { MeetingSession } from '../stores/meeting';

export interface AndroidCredentialGateOptions {
  parent: Window;
  room: string;
  path: string;
  storage: Storage;
  getSession(room: string): MeetingSession | null;
  saveSession(session: MeetingSession): void;
  listen(listener: (event: MessageEvent) => void): () => void;
  schedule(callback: () => void): () => void;
  onState(state: 'waiting' | 'ready' | 'error', initialHostKey?: string): void;
}

export function createAndroidCredentialGate(options: AndroidCredentialGateOptions): {
  close(): void;
  sync(state: { state: 'pending' | 'candidate' | 'revoked'; hostKey: string; expectedHostKey: string; password: string }): boolean;
};
