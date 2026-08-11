import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { CARDS } from "../app/data/cards.ts";

const artDirectory = path.join(process.cwd(), "public", "art", "cards");
const expected = new Set(CARDS.map((card) => `${card.id}.webp`));
const actual = new Set(
  (await readdir(artDirectory)).filter((file) => file.toLowerCase().endsWith(".webp")),
);
const missing = [...expected].filter((file) => !actual.has(file));
const unexpected = [...actual].filter((file) => !expected.has(file));

async function differenceHash(file) {
  const pixels = await sharp(path.join(artDirectory, file))
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (pixels[y * 9 + x] > pixels[y * 9 + x + 1]) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash;
}

function hammingDistance(left, right) {
  let value = left ^ right;
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

const records = [];
const invalid = [];
for (const file of [...actual].sort()) {
  const fullPath = path.join(artDirectory, file);
  const [metadata, fileStats, hash] = await Promise.all([
    sharp(fullPath).metadata(),
    stat(fullPath),
    differenceHash(file),
  ]);
  const record = {
    file,
    width: metadata.width,
    height: metadata.height,
    bytes: fileStats.size,
    hash,
  };
  records.push(record);
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width !== 900 ||
    metadata.height !== 1555 ||
    fileStats.size < 80_000 ||
    fileStats.size > 1_200_000
  ) {
    invalid.push(record);
  }
}

const nearDuplicates = [];
for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
  for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
    const distance = hammingDistance(records[leftIndex].hash, records[rightIndex].hash);
    if (distance <= 4) {
      nearDuplicates.push({
        left: records[leftIndex].file,
        right: records[rightIndex].file,
        distance,
      });
    }
  }
}

console.log({ expected: expected.size, actual: actual.size, missing, unexpected });
if (invalid.length) console.error("Invalid artwork files:", invalid);
if (nearDuplicates.length) console.error("Possible near-duplicate artwork:", nearDuplicates);

if (missing.length || unexpected.length || invalid.length || nearDuplicates.length) {
  process.exitCode = 1;
} else {
  const totalBytes = records.reduce((sum, record) => sum + record.bytes, 0);
  console.log(`Artwork audit passed: ${records.length} cards, ${(totalBytes / 1024 / 1024).toFixed(1)} MB.`);
}
