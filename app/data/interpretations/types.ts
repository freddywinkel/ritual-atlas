export type InterpretationLens = "combined" | "tarot" | "oracle";

export type LocalizedInterpretationText = Readonly<Record<"en" | "nl", string>>;

export interface InterpretationPerspective {
  readonly keywords: Readonly<Record<"en" | "nl", readonly string[]>>;
  readonly upright: LocalizedInterpretationText;
  readonly reversed: LocalizedInterpretationText;
  readonly reflection: LocalizedInterpretationText;
}

export interface CardInterpretation {
  readonly cardId: string;
  readonly combined: InterpretationPerspective;
  readonly tarot?: InterpretationPerspective;
  readonly oracle?: InterpretationPerspective;
}
