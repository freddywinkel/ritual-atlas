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
await writeFile(join(temporaryDirectory, "cards.mjs"), transpile(cardsSource, "cards.ts"));

const [{ CARD_INTERPRETATIONS }, { CARDS }] = await Promise.all([
  import(new URL(`file:///${join(temporaryDirectory, "index.mjs").replaceAll("\\", "/")}`)),
  import(new URL(`file:///${join(temporaryDirectory, "cards.mjs").replaceAll("\\", "/")}`)),
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

test("renders the active lens and orientation as a visible reflection aid", async () => {
  const [component, copy, styles] = await Promise.all([
    readFile(new URL("../app/components/TarotApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/i18n.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /getInterpretationPerspective\(cardInterpretation, effectiveLens\)/);
  assert.match(component, /interpretationPerspective\[activePull\.orientation\]\[language\]/);
  assert.match(component, /className="interpretation-panel"/);
  assert.match(component, /aria-controls="card-interpretation-panel"/);
  assert.match(component, /"interpretation\.jump"/);
  assert.match(component, /"interpretation\.updated"/);
  assert.match(component, /interpretationPerspective\.reflection\[language\]/);
  assert.match(copy, /"interpretation\.disclaimer"/);
  assert.match(styles, /\.interpretation-panel \{/);
  assert.match(styles, /\.interpretation-keywords \{/);
  assert.match(styles, /\.interpretation-reflection \{/);
});
