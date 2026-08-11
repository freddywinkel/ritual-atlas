import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const markPath = path.join(projectRoot, "public", "brand", "ritual-gate-mark.svg");
const microMarkPath = path.join(projectRoot, "public", "brand", "ritual-gate-micro.svg");
const publicDirectory = path.join(projectRoot, "public");
const socialBasePath = path.join(publicDirectory, "og.jpg");
const checkOnly = process.argv.includes("--check");

const markSource = await readFile(markPath, "utf8");
const microMarkSource = await readFile(microMarkPath, "utf8");
const markInner = markSource
  .replace(/^\s*<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "")
  .trim();
const microMarkInner = microMarkSource
  .replace(/^\s*<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "")
  .trim();

function iconSvg(markScale, includeFrame = true, innerMark = markInner) {
  const offset = (100 - 100 * markScale) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <defs>
        <radialGradient id="ritual-night" cx="50%" cy="35%" r="78%">
          <stop offset="0" stop-color="#103A45"/>
          <stop offset="0.58" stop-color="#06232C"/>
          <stop offset="1" stop-color="#03151C"/>
        </radialGradient>
        <linearGradient id="ritual-edge" x1="13" y1="9" x2="88" y2="94" gradientUnits="userSpaceOnUse">
          <stop stop-color="#E8C56F" stop-opacity=".42"/>
          <stop offset=".55" stop-color="#E8C56F" stop-opacity=".08"/>
          <stop offset="1" stop-color="#E8C56F" stop-opacity=".28"/>
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#ritual-night)"/>
      ${includeFrame ? '<rect x="3" y="3" width="94" height="94" rx="20" fill="none" stroke="url(#ritual-edge)" stroke-width=".65"/>' : ""}
      <g transform="translate(${offset} ${offset}) scale(${markScale})">${innerMark}</g>
    </svg>`,
  );
}

const definitions = [
  { file: "favicon.svg", kind: "svg", scale: 0.92, micro: true },
  { file: "ritual-gate-favicon.png", kind: "png", size: 64, scale: 0.92, micro: true },
  { file: "ritual-gate-apple-touch-icon.png", kind: "png", size: 180, scale: 0.92, includeFrame: false },
  { file: "ritual-gate-icon-192.png", kind: "png", size: 192, scale: 0.92, includeFrame: false },
  { file: "ritual-gate-icon-512.png", kind: "png", size: 512, scale: 0.92, includeFrame: false },
  { file: "ritual-gate-maskable-192.png", kind: "png", size: 192, scale: 0.75, includeFrame: false },
  { file: "ritual-gate-maskable-512.png", kind: "png", size: 512, scale: 0.75, includeFrame: false },
  { file: "ritual-gate-og.jpg", kind: "social" },
  // Keep the original URLs valid for clients holding the previous app shell.
  { file: "favicon.png", kind: "png", size: 64, scale: 0.92, micro: true },
  { file: "apple-touch-icon.png", kind: "png", size: 180, scale: 0.92, includeFrame: false },
  { file: "icon-192.png", kind: "png", size: 192, scale: 0.92, includeFrame: false },
  { file: "icon-512.png", kind: "png", size: 512, scale: 0.92, includeFrame: false },
  { file: "icon-maskable-192.png", kind: "png", size: 192, scale: 0.75, includeFrame: false },
  { file: "icon-maskable-512.png", kind: "png", size: 512, scale: 0.75, includeFrame: false },
];

async function render(definition) {
  if (definition.kind === "social") {
    const badge = await sharp(iconSvg(0.9))
      .resize(78, 78, { fit: "fill" })
      .png()
      .toBuffer();
    return sharp(socialBasePath)
      .composite([{ input: badge, left: 20, top: 15 }])
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer();
  }

  const source = iconSvg(
    definition.scale,
    definition.includeFrame,
    definition.micro ? microMarkInner : markInner,
  );
  if (definition.kind === "svg") return source;
  return sharp(source)
    .resize(definition.size, definition.size, { fit: "fill" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

await mkdir(publicDirectory, { recursive: true });

for (const definition of definitions) {
  const target = path.join(publicDirectory, definition.file);
  const expected = await render(definition);

  if (checkOnly) {
    await access(target);
    const actual = await readFile(target);
    if (!actual.equals(expected)) {
      throw new Error(`${definition.file} does not match the Ritual Gate source.`);
    }
    continue;
  }

  await writeFile(target, expected);
  console.log(`Generated public/${definition.file}`);
}

if (checkOnly) {
  console.log("Ritual Gate brand assets match their source.");
}
