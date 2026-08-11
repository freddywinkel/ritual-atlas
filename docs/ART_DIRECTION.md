# Ritual Atlas card art direction

## Creative boundary

Ritual Atlas uses an independent visual language. The illustrations must not
copy, trace, scan, reconstruct, or closely imitate any published James R. Eads,
Prisma Visions, Cosma Visions, or Mirra Visions artwork, card back, border,
composition, logo, or guidebook material. Tarot archetypes and the paired card
titles are prompts for new narrative scenes, not templates to reproduce.

## Shared visual language

- premium, painterly surreal narrative illustration
- one or more expressive human or animal figures where the concept supports it
- midnight teal, deep indigo, mineral green, warm ivory, and restrained
  champagne-gold light
- luminous routes, thresholds, constellations, water, roots, wind, embers, or
  other natural forces used as connective visual grammar
- cinematic depth, tactile brushwork, and gallery-quality detail
- a coherent world across the deck, with different locations, figures, weather,
  gestures, and camera angles so cards do not feel templated
- symbolic integration of the Tarot card and its paired Oracle title without
  relying on copied iconography

## Composition rules

- vertical, edge-to-edge image with no printed border
- no title, caption, number, letter, logo, signature, or watermark
- keep the main face and narrative action inside the central 80% so the image
  remains readable in tall and compact app frames
- preserve a strong silhouette and value structure at thumbnail size
- avoid modern brand marks, celebrity likenesses, photorealistic text, and
  accidental extra limbs or duplicated figures
- reversals are handled by the app rotating the same artwork; do not bake an
  orientation label into the image

## Technical delivery

- source generation: high-resolution PNG archived in `art-source/cards/`, using
  the approved original Three of Wands illustration only as a palette and finish
  reference
- application delivery: optimized WebP in `public/art/cards/<card-id>.webp`
- delivery canvas: 900 × 1555 pixels, center-cropped to a consistent
  physical-card-like ratio
- every file name must match the stable ID in `app/data/cards.ts`
- the production build verifies that all 79 IDs have a corresponding asset

The Three of Wands reference is an original generated asset for this personal
project. No physical lenticular card photography or guidebook reproduction is
used in the app.
