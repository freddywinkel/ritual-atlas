import type { AppState, BackupPayload, Language } from "../types";
import { CARDS } from "../data/cards";

const DATABASE_NAME = "ritual-atlas";
const DATABASE_VERSION = 1;
const STORE_NAME = "app-state";
const STATE_KEY = "current";
const VALID_CARD_IDS = new Set(CARDS.map((card) => card.id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocalizedText(value: unknown): boolean {
  return isRecord(value) && typeof value.en === "string" && typeof value.nl === "string";
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isReading(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.spreadSnapshot)) return false;
  const spread = value.spreadSnapshot;
  if (!Array.isArray(spread.positions) || !Array.isArray(value.pulls)) return false;

  const positionsAreValid = spread.positions.every(
    (position) =>
      isRecord(position) &&
      typeof position.id === "string" &&
      isLocalizedText(position.name) &&
      isLocalizedText(position.prompt),
  );
  const pullsAreValid = value.pulls.every(
    (pull) =>
      isRecord(pull) &&
      typeof pull.slotId === "string" &&
      Number.isInteger(pull.order) &&
      (pull.cardId === null ||
        (typeof pull.cardId === "string" && VALID_CARD_IDS.has(pull.cardId))) &&
      (pull.orientation === "upright" || pull.orientation === "reversed") &&
      (pull.role === "primary" || pull.role === "jumper" || pull.role === "clarifier") &&
      (pull.lensOverride === null ||
        pull.lensOverride === "combined" ||
        pull.lensOverride === "tarot" ||
        pull.lensOverride === "oracle") &&
      (pull.firstSeenAspect === null ||
        pull.firstSeenAspect === "tarot" ||
        pull.firstSeenAspect === "oracle" ||
        pull.firstSeenAspect === "both" ||
        pull.firstSeenAspect === "unclear") &&
      typeof pull.firstImpression === "string" &&
      typeof pull.interpretation === "string",
  );
  const reflectionsAreValid =
    Array.isArray(value.laterReflections) &&
    value.laterReflections.every(
      (reflection) =>
        isRecord(reflection) &&
        typeof reflection.id === "string" &&
        isValidDateString(reflection.createdAt) &&
        typeof reflection.text === "string",
    );

  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    isValidDateString(value.createdAt) &&
    isValidDateString(value.updatedAt) &&
    isValidDateString(value.performedAt) &&
    typeof value.timezone === "string" &&
    (value.status === "draft" || value.status === "complete") &&
    (value.readingLens === "combined" ||
      value.readingLens === "tarot" ||
      value.readingLens === "oracle" ||
      value.readingLens === "mixed") &&
    typeof value.question === "string" &&
    typeof spread.id === "string" &&
    isLocalizedText(spread.name) &&
    positionsAreValid &&
    pullsAreValid &&
    spread.positions.length === value.pulls.length &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    typeof value.initialReflection === "string" &&
    reflectionsAreValid &&
    (value.revisitDate === null || isValidDateString(value.revisitDate))
  );
}

function isAppState(value: unknown): value is AppState {
  if (!isRecord(value) || !isRecord(value.settings) || !Array.isArray(value.readings)) {
    return false;
  }
  const readingIds = value.readings
    .filter(isRecord)
    .map((reading) => reading.id)
    .filter((id): id is string => typeof id === "string");
  const activeDraftIsValid =
    value.activeDraftId === null ||
    (typeof value.activeDraftId === "string" &&
      value.readings.some(
        (reading) =>
          isRecord(reading) &&
          reading.id === value.activeDraftId &&
          reading.status === "draft",
      ));

  return (
    value.schemaVersion === 1 &&
    (value.settings.language === "en" || value.settings.language === "nl") &&
    typeof value.settings.reducedMotion === "boolean" &&
    typeof value.settings.showEnglishCardNamesInDutch === "boolean" &&
    value.readings.every(isReading) &&
    new Set(readingIds).size === value.readings.length &&
    activeDraftIsValid
  );
}

function preferredLanguage(): Language {
  if (typeof navigator === "undefined") return "en";
  return navigator.languages.some((language) => language.toLowerCase().startsWith("nl"))
    ? "nl"
    : "en";
}

export function createInitialState(): AppState {
  return {
    schemaVersion: 1,
    settings: {
      language: preferredLanguage(),
      reducedMotion:
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      showEnglishCardNamesInDutch: true,
    },
    readings: [],
    activeDraftId: null,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open local storage."));
  });
}

export async function loadState(): Promise<AppState> {
  const database = await openDatabase();
  try {
    return await new Promise<AppState>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => {
        const stored: unknown = request.result;
        if (stored === undefined) {
          resolve(createInitialState());
        } else if (isAppState(stored)) {
          resolve(stored);
        } else {
          reject(new Error("Stored Ritual Atlas data is invalid."));
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Unable to read local data."));
    });
  } finally {
    database.close();
  }
}

export async function saveState(state: AppState): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save local data."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Local save was cancelled."));
    });
  } finally {
    database.close();
  }
}

export function makeBackup(state: AppState): BackupPayload {
  return {
    format: "ritual-atlas-backup",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: "0.1.0",
    state,
  };
}

export function parseBackup(text: string): BackupPayload {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.format !== "ritual-atlas-backup" ||
    value.schemaVersion !== 1 ||
    !isValidDateString(value.exportedAt) ||
    typeof value.appVersion !== "string" ||
    !isAppState(value.state)
  ) {
    throw new Error("This is not a valid Ritual Atlas backup.");
  }
  return {
    format: "ritual-atlas-backup",
    schemaVersion: 1,
    exportedAt: value.exportedAt,
    appVersion: value.appVersion,
    state: value.state,
  };
}

export async function clearStoredState(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(STATE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to clear local data."));
    });
  } finally {
    database.close();
  }
}
