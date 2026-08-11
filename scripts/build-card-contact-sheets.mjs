import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { CARDS } from "../app/data/cards.ts";

const projectRoot = process.cwd();
const artDirectory = path.join(projectRoot, "public", "art", "cards");
const outputDirectory = path.join(projectRoot, "artifacts", "card-contact-sheets");
const cellWidth = 200;
const cellHeight = 380;
const imageWidth = 180;
const imageHeight = 329;
const columns = 6;

await mkdir(outputDirectory, { recursive: true });

const groups = [
  ["deck", CARDS],
  ["major", CARDS.filter((card) => card.arcana === "major")],
  ["wands", CARDS.filter((card) => card.suit === "wands")],
  ["chalices", CARDS.filter((card) => card.suit === "chalices")],
  ["swords", CARDS.filter((card) => card.suit === "swords")],
  ["pentacles", CARDS.filter((card) => card.suit === "pentacles")],
  ["combined", CARDS.filter((card) => card.arcana === "combined")],
];

const escapeXml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

for (const [groupName, cards] of groups) {
  const rows = Math.ceil(cards.length / columns);
  const composites = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const image = await sharp(path.join(artDirectory, `${card.id}.webp`))
      .resize(imageWidth, imageHeight, { fit: "contain", background: "#020d12" })
      .toBuffer();
    const label = Buffer.from(
      `<svg width="${cellWidth}" height="41" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#03151c"/>` +
        `<text x="100" y="16" text-anchor="middle" fill="#e8c56f" font-family="Arial" font-size="10">${escapeXml(card.id)}</text>` +
        `<text x="100" y="31" text-anchor="middle" fill="#f4efe4" font-family="Arial" font-size="9">${escapeXml(card.prismaTitleEn)}</text>` +
      `</svg>`,
    );
    const left = (index % columns) * cellWidth;
    const top = Math.floor(index / columns) * cellHeight;
    composites.push({ input: image, left: left + 10, top: top + 8 });
    composites.push({ input: label, left, top: top + 337 });
  }

  const output = path.join(outputDirectory, `${groupName}.jpg`);
  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 3,
      background: "#020d12",
    },
  })
    .composite(composites)
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(output);
  console.log(output);
}
