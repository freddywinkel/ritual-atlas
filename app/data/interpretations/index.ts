import { MAJOR_INTERPRETATIONS } from "./major";
import { SWORDS_PENTACLES_INTERPRETATIONS } from "./swords-pentacles";
import type {
  CardInterpretation,
  InterpretationLens,
  InterpretationPerspective,
} from "./types";
import { WANDS_CHALICES_INTERPRETATIONS } from "./wands-chalices";

export type {
  CardInterpretation,
  InterpretationLens,
  InterpretationPerspective,
} from "./types";

export const CARD_INTERPRETATIONS: readonly CardInterpretation[] = [
  ...MAJOR_INTERPRETATIONS,
  ...WANDS_CHALICES_INTERPRETATIONS,
  ...SWORDS_PENTACLES_INTERPRETATIONS,
];

const INTERPRETATION_BY_CARD_ID = new Map(
  CARD_INTERPRETATIONS.map((interpretation) => [
    interpretation.cardId,
    interpretation,
  ]),
);

export function getCardInterpretation(cardId: string): CardInterpretation | null {
  return INTERPRETATION_BY_CARD_ID.get(cardId) ?? null;
}

export function getInterpretationPerspective(
  interpretation: CardInterpretation,
  lens: InterpretationLens,
): InterpretationPerspective {
  return interpretation[lens] ?? interpretation.combined;
}
