export type Language = "en" | "nl";

export type ReadingLens = "combined" | "tarot" | "oracle" | "mixed";

export type Orientation = "upright" | "reversed";

export type FirstSeenAspect = "tarot" | "oracle" | "both" | "unclear";

export type PullRole = "primary" | "jumper" | "clarifier";

export type ReadingStatus = "draft" | "complete";

export interface SpreadPositionSnapshot {
  id: string;
  name: Record<Language, string>;
  prompt: Record<Language, string>;
  defaultLens?: Exclude<ReadingLens, "mixed">;
  x?: number;
  y?: number;
}

export interface SpreadSnapshot {
  id: string;
  name: Record<Language, string>;
  positions: SpreadPositionSnapshot[];
  isFreeform?: boolean;
}

export interface Pull {
  slotId: string;
  order: number;
  cardId: string | null;
  orientation: Orientation;
  role: PullRole;
  lensOverride: Exclude<ReadingLens, "mixed"> | null;
  firstSeenAspect: FirstSeenAspect | null;
  firstImpression: string;
  interpretation: string;
  freeformPosition?: {
    x: number;
    y: number;
    rotation: number;
    scale: number;
  };
}

export interface LaterReflection {
  id: string;
  createdAt: string;
  text: string;
}

export interface Reading {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  performedAt: string;
  timezone: string;
  status: ReadingStatus;
  readingLens: ReadingLens;
  question: string;
  spreadSnapshot: SpreadSnapshot;
  pulls: Pull[];
  tags: string[];
  initialReflection: string;
  laterReflectionDraft?: string;
  laterReflections: LaterReflection[];
  revisitDate: string | null;
}

export interface AppSettings {
  language: Language;
  reducedMotion: boolean;
  showEnglishCardNamesInDutch: boolean;
}

export interface AppState {
  schemaVersion: 1;
  settings: AppSettings;
  readings: Reading[];
  activeDraftId: string | null;
  setupDraft?: {
    spreadId: string;
    lens: ReadingLens;
    question: string;
  };
}

export interface BackupPayload {
  format: "ritual-atlas-backup";
  schemaVersion: 1;
  exportedAt: string;
  appVersion: string;
  state: AppState;
}
