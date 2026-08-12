"use client";

import { useState, type CSSProperties } from "react";
import Image from "next/image";
import { publicPath } from "../lib/publicPath";

interface ArtworkCard {
  id: string;
  order: number;
  prismaTitleEn: string | null;
  cosmaTitleEn: string | null;
}

interface CardArtworkProps {
  card: ArtworkCard | null;
  reversed?: boolean;
  compact?: boolean;
  alt: string;
}

export function CardArtwork({
  card,
  reversed = false,
  compact = false,
  alt,
}: CardArtworkProps) {
  const [failedCardId, setFailedCardId] = useState<string | null>(null);
  const hasArtwork = Boolean(card && failedCardId !== card.id);
  const hue = card ? (card.order * 29 + 168) % 360 : 188;
  const style = { "--card-hue": `${hue}` } as CSSProperties;

  return (
    <div
      className={`card-artwork${compact ? " card-artwork--compact" : ""}${
        reversed ? " card-artwork--reversed" : ""
      }`}
      style={style}
    >
      {hasArtwork && card ? (
        <Image
          src={publicPath(`/art/cards/${card.id}.webp`)}
          alt={alt}
          draggable={false}
          fill
          sizes={compact ? "96px" : "(max-width: 600px) 86vw, 352px"}
          priority={!compact}
          unoptimized
          onError={() => setFailedCardId(card.id)}
        />
      ) : (
        <div className="card-artwork__pending" role="img" aria-label={alt}>
          <span className="card-artwork__moon" aria-hidden="true" />
          <span className="card-artwork__path" aria-hidden="true" />
          <span className="card-artwork__star card-artwork__star--one" aria-hidden="true" />
          <span className="card-artwork__star card-artwork__star--two" aria-hidden="true" />
          <span className="card-artwork__label">
            {card?.prismaTitleEn ?? card?.cosmaTitleEn ?? alt}
          </span>
        </div>
      )}
    </div>
  );
}
