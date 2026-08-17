import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "ritual-atlas-interpretations-"));
const sourceFiles = [
  "types",
  "major",
  "wands-chalices",
  "swords-pentacles",
  "index",
];

const transpile = (source, fileName) =>
  ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

await Promise.all(
  sourceFiles.map(async (name) => {
    const source = await readFile(
      new URL(`../app/data/interpretations/${name}.ts`, import.meta.url),
      "utf8",
    );
    const withModuleExtensions = source.replaceAll(
      /from "\.\/(types|major|wands-chalices|swords-pentacles)"/g,
      'from "./$1.mjs"',
    );
    await writeFile(
      join(temporaryDirectory, `${name}.mjs`),
      transpile(withModuleExtensions, `${name}.ts`),
    );
  }),
);

const cardsSource = await readFile(new URL("../app/data/cards.ts", import.meta.url), "utf8");
const readingSource = await readFile(new URL("../app/lib/reading.ts", import.meta.url), "utf8");
await Promise.all([
  writeFile(join(temporaryDirectory, "cards.mjs"), transpile(cardsSource, "cards.ts")),
  writeFile(join(temporaryDirectory, "reading.mjs"), transpile(readingSource, "reading.ts")),
]);

const [
  { CARD_INTERPRETATIONS },
  {
    CARDS,
    getCardDeckName,
    getCardDeckPrintedName,
    getCardDeckSearchTerms,
    getCardsForReadingLens,
  },
  { getEffectivePullLens },
] = await Promise.all([
  import(new URL(`file:///${join(temporaryDirectory, "index.mjs").replaceAll("\\", "/")}`)),
  import(new URL(`file:///${join(temporaryDirectory, "cards.mjs").replaceAll("\\", "/")}`)),
  import(new URL(`file:///${join(temporaryDirectory, "reading.mjs").replaceAll("\\", "/")}`)),
]);

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("covers every catalog card exactly once with the supported lenses", () => {
  assert.equal(CARD_INTERPRETATIONS.length, 79);
  assert.equal(new Set(CARD_INTERPRETATIONS.map((entry) => entry.cardId)).size, 79);
  assert.deepEqual(
    CARD_INTERPRETATIONS.map((entry) => entry.cardId).sort(),
    CARDS.map((card) => card.id).sort(),
  );

  for (const card of CARDS) {
    const entry = CARD_INTERPRETATIONS.find((candidate) => candidate.cardId === card.id);
    assert.ok(entry?.combined, `${card.id} needs a combined interpretation`);
    if (card.combinedOnly) {
      assert.equal(entry.tarot, undefined, `${card.id} cannot have a Tarot-only interpretation`);
      assert.equal(entry.oracle, undefined, `${card.id} cannot have an Oracle-only interpretation`);
    } else {
      assert.ok(entry.tarot, `${card.id} needs a Tarot interpretation`);
      assert.ok(entry.oracle, `${card.id} needs an Oracle interpretation`);
    }
  }
});

test("projects paired cards into stable 78-card Tarot and Oracle decks", () => {
  assert.match(
    cardsSource,
    /export\s+type\s+CardDeck\s*=\s*"tarot"\s*\|\s*"oracle"/,
    "the two projected deck names must remain a closed TypeScript union",
  );

  const tarotCards = getCardsForReadingLens("tarot");
  const oracleCards = getCardsForReadingLens("oracle");
  const mirraCards = getCardsForReadingLens("combined");
  const mixedCards = getCardsForReadingLens("mixed");
  const ids = (cards) => cards.map((card) => card.id);

  assert.equal(tarotCards.length, 78);
  assert.equal(oracleCards.length, 78);
  assert.equal(new Set(ids(tarotCards)).size, 78);
  assert.equal(new Set(ids(oracleCards)).size, 78);
  assert.deepEqual(
    ids(tarotCards),
    ids(oracleCards),
    "both views must retain the same stable physical-card IDs and order",
  );
  assert.ok(tarotCards.every((card) => !card.combinedOnly));
  assert.ok(oracleCards.every((card) => !card.combinedOnly));
  assert.deepEqual(ids(mirraCards), ids(CARDS));
  assert.deepEqual(ids(mixedCards), ids(CARDS));

  for (const card of tarotCards) {
    assert.equal(getCardDeckName(card, "en", "tarot"), card.prismaTitleEn);
    assert.equal(
      getCardDeckName(card, "nl", "tarot"),
      card.prismaTitleNl ?? card.prismaTitleEn,
    );
    assert.equal(getCardDeckName(card, "en", "oracle"), card.cosmaTitleEn);
    assert.equal(
      getCardDeckName(card, "nl", "oracle"),
      card.cosmaAliasNl ?? card.cosmaTitleEn,
    );
    assert.equal(getCardDeckPrintedName(card, "tarot"), card.prismaTitleEn);
    assert.equal(getCardDeckPrintedName(card, "oracle"), card.cosmaTitleEn);
  }

  const threeOfWands = tarotCards.find((card) => card.id === "wands-three");
  assert.ok(threeOfWands);
  assert.ok(getCardDeckSearchTerms(threeOfWands, "tarot").includes("3 of Wands"));
  assert.ok(!getCardDeckSearchTerms(threeOfWands, "tarot").includes("Three of Embers"));
  assert.ok(getCardDeckSearchTerms(threeOfWands, "oracle").includes("3 of Embers"));
  assert.ok(!getCardDeckSearchTerms(threeOfWands, "oracle").includes("Three of Wands"));
});

test("preserves legacy Combined and mixed-position interpretation lenses", () => {
  const pull = { lensOverride: null };

  assert.equal(getEffectivePullLens({ readingLens: "combined" }, pull), "combined");
  assert.equal(
    getEffectivePullLens({ readingLens: "combined" }, { lensOverride: "tarot" }),
    "tarot",
  );
  assert.equal(
    getEffectivePullLens({ readingLens: "combined" }, { lensOverride: "oracle" }),
    "oracle",
  );
  assert.equal(getEffectivePullLens({ readingLens: "mixed" }, pull, "combined"), "combined");
  assert.equal(getEffectivePullLens({ readingLens: "mixed" }, pull, "tarot"), "tarot");
  assert.equal(
    getEffectivePullLens({ readingLens: "mixed" }, { lensOverride: "oracle" }, "combined"),
    "oracle",
  );
  assert.equal(
    getEffectivePullLens({ readingLens: "oracle" }, { lensOverride: "tarot" }),
    "tarot",
  );
  assert.equal(
    getEffectivePullLens({ readingLens: "tarot" }, { lensOverride: "combined" }),
    "combined",
  );
  assert.equal(getEffectivePullLens({ readingLens: "tarot" }, pull, undefined, true), "combined");
});

test("ships substantial, original bilingual meanings and reflection prompts", () => {
  const meanings = new Set();
  for (const entry of CARD_INTERPRETATIONS) {
    for (const lens of ["combined", "tarot", "oracle"]) {
      const perspective = entry[lens];
      if (!perspective) continue;

      for (const language of ["en", "nl"]) {
        assert.equal(
          perspective.keywords[language].length,
          3,
          `${entry.cardId}/${lens}/${language} must have exactly three keywords`,
        );
        assert.equal(
          new Set(perspective.keywords[language].map((keyword) => keyword.toLocaleLowerCase(language))).size,
          3,
          `${entry.cardId}/${lens}/${language} keywords must be unique`,
        );

        for (const orientation of ["upright", "reversed"]) {
          const meaning = perspective[orientation][language].trim();
          const wordCount = meaning.split(/\s+/u).length;
          assert.ok(wordCount >= 20, `${entry.cardId}/${lens}/${orientation}/${language} is too short`);
          assert.ok(wordCount <= 45, `${entry.cardId}/${lens}/${orientation}/${language} is too long`);
          assert.ok(!meanings.has(meaning), `${entry.cardId}/${lens}/${orientation}/${language} duplicates another meaning`);
          assert.doesNotMatch(meaning, /James R\.? Eads|guidebook|gidsboek|official meaning|officiële betekenis/iu);
          assert.doesNotMatch(meaning, /^(?:Reversed|Omgekeerd),/u, `${entry.cardId}/${lens}/${orientation}/${language} repeats the visible orientation label`);
          if (language === "en") {
            assert.doesNotMatch(
              meaning,
              /\b(?:behavior|center|color|defense|fulfillment|honor|judgment|labor|organize|prioritize|rationalize|recognize)\b/iu,
              `${entry.cardId}/${lens}/${orientation}/en must follow en-GB spelling`,
            );
          }
          meanings.add(meaning);
        }

        const reflection = perspective.reflection[language].trim();
        assert.ok(reflection.endsWith("?"), `${entry.cardId}/${lens}/${language} reflection must be a question`);
        assert.ok(reflection.split(/\s+/u).length <= 18, `${entry.cardId}/${lens}/${language} reflection is too long`);
      }
    }
  }
});

test("reveals the active interpretation only after the reader writes first", async () => {
  const [component, copy, styles] = await Promise.all([
    readFile(new URL("../app/components/TarotApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/i18n.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /getInterpretationPerspective\(cardInterpretation, effectiveLens\)/);
  assert.match(component, /interpretationPerspective\[activePull\.orientation\]\[language\]/);
  assert.match(component, /revealedInterpretationKeys/);
  assert.match(component, /isInterpretationRevealed/);
  assert.match(component, /className="reader-interpretation-panel"/);
  assert.match(component, /className="interpretation-panel"/);
  assert.match(component, /aria-controls="card-interpretation-panel"/);
  assert.match(component, /"interpretation\.reveal"/);
  assert.match(component, /"interpretation\.updated"/);
  assert.match(component, /interpretationPerspective\.reflection\[language\]/);
  assert.ok(
    component.indexOf('className="reader-interpretation-panel"') <
      component.indexOf('className="interpretation-panel"'),
    "the reader's interpretation field must precede the companion interpretation",
  );
  assert.match(
    component,
    /\{[^{}]*\bisInterpretationRevealed\b[^{}]*&&\s*\([\s\S]*?className="interpretation-panel"/,
    "the companion panel must be gated by an explicit reveal state",
  );
  assert.match(
    component,
    /activePull\.interpretation\.trim\(\)/,
    "blank or whitespace-only reader text must not unlock the companion interpretation",
  );
  assert.match(component, /interpretationCardId:\s*activePull\.cardId === card\.id/);
  assert.match(component, /activePull\.interpretationCardId \?\? activePull\.cardId/);
  assert.match(component, /activePull\.interpretationCardId === activeCard\?\.id/);
  assert.match(component, /aria-pressed=\{effectiveLens === deck\}/);
  assert.match(
    component,
    /activePull\.lensOverride \?\? activePosition\?\.defaultLens \?\? pickerDeck/,
    "card selection must preserve Dual Aspect's per-position default lens",
  );
  assert.ok(
    [...copy.matchAll(/"interpretation\.reveal"\s*:/g)].length >= 2,
    "the reveal action must be localized in English and Dutch",
  );
  assert.match(copy, /"interpretation\.disclaimer"/);
  assert.match(styles, /\.reader-interpretation-panel\s*\{/);
  assert.match(styles, /\.interpretation-panel \{/);
  assert.match(styles, /\.interpretation-keywords \{/);
  assert.match(styles, /\.interpretation-reflection \{/);
});
