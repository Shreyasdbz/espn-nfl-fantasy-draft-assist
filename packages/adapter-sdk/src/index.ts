import type { ObservationPick, ObservationPlayer, RawObservation } from '@fda/contracts';

export type PageIdentityResult = {
  matches: boolean;
  authenticated: boolean;
  externalDraftId?: string;
  pageKind: 'draft' | 'league' | 'login' | 'other';
};

export type AdapterHealth = {
  compatible: boolean;
  authenticated: boolean;
  pageAttached: boolean;
  captureHealthy: boolean;
  reason?: string;
};

export type NormalizedObservation = {
  observation: RawObservation;
  picks: ObservationPick[];
  players: ObservationPlayer[];
  confidence: 'high' | 'medium' | 'low';
  errors: string[];
};

export type ObservationSink = (observation: RawObservation) => Promise<void> | void;
export type Detach = () => Promise<void> | void;

export interface ReadonlyPage {
  url(): string;
  title(): Promise<string>;
  text(selector: string, limit?: number): Promise<string[]>;
  exists(selector: string): Promise<boolean>;
  onResponse(listener: (response: ReadonlyResponse) => void): void;
  onWebSocket(listener: (socket: ReadonlyWebSocket) => void): void;
  onNavigation(listener: () => void): void;
}

export interface ReadonlyResponse {
  url(): string;
  status(): number;
  contentType(): Promise<string | null>;
  json(maxBytes: number): Promise<unknown | null>;
}

export interface ReadonlyWebSocket {
  url(): string;
  onFrame(listener: (payload: string) => void): void;
}

export interface DraftPlatformAdapter {
  readonly key: string;
  identifyPage(page: ReadonlyPage): Promise<PageIdentityResult>;
  attachPassiveCapture(page: ReadonlyPage, sink: ObservationSink): Promise<Detach>;
  captureRenderedSnapshot(page: ReadonlyPage): Promise<RawObservation>;
  normalize(observation: RawObservation): NormalizedObservation;
  health(page: ReadonlyPage): Promise<AdapterHealth>;
}
