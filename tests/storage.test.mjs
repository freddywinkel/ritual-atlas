import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "ritual-atlas-storage-"));
const [storageSource, cardsSource] = await Promise.all([
  readFile(new URL("../app/lib/storage.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/data/cards.ts", import.meta.url), "utf8"),
]);

const transpile = (source, fileName) =>
  ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

await Promise.all([
  writeFile(
    join(temporaryDirectory, "storage.mjs"),
    transpile(
      storageSource.replace('from "../data/cards"', 'from "./cards.mjs"'),
      "storage.ts",
    ),
  ),
  writeFile(join(temporaryDirectory, "cards.mjs"), transpile(cardsSource, "cards.ts")),
]);

const storage = await import(new URL(`file:///${join(temporaryDirectory, "storage.mjs").replaceAll("\\", "/")}`));
const { CARDS } = await import(new URL(`file:///${join(temporaryDirectory, "cards.mjs").replaceAll("\\", "/")}`));
const regularCardId = CARDS.find((card) => !card.combinedOnly).id;
const combinedOnlyCardId = CARDS.find((card) => card.combinedOnly).id;

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function makeReading(positionCount = 1) {
  const positions = Array.from({ length: positionCount }, (_, index) => ({
    id: `position-${index + 1}`,
    name: { en: `Position ${index + 1}`, nl: `Positie ${index + 1}` },
    prompt: { en: "Prompt", nl: "Vraag" },
  }));
  return {
    id: "reading-1",
    schemaVersion: 1,
    createdAt: "2026-08-11T09:30:00.000Z",
    updatedAt: "2026-08-11T09:31:00.000Z",
    performedAt: "2026-08-11T11:30:00+02:00",
    timezone: "Europe/Amsterdam",
    status: "draft",
    readingLens: "combined",
    question: "What should I notice?",
    spreadSnapshot: {
      id: "spread-1",
      name: { en: "Spread", nl: "Legging" },
      positions,
    },
    pulls: positions.map((position, order) => ({
      slotId: position.id,
      order,
      cardId: regularCardId,
      orientation: "upright",
      role: "primary",
      lensOverride: null,
      firstSeenAspect: null,
      firstImpression: "",
      interpretation: "",
    })),
    tags: [],
    initialReflection: "",
    laterReflections: [],
    revisitDate: null,
  };
}

function makeState(positionCount = 1) {
  return {
    schemaVersion: 1,
    settings: {
      language: "en",
      reducedMotion: false,
      showEnglishCardNamesInDutch: true,
    },
    readings: [makeReading(positionCount)],
    activeDraftId: "reading-1",
  };
}

function makePayload(state = makeState()) {
  return {
    format: "ritual-atlas-backup",
    schemaVersion: 1,
    exportedAt: "2026-08-11T09:35:00.000Z",
    appVersion: "0.1.0",
    state,
  };
}

function parsePayload(payload) {
  return storage.parseBackup(JSON.stringify(payload));
}

test("accepts strict timestamps, date-only revisit dates, finite layout metadata, and duplicate cards", () => {
  const state = makeState(2);
  const reading = state.readings[0];
  reading.revisitDate = "2026-08-31";
  reading.spreadSnapshot.isFreeform = true;
  reading.spreadSnapshot.positions[0].x = 12.5;
  reading.spreadSnapshot.positions[0].y = -4;
  reading.spreadSnapshot.positions[0].defaultLens = "tarot";
  reading.pulls[0].freeformPosition = { x: 1, y: 2, rotation: -3.5, scale: 0.9 };
  reading.laterReflections = [
    { id: "reflection-1", createdAt: "2026-08-12T07:30:00+02:00", text: "One" },
    { id: "reflection-2", createdAt: "2026-08-13T05:30:00Z", text: "Two" },
  ];

  const parsed = parsePayload(makePayload(state));
  assert.equal(parsed.state.readings[0].pulls[0].cardId, regularCardId);
  assert.equal(parsed.state.readings[0].pulls[1].cardId, regularCardId);
});

test("rejects malformed or rollover timestamp and date-only strings", () => {
  const cases = [
    ["ambiguous exported timestamp", (payload) => { payload.exportedAt = "08/11/2026"; }],
    ["timestamp without timezone", (payload) => { payload.state.readings[0].createdAt = "2026-08-11T09:30:00"; }],
    ["rolled-over February timestamp", (payload) => { payload.state.readings[0].updatedAt = "2026-02-30T09:30:00Z"; }],
    ["24-hour rollover", (payload) => { payload.state.readings[0].performedAt = "2026-08-11T24:00:00Z"; }],
    ["ambiguous revisit date", (payload) => { payload.state.readings[0].revisitDate = "11/08/2026"; }],
    ["rolled-over revisit date", (payload) => { payload.state.readings[0].revisitDate = "2026-02-29"; }],
  ];

  for (const [name, mutate] of cases) {
    const payload = makePayload();
    mutate(payload);
    assert.throws(() => parsePayload(payload), /not a valid Ritual Atlas backup/, name);
  }
});

test("rejects invalid spread, pull, reflection, and optional-field invariants", () => {
  const cases = [
    ["empty position ID", (reading) => { reading.spreadSnapshot.positions[0].id = "  "; }],
    ["duplicate position IDs", (reading) => {
      reading.spreadSnapshot.positions[1].id = reading.spreadSnapshot.positions[0].id;
      reading.pulls[1].slotId = reading.pulls[0].slotId;
    }],
    ["pull slot mismatch", (reading) => { reading.pulls[0].slotId = "other"; }],
    ["pull order mismatch", (reading) => { reading.pulls[0].order = 4; }],
    ["completed reading with empty card", (reading) => {
      reading.status = "complete";
      reading.pulls[0].cardId = null;
    }],
    ["non-boolean freeform flag", (reading) => { reading.spreadSnapshot.isFreeform = "yes"; }],
    ["non-finite position coordinate", (reading) => { reading.spreadSnapshot.positions[0].x = Infinity; }],
    ["invalid default lens", (reading) => { reading.spreadSnapshot.positions[0].defaultLens = "mixed"; }],
    ["partial freeform transform", (reading) => { reading.pulls[0].freeformPosition = { x: 1, y: 2 }; }],
    ["non-finite freeform transform", (reading) => {
      reading.pulls[0].freeformPosition = { x: 1, y: 2, rotation: 3, scale: NaN };
    }],
    ["duplicate reflection IDs", (reading) => {
      reading.laterReflections = [
        { id: "same", createdAt: "2026-08-12T07:30:00Z", text: "One" },
        { id: "same", createdAt: "2026-08-13T07:30:00Z", text: "Two" },
      ];
    }],
  ];

  for (const [name, mutate] of cases) {
    const payload = makePayload(makeState(2));
    mutate(payload.state.readings[0]);
    assert.throws(() => parsePayload(payload), /not a valid Ritual Atlas backup/, name);
  }
});

test("enforces combined-only card metadata while accepting combined or null lens override", () => {
  for (const lensOverride of [null, "combined"]) {
    const payload = makePayload();
    Object.assign(payload.state.readings[0].pulls[0], {
      cardId: combinedOnlyCardId,
      lensOverride,
      firstSeenAspect: null,
    });
    assert.doesNotThrow(() => parsePayload(payload));
  }

  for (const [lensOverride, firstSeenAspect] of [["tarot", null], ["oracle", "both"], [null, "tarot"]]) {
    const payload = makePayload();
    Object.assign(payload.state.readings[0].pulls[0], {
      cardId: combinedOnlyCardId,
      lensOverride,
      firstSeenAspect,
    });
    assert.throws(() => parsePayload(payload), /not a valid Ritual Atlas backup/);
  }
});

function createFakeIndexedDb(initialValue) {
  let storedValue = initialValue === undefined ? undefined : structuredClone(initialValue);
  let storeCreated = initialValue !== undefined;
  let abortNextTransaction = false;

  const database = {
    objectStoreNames: {
      contains() { return storeCreated; },
    },
    createObjectStore() { storeCreated = true; },
    close() {},
    transaction() {
      let aborted = false;
      let pending = 0;
      let completionQueued = false;
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {
          if (aborted) return;
          aborted = true;
          queueMicrotask(() => transaction.onabort?.());
        },
        objectStore() {
          const request = (operation) => {
            const result = { result: undefined, error: null, onsuccess: null, onerror: null };
            pending += 1;
            queueMicrotask(() => {
              if (aborted) return;
              try {
                result.result = operation();
                result.onsuccess?.();
              } catch (error) {
                result.error = error;
                transaction.error = error;
                result.onerror?.();
                transaction.onerror?.();
                transaction.abort();
              } finally {
                pending -= 1;
                maybeComplete();
              }
            });
            return result;
          };
          return {
            get() { return request(() => structuredClone(storedValue)); },
            put(value) {
              return request(() => {
                storedValue = structuredClone(value);
                return undefined;
              });
            },
            delete() {
              return request(() => {
                storedValue = undefined;
                return undefined;
              });
            },
          };
        },
      };

      const maybeComplete = () => {
        if (aborted || pending !== 0 || completionQueued) return;
        completionQueued = true;
        queueMicrotask(() => {
          if (!aborted) transaction.oncomplete?.();
        });
      };

      if (abortNextTransaction) {
        abortNextTransaction = false;
        queueMicrotask(() => transaction.abort());
      }
      return transaction;
    },
  };

  return {
    indexedDB: {
      open() {
        const request = {
          result: database,
          error: null,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => {
          if (!storeCreated) request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
    getStoredValue: () => structuredClone(storedValue),
    abortNext() { abortNextTransaction = true; },
  };
}

test("loads legacy plain state and migrates it to a revisioned envelope atomically", async () => {
  const legacyState = makeState();
  const fake = createFakeIndexedDb(legacyState);
  globalThis.indexedDB = fake.indexedDB;

  const snapshot = await storage.loadStateSnapshot();
  assert.deepEqual(snapshot, { state: legacyState, revision: 0 });

  const revision = await storage.saveState(snapshot.state, snapshot.revision);
  assert.equal(revision, 1);
  assert.deepEqual(fake.getStoredValue(), {
    format: "ritual-atlas-state",
    schemaVersion: 1,
    revision: 1,
    state: legacyState,
  });
});

test("repairs the legacy complete-with-empty-card bug on local load without accepting it in backups", async () => {
  const legacyState = makeState();
  legacyState.readings[0].status = "complete";
  legacyState.readings[0].pulls[0].cardId = null;
  legacyState.activeDraftId = null;
  assert.throws(
    () => parsePayload(makePayload(legacyState)),
    /not a valid Ritual Atlas backup/,
  );

  const fake = createFakeIndexedDb(legacyState);
  globalThis.indexedDB = fake.indexedDB;
  const snapshot = await storage.loadStateSnapshot();
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.state.readings[0].status, "draft");
  assert.equal(snapshot.state.activeDraftId, "reading-1");
  assert.equal(await storage.saveState(snapshot.state, snapshot.revision), 1);
});

test("rejects stale cross-tab saves and lets an intentional force restore advance the revision", async () => {
  const fake = createFakeIndexedDb();
  globalThis.indexedDB = fake.indexedDB;
  const initial = storage.createInitialState();

  assert.equal(await storage.saveState(initial, 0), 1);
  const firstTab = await storage.loadStateSnapshot();
  const secondTab = await storage.loadStateSnapshot();
  const firstUpdate = structuredClone(firstTab.state);
  firstUpdate.settings.language = "nl";
  assert.equal(await storage.saveState(firstUpdate, firstTab.revision), 2);

  const staleUpdate = structuredClone(secondTab.state);
  staleUpdate.settings.reducedMotion = true;
  await assert.rejects(
    storage.saveState(staleUpdate, secondTab.revision),
    (error) =>
      error instanceof storage.StateConflictError &&
      error.expectedRevision === 1 &&
      error.actualRevision === 2,
  );

  assert.equal(await storage.saveState(staleUpdate), 3);
  assert.deepEqual(await storage.loadState(), staleUpdate);
  assert.equal(fake.getStoredValue().revision, 3);
});

test("saves app-created drafts with optional undefined metadata", async () => {
  const state = makeState(3);
  const reading = state.readings[0];
  reading.readingLens = "mixed";
  reading.spreadSnapshot.isFreeform = undefined;
  reading.spreadSnapshot.positions.forEach((position, index) => {
    position.defaultLens = [undefined, "oracle", "combined"][index];
    position.x = index === 0 ? undefined : index;
    position.y = index === 0 ? undefined : -index;
  });
  reading.pulls.forEach((pull, index) => {
    pull.cardId = null;
    pull.lensOverride = ["combined", "oracle", "combined"][index];
    pull.freeformPosition = undefined;
  });

  const fake = createFakeIndexedDb();
  globalThis.indexedDB = fake.indexedDB;
  assert.equal(await storage.saveState(state, 0), 1);
  assert.deepEqual((await storage.loadStateSnapshot()).state, state);
});

test("surfaces aborted reads and clears instead of leaving storage promises pending", async () => {
  const fake = createFakeIndexedDb(makeState());
  globalThis.indexedDB = fake.indexedDB;
  fake.abortNext();
  await assert.rejects(storage.loadStateSnapshot(), /Reading local data was cancelled/);
  fake.abortNext();
  await assert.rejects(storage.clearStoredState(), /Clearing local data was cancelled/);
});
