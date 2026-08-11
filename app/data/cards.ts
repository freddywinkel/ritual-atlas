export type CardLanguage = "en" | "nl";

export type CardArcana = "major" | "minor" | "combined";

export type TarotSuit = "wands" | "chalices" | "swords" | "pentacles";

export type TarotRank =
  | "ace"
  | "two"
  | "three"
  | "four"
  | "five"
  | "six"
  | "seven"
  | "eight"
  | "nine"
  | "ten"
  | "page"
  | "knight"
  | "queen"
  | "king";

/**
 * Catalog metadata only. The Dutch Cosma value is an app-local alias, not an
 * official translated card title. Meanings and guidebook text intentionally do
 * not belong in this data model.
 */
export interface CardDefinition {
  readonly id: string;
  readonly order: number;
  readonly arcana: CardArcana;
  readonly suit: TarotSuit | null;
  readonly rank: TarotRank | null;
  readonly prismaTitleEn: string;
  readonly prismaTitleNl: string | null;
  readonly cosmaTitleEn: string;
  readonly cosmaAliasNl: string | null;
  readonly searchAliases: readonly string[];
  readonly combinedOnly: boolean;
}

type NumberedRank = Exclude<
  TarotRank,
  "page" | "knight" | "queen" | "king"
>;
type CourtRank = Extract<TarotRank, "page" | "knight" | "queen" | "king">;

interface NumberedRankDefinition {
  readonly id: NumberedRank;
  readonly en: string;
  readonly nl: string;
  readonly numeral: number;
}

interface CourtDefinition {
  readonly rank: CourtRank;
  readonly prismaRankEn: string;
  readonly prismaRankNl: string;
  readonly cosmaTitleEn: string;
  readonly cosmaAliasNl: string;
  readonly rankAliasesNl?: readonly string[];
}

interface MinorSuitDefinition {
  readonly id: TarotSuit;
  readonly orderStart: number;
  readonly prismaSuitEn: string;
  readonly prismaSuitNl: string;
  readonly prismaSuitAliasesEn: readonly string[];
  readonly prismaSuitAliasesNl: readonly string[];
  readonly cosmaSuitEn: string;
  readonly cosmaSuitNl: string;
  readonly courts: readonly CourtDefinition[];
}

const uniqueAliases = (...values: readonly string[]): readonly string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))];

const major = (
  order: number,
  prismaTitleEn: string,
  prismaTitleNl: string,
  cosmaTitleEn: string,
  cosmaAliasNl: string,
  aliases: readonly string[] = [],
): CardDefinition => ({
  id: `major-${String(order).padStart(2, "0")}`,
  order,
  arcana: "major",
  suit: null,
  rank: null,
  prismaTitleEn,
  prismaTitleNl,
  cosmaTitleEn,
  cosmaAliasNl,
  searchAliases: uniqueAliases(
    prismaTitleEn,
    prismaTitleNl,
    cosmaTitleEn,
    cosmaAliasNl,
    ...aliases,
  ),
  combinedOnly: false,
});

const NUMBERED_RANKS: readonly NumberedRankDefinition[] = [
  { id: "ace", en: "Ace", nl: "Aas", numeral: 1 },
  { id: "two", en: "Two", nl: "Twee", numeral: 2 },
  { id: "three", en: "Three", nl: "Drie", numeral: 3 },
  { id: "four", en: "Four", nl: "Vier", numeral: 4 },
  { id: "five", en: "Five", nl: "Vijf", numeral: 5 },
  { id: "six", en: "Six", nl: "Zes", numeral: 6 },
  { id: "seven", en: "Seven", nl: "Zeven", numeral: 7 },
  { id: "eight", en: "Eight", nl: "Acht", numeral: 8 },
  { id: "nine", en: "Nine", nl: "Negen", numeral: 9 },
  { id: "ten", en: "Ten", nl: "Tien", numeral: 10 },
];

const MINOR_SUITS: readonly MinorSuitDefinition[] = [
  {
    id: "wands",
    orderStart: 22,
    prismaSuitEn: "Wands",
    prismaSuitNl: "Staven",
    prismaSuitAliasesEn: ["Rods", "Staves"],
    prismaSuitAliasesNl: ["Stokken"],
    cosmaSuitEn: "Embers",
    cosmaSuitNl: "Sintels",
    courts: [
      {
        rank: "page",
        prismaRankEn: "Page",
        prismaRankNl: "Schildknaap",
        cosmaTitleEn: "The Wanderer",
        cosmaAliasNl: "De Reiziger",
        rankAliasesNl: ["Page", "Knaap"],
      },
      {
        rank: "knight",
        prismaRankEn: "Knight",
        prismaRankNl: "Ridder",
        cosmaTitleEn: "The Shapeshifter",
        cosmaAliasNl: "De Gedaantewisselaar",
      },
      {
        rank: "queen",
        prismaRankEn: "Queen",
        prismaRankNl: "Koningin",
        cosmaTitleEn: "The Mystic",
        cosmaAliasNl: "De Mysticus",
      },
      {
        rank: "king",
        prismaRankEn: "King",
        prismaRankNl: "Koning",
        cosmaTitleEn: "The Protector",
        cosmaAliasNl: "De Beschermer",
      },
    ],
  },
  {
    id: "chalices",
    orderStart: 36,
    prismaSuitEn: "Chalices",
    prismaSuitNl: "Kelken",
    prismaSuitAliasesEn: ["Cups"],
    prismaSuitAliasesNl: ["Bekers"],
    cosmaSuitEn: "Lotuses",
    cosmaSuitNl: "Lotussen",
    courts: [
      {
        rank: "page",
        prismaRankEn: "Page",
        prismaRankNl: "Schildknaap",
        cosmaTitleEn: "The Composer",
        cosmaAliasNl: "De Componist",
        rankAliasesNl: ["Page", "Knaap"],
      },
      {
        rank: "knight",
        prismaRankEn: "Knight",
        prismaRankNl: "Ridder",
        cosmaTitleEn: "The Romantic",
        cosmaAliasNl: "De Romanticus",
      },
      {
        rank: "queen",
        prismaRankEn: "Queen",
        prismaRankNl: "Koningin",
        cosmaTitleEn: "The Mender",
        cosmaAliasNl: "De Hersteller",
      },
      {
        rank: "king",
        prismaRankEn: "King",
        prismaRankNl: "Koning",
        cosmaTitleEn: "The Peacemaker",
        cosmaAliasNl: "De Vredestichter",
      },
    ],
  },
  {
    id: "swords",
    orderStart: 50,
    prismaSuitEn: "Swords",
    prismaSuitNl: "Zwaarden",
    prismaSuitAliasesEn: [],
    prismaSuitAliasesNl: [],
    cosmaSuitEn: "Birds",
    cosmaSuitNl: "Vogels",
    courts: [
      {
        rank: "page",
        prismaRankEn: "Page",
        prismaRankNl: "Schildknaap",
        cosmaTitleEn: "The Weaver",
        cosmaAliasNl: "De Wever",
        rankAliasesNl: ["Page", "Knaap"],
      },
      {
        rank: "knight",
        prismaRankEn: "Knight",
        prismaRankNl: "Ridder",
        cosmaTitleEn: "The Fighter",
        cosmaAliasNl: "De Strijder",
      },
      {
        rank: "queen",
        prismaRankEn: "Queen",
        prismaRankNl: "Koningin",
        cosmaTitleEn: "The Dreamer",
        cosmaAliasNl: "De Dromer",
      },
      {
        rank: "king",
        prismaRankEn: "King",
        prismaRankNl: "Koning",
        cosmaTitleEn: "The Elementalist",
        cosmaAliasNl: "De Elementalist",
      },
    ],
  },
  {
    id: "pentacles",
    orderStart: 64,
    prismaSuitEn: "Pentacles",
    prismaSuitNl: "Pentakels",
    prismaSuitAliasesEn: ["Coins", "Disks"],
    prismaSuitAliasesNl: ["Munten", "Schijven"],
    cosmaSuitEn: "Trees",
    cosmaSuitNl: "Bomen",
    courts: [
      {
        rank: "page",
        prismaRankEn: "Page",
        prismaRankNl: "Schildknaap",
        cosmaTitleEn: "The Pathfinder",
        cosmaAliasNl: "De Padvinder",
        rankAliasesNl: ["Page", "Knaap"],
      },
      {
        rank: "knight",
        prismaRankEn: "Knight",
        prismaRankNl: "Ridder",
        cosmaTitleEn: "The Entertainer",
        cosmaAliasNl: "De Entertainer",
      },
      {
        rank: "queen",
        prismaRankEn: "Queen",
        prismaRankNl: "Koningin",
        cosmaTitleEn: "The Geomancer",
        cosmaAliasNl: "De Geomancer",
      },
      {
        rank: "king",
        prismaRankEn: "King",
        prismaRankNl: "Koning",
        cosmaTitleEn: "The Commander",
        cosmaAliasNl: "De Commandant",
      },
    ],
  },
];

const buildMinorSuit = (
  definition: MinorSuitDefinition,
): readonly CardDefinition[] => {
  const numbered = NUMBERED_RANKS.map((rank, index): CardDefinition => {
    const prismaTitleEn = `${rank.en} of ${definition.prismaSuitEn}`;
    const prismaTitleNl = `${rank.nl} van ${definition.prismaSuitNl}`;
    const cosmaTitleEn = `${rank.en} of ${definition.cosmaSuitEn}`;
    const cosmaAliasNl = `${rank.nl} van ${definition.cosmaSuitNl}`;

    return {
      id: `${definition.id}-${rank.id}`,
      order: definition.orderStart + index,
      arcana: "minor",
      suit: definition.id,
      rank: rank.id,
      prismaTitleEn,
      prismaTitleNl,
      cosmaTitleEn,
      cosmaAliasNl,
      searchAliases: uniqueAliases(
        prismaTitleEn,
        prismaTitleNl,
        cosmaTitleEn,
        cosmaAliasNl,
        `${rank.numeral} of ${definition.prismaSuitEn}`,
        `${rank.numeral} of ${definition.cosmaSuitEn}`,
        `${rank.numeral} van ${definition.prismaSuitNl}`,
        `${rank.numeral} van ${definition.cosmaSuitNl}`,
        ...definition.prismaSuitAliasesEn.map(
          (suit) => `${rank.en} of ${suit}`,
        ),
        ...definition.prismaSuitAliasesNl.map(
          (suit) => `${rank.nl} van ${suit}`,
        ),
      ),
      combinedOnly: false,
    };
  });

  const courts = definition.courts.map(
    (court, index): CardDefinition => {
      const prismaTitleEn = `${court.prismaRankEn} of ${definition.prismaSuitEn}`;
      const prismaTitleNl = `${court.prismaRankNl} van ${definition.prismaSuitNl}`;

      return {
        id: `${definition.id}-${court.rank}`,
        order: definition.orderStart + NUMBERED_RANKS.length + index,
        arcana: "minor",
        suit: definition.id,
        rank: court.rank,
        prismaTitleEn,
        prismaTitleNl,
        cosmaTitleEn: court.cosmaTitleEn,
        cosmaAliasNl: court.cosmaAliasNl,
        searchAliases: uniqueAliases(
          prismaTitleEn,
          prismaTitleNl,
          court.cosmaTitleEn,
          court.cosmaAliasNl,
          ...definition.prismaSuitAliasesEn.map(
            (suit) => `${court.prismaRankEn} of ${suit}`,
          ),
          ...definition.prismaSuitAliasesNl.map(
            (suit) => `${court.prismaRankNl} van ${suit}`,
          ),
          ...(court.rankAliasesNl ?? []).map(
            (rank) => `${rank} van ${definition.prismaSuitNl}`,
          ),
        ),
        combinedOnly: false,
      };
    },
  );

  return [...numbered, ...courts];
};

const MAJOR_ARCANA: readonly CardDefinition[] = [
  major(0, "The Fool", "De Dwaas", "Death", "De Dood", [
    "Fool",
    "Dwaas",
  ]),
  major(1, "The Magician", "De Magiër", "The Crow", "De Kraai", [
    "Magician",
    "Magiër",
  ]),
  major(
    2,
    "The High Priestess",
    "De Hogepriesteres",
    "The Swan",
    "De Zwaan",
    ["High Priestess", "Hogepriesteres"],
  ),
  major(3, "The Empress", "De Keizerin", "The Peacock", "De Pauw", [
    "Empress",
    "Keizerin",
  ]),
  major(4, "The Emperor", "De Keizer", "The Pelican", "De Pelikaan", [
    "Emperor",
    "Keizer",
  ]),
  major(
    5,
    "The Hierophant",
    "De Hiërofant",
    "The Phoenix",
    "De Feniks",
    ["Hierophant", "Hiërofant", "De Hogepriester"],
  ),
  major(
    6,
    "The Lovers",
    "De Geliefden",
    "Soulmates",
    "Zielsverwanten",
    ["Lovers", "Geliefden"],
  ),
  major(
    7,
    "The Chariot",
    "De Zegewagen",
    "The Spirit Plane",
    "De Geestenwereld",
    ["Chariot", "Zegewagen", "Het Zielsrijk"],
  ),
  major(8, "Strength", "Kracht", "The Orbs", "De Sferen", [
    "De Lichtbollen",
  ]),
  major(
    9,
    "The Hermit",
    "De Kluizenaar",
    "The Cosmic Tree",
    "De Kosmische Boom",
    ["Hermit", "Kluizenaar"],
  ),
  major(
    10,
    "Wheel of Fortune",
    "Het Rad van Fortuin",
    "Life Map",
    "Levenskaart",
    ["Rad van Fortuin"],
  ),
  major(11, "Justice", "Gerechtigheid", "Karma", "Karma"),
  major(
    12,
    "The Hanged Man",
    "De Gehangene",
    "Sacrifice",
    "Opoffering",
    ["Hanged Man", "Gehangene"],
  ),
  major(13, "Death", "De Dood", "Past Lives", "Vorige Levens"),
  major(
    14,
    "Temperance",
    "Gematigdheid",
    "The Maze",
    "Het Doolhof",
  ),
  major(15, "The Devil", "De Duivel", "The Vessel", "Het Omhulsel", [
    "Devil",
    "Duivel",
    "Het Vat",
  ]),
  major(16, "The Tower", "De Toren", "The Shore", "De Oever", [
    "Tower",
    "Toren",
    "De Kust",
  ]),
  major(17, "The Star", "De Ster", "The Veil", "De Sluier", [
    "Star",
    "Ster",
  ]),
  major(18, "The Moon", "De Maan", "The Bridge", "De Brug", [
    "Moon",
    "Maan",
  ]),
  major(
    19,
    "The Sun",
    "De Zon",
    "Infinite Paths",
    "Oneindige Paden",
    ["Sun", "Zon", "Infinite Pathways"],
  ),
  major(
    20,
    "Judgement",
    "Het Oordeel",
    "The Unknown",
    "Het Onbekende",
    ["Judgment", "Oordeel"],
  ),
  major(
    21,
    "The World",
    "De Wereld",
    "Life on Earth",
    "Leven op Aarde",
    ["World", "Wereld"],
  ),
];

/**
 * Canonical sort order is zero-based: the 22 Majors, the four complete Tarot
 * suits, then the Mirra-only 79th card.
 */
export const CARDS: readonly CardDefinition[] = [
  ...MAJOR_ARCANA,
  ...MINOR_SUITS.flatMap(buildMinorSuit),
  {
    id: "mirra-garden-chimes-water-song",
    order: 78,
    arcana: "combined",
    suit: null,
    rank: null,
    // These are the two face labels of the Mirra-only card, not parent-deck
    // Prisma or Cosma counterparts.
    prismaTitleEn: "Garden Chimes",
    prismaTitleNl: null,
    cosmaTitleEn: "Water Song",
    cosmaAliasNl: null,
    searchAliases: [
      "Garden Chimes",
      "Water Song",
      "Garden Chimes and Water Song",
      "Garden Chimes + Water Song",
      "Garden Chimes / Water Song",
    ],
    combinedOnly: true,
  },
];

if (
  CARDS.length !== 79 ||
  new Set(CARDS.map((card) => card.id)).size !== 79 ||
  new Set(CARDS.map((card) => card.order)).size !== 79
) {
  throw new Error("The Ritual Atlas catalog must contain 79 unique cards.");
}

/**
 * Returns the paired title used in lists and search results. When an unofficial
 * Dutch alias is deliberately absent, the official English name is retained.
 */
export function getCardDisplayName(
  card: CardDefinition,
  language: CardLanguage,
): string {
  const prismaTitle =
    language === "nl"
      ? (card.prismaTitleNl ?? card.prismaTitleEn)
      : card.prismaTitleEn;
  const cosmaTitle =
    language === "nl"
      ? (card.cosmaAliasNl ?? card.cosmaTitleEn)
      : card.cosmaTitleEn;

  if (card.combinedOnly) {
    const conjunction =
      language === "nl" &&
      (card.prismaTitleNl !== null || card.cosmaAliasNl !== null)
        ? " en "
        : " and ";
    return `${prismaTitle}${conjunction}${cosmaTitle}`;
  }

  return `${prismaTitle} / ${cosmaTitle}`;
}
