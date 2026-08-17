import type { AppState, BackupPayload, Language, ReadingLens } from "../types";
import { CARDS } from "../data/cards";

const DATABASE_NAME = "ritual-atlas";
const DATABASE_VERSION = 1;
const STORE_NAME = "app-state";
const STATE_KEY = "current";
const VALID_CARD_IDS = new Set(CARDS.map((card) => card.id));
const COMBINED_ONLY_CARD_IDS = new Set(
  CARDS.filter((card) => card.combinedOnly).map((card) => card.id),
);
const STATE_ENVELOPE_FORMAT = "ritual-atlas-state";

interface StateEnvelope {
  format: typeof STATE_ENVELOPE_FORMAT;
  schemaVersion: 1;
  revision: number;
  state: AppState;
}

export interface StateSnapshot {
  state: AppState;
  revision: number;
}

export class StateConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Local data changed in another tab (expected revision ${expectedRevision}, found ${actualRevision}).`,
    );
    this.name = "StateConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadingLens(value: unknown): value is ReadingLens {
  return value === "combined" || value === "tarot" || value === "oracle" || value === "mixed";
}

function isSetupDraft(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.spreadId === "string" &&
    value.spreadId.trim().length > 0 &&
    isReadingLens(value.lens) &&
    typeof value.question === "string"
  );
}

function isLocalizedText(value: unknown): boolean {
  return isRecord(value) && typeof value.en === "string" && typeof value.nl === "string";
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    !isValidCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }

  return Number.isFinite(Date.parse(value));
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return (
    match !== null &&
    isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
  );
}

function hasFiniteOptionalNumber(record: Record<string, unknown>, key: string): boolean {
  return (
    !(key in record) ||
    record[key] === undefined ||
    (typeof record[key] === "number" && Number.isFinite(record[key]))
  );
}

function isFreeformPosition(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.rotation === "number" &&
    Number.isFinite(value.rotation) &&
    typeof value.scale === "number" &&
    Number.isFinite(value.scale)
  );
}

function isReading(value: unknown, allowIncompleteComplete = false): boolean {
  if (!isRecord(value) || !isRecord(value.spreadSnapshot)) return false;
  const spread = value.spreadSnapshot;
  if (!Array.isArray(spread.positions) || !Array.isArray(value.pulls)) return false;

  const positionsAreValid = spread.positions.every(
    (position) =>
      isRecord(position) &&
      typeof position.id === "string" &&
      position.id.trim().length > 0 &&
      isLocalizedText(position.name) &&
      isLocalizedText(position.prompt) &&
      hasFiniteOptionalNumber(position, "x") &&
      hasFiniteOptionalNumber(position, "y") &&
      (!("defaultLens" in position) ||
        position.defaultLens === undefined ||
        position.defaultLens === "combined" ||
        position.defaultLens === "tarot" ||
        position.defaultLens === "oracle"),
  );
  const positionIds = spread.positions
    .filter(isRecord)
    .map((position) => position.id)
    .filter((id): id is string => typeof id === "string");
  const pullsAreValid = value.pulls.every(
    (pull, index) =>
      isRecord(pull) &&
      typeof pull.slotId === "string" &&
      pull.slotId === positionIds[index] &&
      pull.order === index &&
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
      typeof pull.interpretation === "string" &&
      (!("interpretationCardId" in pull) ||
        pull.interpretationCardId === undefined ||
        pull.interpretationCardId === null ||
        (typeof pull.interpretationCardId === "string" &&
          VALID_CARD_IDS.has(pull.interpretationCardId))) &&
      (!("freeformPosition" in pull) ||
        pull.freeformPosition === undefined ||
        isFreeformPosition(pull.freeformPosition)) &&
      (typeof pull.cardId !== "string" ||
        !COMBINED_ONLY_CARD_IDS.has(pull.cardId) ||
        ((pull.lensOverride === null || pull.lensOverride === "combined") &&
          pull.firstSeenAspect === null)),
  );
  const reflectionsAreValid =
    Array.isArray(value.laterReflections) &&
    value.laterReflections.every(
      (reflection) =>
        isRecord(reflection) &&
        typeof reflection.id === "string" &&
        reflection.id.trim().length > 0 &&
        isValidIsoTimestamp(reflection.createdAt) &&
        typeof reflection.text === "string",
    );
  const reflectionIds = Array.isArray(value.laterReflections)
    ? value.laterReflections
        .filter(isRecord)
        .map((reflection) => reflection.id)
        .filter((id): id is string => typeof id === "string")
    : [];

  return (
    value.schemaVersion === 1 &&
    typeof value.id === "string" &&
    isValidIsoTimestamp(value.createdAt) &&
    isValidIsoTimestamp(value.updatedAt) &&
    isValidIsoTimestamp(value.performedAt) &&
    typeof value.timezone === "string" &&
    (value.status === "draft" || value.status === "complete") &&
    isReadingLens(value.readingLens) &&
    typeof value.question === "string" &&
    typeof spread.id === "string" &&
    isLocalizedText(spread.name) &&
    (!("isFreeform" in spread) ||
      spread.isFreeform === undefined ||
      typeof spread.isFreeform === "boolean") &&
    positionsAreValid &&
    positionIds.length === spread.positions.length &&
    new Set(positionIds).size === positionIds.length &&
    pullsAreValid &&
    spread.positions.length === value.pulls.length &&
    (allowIncompleteComplete || value.status !== "complete" ||
      (value.pulls.length > 0 &&
        value.pulls.every((pull) => isRecord(pull) && typeof pull.cardId === "string"))) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    typeof value.initialReflection === "string" &&
    (!("laterReflectionDraft" in value) ||
      value.laterReflectionDraft === undefined ||
      typeof value.laterReflectionDraft === "string") &&
    reflectionsAreValid &&
    new Set(reflectionIds).size === reflectionIds.length &&
    (value.revisitDate === null || isValidDateOnly(value.revisitDate))
  );
}

function isAppState(value: unknown, allowLegacyIncompleteComplete = false): value is AppState {
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
    value.readings.every((reading) => isReading(reading, allowLegacyIncompleteComplete)) &&
    new Set(readingIds).size === value.readings.length &&
    (!("setupDraft" in value) ||
      value.setupDraft === undefined ||
      isSetupDraft(value.setupDraft)) &&
    (activeDraftIsValid ||
      (allowLegacyIncompleteComplete &&
        (value.activeDraftId === null || typeof value.activeDraftId === "string")))
  );
}

function normalizeLegacyState(value: unknown): AppState | null {
  if (!isAppState(value, true)) return null;
  const readings = value.readings.map((reading) =>
    reading.status === "complete" && reading.pulls.some((pull) => pull.cardId === null)
      ? { ...reading, status: "draft" as const }
      : reading,
  );
  const activeDraftId = readings.some(
    (reading) => reading.id === value.activeDraftId && reading.status === "draft",
  )
    ? value.activeDraftId
    : (readings.find((reading) => reading.status === "draft")?.id ?? null);
  const normalized: AppState = { ...value, readings, activeDraftId };
  return isAppState(normalized) ? normalized : null;
}

function isStateEnvelope(value: unknown): value is StateEnvelope {
  return (
    isRecord(value) &&
    value.format === STATE_ENVELOPE_FORMAT &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.revision) &&
    typeof value.revision === "number" &&
    value.revision > 0 &&
    isAppState(value.state)
  );
}

function decodeStoredState(value: unknown): StateSnapshot {
  if (value === undefined) {
    return { state: createInitialState(), revision: 0 };
  }
  if (isAppState(value)) {
    return { state: value, revision: 0 };
  }
  const normalizedLegacyState = normalizeLegacyState(value);
  if (normalizedLegacyState) {
    return { state: normalizedLegacyState, revision: 0 };
  }
  if (isStateEnvelope(value)) {
    return { state: value.state, revision: value.revision };
  }
  throw new Error("Stored Ritual Atlas data is invalid.");
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
    setupDraft: {
      spreadId: "one-card",
      lens: "combined",
      question: "",
    },
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

export async function loadStateSnapshot(): Promise<StateSnapshot> {
  const database = await openDatabase();
  try {
    return await new Promise<StateSnapshot>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
      let snapshot: StateSnapshot | null = null;
      let pendingError: Error | null = null;
      request.onsuccess = () => {
        try {
          snapshot = decodeStoredState(request.result);
        } catch (error) {
          pendingError = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
        }
      };
      request.onerror = () => {
        pendingError = request.error ?? new Error("Unable to read local data.");
      };
      transaction.oncomplete = () => {
        if (snapshot) resolve(snapshot);
        else reject(pendingError ?? new Error("Local data was not read."));
      };
      transaction.onerror = () =>
        reject(pendingError ?? transaction.error ?? new Error("Unable to read local data."));
      transaction.onabort = () =>
        reject(
          pendingError ?? transaction.error ?? new Error("Reading local data was cancelled."),
        );
    });
  } finally {
    database.close();
  }
}

export async function loadState(): Promise<AppState> {
  return (await loadStateSnapshot()).state;
}

export async function saveState(
  state: AppState,
  expectedRevision?: number,
): Promise<number> {
  if (!isAppState(state)) {
    throw new Error("Ritual Atlas data is invalid and was not saved.");
  }
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  ) {
    throw new TypeError("The expected local-data revision must be a non-negative integer.");
  }

  const database = await openDatabase();
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(STATE_KEY);
      let nextRevision: number | null = null;
      let pendingError: Error | null = null;

      request.onsuccess = () => {
        let current: StateSnapshot;
        try {
          current = decodeStoredState(request.result);
        } catch (error) {
          pendingError = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
          return;
        }

        if (expectedRevision !== undefined && current.revision !== expectedRevision) {
          pendingError = new StateConflictError(expectedRevision, current.revision);
          transaction.abort();
          return;
        }

        if (current.revision === Number.MAX_SAFE_INTEGER) {
          pendingError = new Error("The local-data revision limit was reached.");
          transaction.abort();
          return;
        }

        nextRevision = current.revision + 1;
        const envelope: StateEnvelope = {
          format: STATE_ENVELOPE_FORMAT,
          schemaVersion: 1,
          revision: nextRevision,
          state,
        };
        store.put(envelope, STATE_KEY);
      };
      request.onerror = () => {
        pendingError = request.error ?? new Error("Unable to read current local data.");
      };
      transaction.oncomplete = () => {
        if (nextRevision === null) {
          reject(new Error("Local data was not saved."));
        } else {
          resolve(nextRevision);
        }
      };
      transaction.onerror = () =>
        reject(pendingError ?? transaction.error ?? new Error("Unable to save local data."));
      transaction.onabort = () =>
        reject(pendingError ?? transaction.error ?? new Error("Local save was cancelled."));
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
    appVersion: "1.0.0",
    state,
  };
}

export function parseBackup(text: string): BackupPayload {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.format !== "ritual-atlas-backup" ||
    value.schemaVersion !== 1 ||
    !isValidIsoTimestamp(value.exportedAt) ||
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
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Clearing local data was cancelled."));
    });
  } finally {
    database.close();
  }
}
