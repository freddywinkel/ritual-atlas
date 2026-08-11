import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { CARDS } from "../app/data/cards.ts";

const artDirectory = path.join(process.cwd(), "public", "art", "cards");
const files = CARDS.map((card) => `${card.id}.webp`);
await Promise.all(files.map((file) => access(path.join(artDirectory, file))));

const index = {
  format: "ritual-atlas-card-art",
  version: 1,
  count: files.length,
  files,
};

await writeFile(
  path.join(artDirectory, "index.json"),
  `${JSON.stringify(index, null, 2)}\n`,
  "utf8",
);
console.log(`Wrote card-art index for ${files.length} cards.`);
