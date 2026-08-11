# Ritual Atlas

Ritual Atlas is a private, bilingual (English/Dutch) PWA for recording physical
tarot and oracle pulls. It is designed around the 79-card structure of the
second-edition Mirra Visions deck, while using an independent visual identity
and no copied guidebook text.

Ritual Atlas is not affiliated with or endorsed by James R. Eads. The public
application contains only original generated illustrations and factual
compatibility references; it does not reproduce the physical deck artwork or
guidebook.

## What is included

- a complete searchable 79-card catalog
- 79 original, card-specific figurative illustrations optimized for the app
- six reading layouts, including a freeform session
- combined, Tarot, Oracle, and mixed reading lenses
- upright/reversed orientation, first-seen aspect, notes, reflections, and tags
- drafts, a searchable journal, and personal pattern insights
- IndexedDB storage that stays in this browser profile
- revision-safe multi-tab storage with an explicit conflict warning
- versioned JSON backup and restore
- an installable manifest and offline service worker
- English and Dutch UI copy

The built-in illustrations were generated specifically for this personal
project from an independent art direction. They do not reproduce the physical
deck imagery, card backs, or guidebook text. Source PNGs are archived locally;
the installable app ships smaller WebP versions and caches the full library for
offline use. The current 79-card delivery set is 25.6 MB in total, with every
image normalized to a 900 × 1555 delivery canvas.

## Privacy model

There is no account, analytics service, remote database, or data API. Readings
are stored only in the browser's IndexedDB. Clearing browser/site data can erase
them, so use **Settings > Export backup** regularly. Hosting the application
does not upload the journal, but the host can still serve the application files.

## Local development

Requirements: Node.js 22.13 or newer.

```powershell
npm.cmd install
npm.cmd run dev
```

The development server prints the local address it selected. On Windows,
`npm.cmd` avoids PowerShell execution-policy problems that can affect `npm.ps1`.

## Verification

```powershell
npx.cmd tsc --noEmit --pretty false
npm.cmd run lint
npm.cmd run brand:audit
npm.cmd test
node --check public\sw.js
npm.cmd run art:audit
npm.cmd run verify:offline
```

`npm.cmd test` performs the GitHub Pages static export and then checks the
rendered app shell, storage invariants, packaged PWA assets, and service-worker
failure paths. `verify:offline` installs the production service
worker in a temporary headless-Chrome profile, confirms all 79 card files are
cached, stops the server, fetches a card image without network access, creates
and autosaves a Dual Aspect draft, reloads offline, and reopens that exact draft.

## Artwork pipeline

```powershell
npm.cmd run art:optimize
npm.cmd run art:audit
npm.cmd run art:index
npm.cmd run art:contact
```

The stable file IDs come from `app/data/cards.ts`. The audit requires one valid,
non-duplicate WebP for every catalog entry. The shared creative boundary and
technical rules are documented in `docs/ART_DIRECTION.md`.

## Brand asset pipeline

The selected Ritual Gate logo is maintained as a scalable SVG source. Generate
or verify the favicon, ordinary PWA icons, maskable icons, Apple touch icon, and
social preview with:

```powershell
npm.cmd run brand:generate
npm.cmd run brand:audit
```

The generated files use dedicated Ritual Gate URLs so browsers receive a clear
icon-change signal. An existing iPhone Home Screen installation can still keep
its previous operating-system icon; if that happens, remove the installed app
and add it to the Home Screen again. Export a journal backup before removing an
installation that already contains readings.

## Installation on iPhone

An iPhone needs the app to be served from an HTTPS address before Safari can
install and run it as a PWA. Open that address in Safari, choose **Share**, then
**Add to Home Screen**, and begin journaling from the installed Home Screen app.
Install before creating the first Reading: Safari and the installed app use
separate local storage. If a Reading already exists in Safari, export a backup
there and restore it inside the installed app. The personal journal remains
device-local. The GitHub Pages application shell and optimized generated artwork
are public, but no journal data is sent to GitHub.

## GitHub Pages

The production PWA is published at:

<https://freddywinkel.github.io/ritual-atlas/>

Pushes to `main` run the type-check, lint, tests, static export, installed/offline
browser verification, and GitHub Pages deployment workflow. Each export gives
the service worker a content-derived release ID and stages a complete fresh
cache before removing older Ritual Atlas caches. The Pages build uses
`/ritual-atlas/` as its public asset path and deploys only `dist/client`; source
artwork, review artifacts, local storage, and development output remain
excluded.
