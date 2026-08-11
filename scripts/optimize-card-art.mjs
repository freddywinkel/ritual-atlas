import { mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const projectRoot = process.cwd();
const archivedSourceDirectory = path.join(projectRoot, "art-source", "cards");
const publicArtDirectory = path.join(projectRoot, "public", "art", "cards");
const sourceDirectory = existsSync(archivedSourceDirectory)
  ? archivedSourceDirectory
  : publicArtDirectory;
const outputDirectory = publicArtDirectory;
const targetWidth = 900;
const targetHeight = 1555;
const quality = 87;

await mkdir(outputDirectory, { recursive: true });
const sourceFiles = (await readdir(sourceDirectory))
  .filter((file) => file.toLowerCase().endsWith(".png"))
  .sort();

if (!sourceFiles.length) {
  throw new Error(`No PNG card sources found in ${sourceDirectory}`);
}

const results = [];
for (const file of sourceFiles) {
  const input = path.join(sourceDirectory, file);
  const output = path.join(outputDirectory, `${path.parse(file).name}.webp`);
  const metadata = await sharp(input).metadata();

  if (!metadata.width || !metadata.height || metadata.width < 600 || metadata.height < 900) {
    throw new Error(`${file} is too small or has unreadable dimensions.`);
  }

  await sharp(input)
    .rotate()
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "cover",
      position: "centre",
    })
    .webp({ quality, effort: 6, smartSubsample: true })
    .toFile(output);

  const [sourceStats, outputStats] = await Promise.all([stat(input), stat(output)]);
  const outputMetadata = await sharp(output).metadata();
  results.push({
    card: path.parse(file).name,
    sourceBytes: sourceStats.size,
    outputBytes: outputStats.size,
    width: outputMetadata.width,
    height: outputMetadata.height,
  });
}

const totals = results.reduce(
  (sum, result) => ({
    sourceBytes: sum.sourceBytes + result.sourceBytes,
    outputBytes: sum.outputBytes + result.outputBytes,
  }),
  { sourceBytes: 0, outputBytes: 0 },
);

console.table(results);
console.log(
  `Optimized ${results.length} cards: ${(totals.sourceBytes / 1024 / 1024).toFixed(1)} MB PNG -> ${(totals.outputBytes / 1024 / 1024).toFixed(1)} MB WebP.`,
);
