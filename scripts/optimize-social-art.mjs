import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const publicDirectory = path.join(process.cwd(), "public");
const archivedSource = path.join(process.cwd(), "art-source", "og.png");
const source = existsSync(archivedSource)
  ? archivedSource
  : path.join(publicDirectory, "og.png");
const output = path.join(publicDirectory, "og.jpg");

await sharp(source)
  .resize({ width: 1600, withoutEnlargement: true })
  .jpeg({ quality: 88, mozjpeg: true })
  .toFile(output);

const [metadata, outputStats] = await Promise.all([sharp(output).metadata(), stat(output)]);
console.log({ output, width: metadata.width, height: metadata.height, bytes: outputStats.size });
