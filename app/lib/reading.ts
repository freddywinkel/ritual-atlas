import type {
  Pull,
  Reading,
  ReadingLens,
  SpreadSnapshot,
} from "../types";

export function makeId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

export function createReading(
  spread: SpreadSnapshot,
  readingLens: ReadingLens,
  question: string,
): Reading {
  const now = new Date().toISOString();
  const pulls: Pull[] = spread.positions.map((position, index) => ({
    slotId: position.id,
    order: index,
    cardId: null,
    orientation: "upright",
    role: "primary",
    lensOverride:
      readingLens === "mixed" ? position.defaultLens ?? "combined" : null,
    firstSeenAspect: null,
    firstImpression: "",
    interpretation: "",
    interpretationCardId: null,
  }));

  return {
    id: makeId("reading"),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    performedAt: now,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Amsterdam",
    status: "draft",
    readingLens,
    question: question.trim(),
    spreadSnapshot: spread,
    pulls,
    tags: [],
    initialReflection: "",
    laterReflections: [],
    revisitDate: null,
  };
}

export function readingProgress(reading: Reading): { complete: number; total: number } {
  return {
    complete: reading.pulls.filter((pull) => pull.cardId).length,
    total: reading.pulls.length,
  };
}

export function getEffectivePullLens(
  reading: Reading,
  pull: Pull,
  defaultLens?: Exclude<ReadingLens, "mixed">,
  combinedOnly = false,
): Exclude<ReadingLens, "mixed"> {
  if (combinedOnly) return "combined";
  if (reading.readingLens === "combined") {
    return pull.lensOverride === "tarot" || pull.lensOverride === "oracle"
      ? pull.lensOverride
      : "combined";
  }
  if (reading.readingLens === "mixed") {
    return pull.lensOverride ?? defaultLens ?? "combined";
  }
  return pull.lensOverride ?? reading.readingLens;
}

export function isReadingComplete(reading: Reading): boolean {
  const { complete, total } = readingProgress(reading);
  return total > 0 && complete === total;
}

export function updateReadingTimestamp(reading: Reading): Reading {
  return { ...reading, updatedAt: new Date().toISOString() };
}
