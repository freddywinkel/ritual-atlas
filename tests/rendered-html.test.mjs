import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import sharp from "sharp";

const root = new URL("../", import.meta.url);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolutePath) : [absolutePath];
    }),
  );
  return nested.flat();
}

async function computeExportReleaseId(mutateServiceWorker = (source) => source) {
  const directory = fileURLToPath(new URL("../dist/client/", import.meta.url));
  const files = (await listFiles(directory)).sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");

  for (const file of files) {
    const relativePath = path.relative(directory, file).replaceAll(path.sep, "/");
    let contents = await readFile(file);
    if (relativePath === "sw.js") {
      const source = contents.toString("utf8");
      const templated = source.replace(
        /const RELEASE_ID = "[a-f0-9]{16}";/,
        'const RELEASE_ID = "__RITUAL_ATLAS_RELEASE__";',
      );
      contents = Buffer.from(mutateServiceWorker(templated), "utf8");
    }
    hash.update(relativePath);
    hash.update(contents);
  }

  return hash.digest("hex").slice(0, 16);
}

async function render() {
  const html = await readFile(
    new URL("../dist/client/index.html", import.meta.url),
    "utf8",
  );
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `expected source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `expected source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function cacheKey(input) {
  const source = typeof input === "string" ? input : input.url;
  return new URL(source, "http://localhost").href;
}

function createServiceWorkerHarness(serviceWorker, artIndexText, options = {}) {
  const listeners = new Map();
  const cacheStores = new Map();
  const cachePuts = [];
  const deletedCaches = [];
  const openedCaches = [];
  const fetchedRequests = [];
  const initialCacheNames = options.initialCacheNames ?? [];
  for (const name of initialCacheNames) cacheStores.set(name, new Map());

  let activeFetches = 0;
  let maxConcurrentFetches = 0;
  let clientsClaimed = false;

  class ServiceWorkerRequest extends Request {
    constructor(input, init) {
      const source = typeof input === "string" ? input : input.url;
      super(new URL(source, "http://localhost"), init);
    }
  }

  function openCache(name) {
    openedCaches.push(name);
    let entries = cacheStores.get(name);
    if (!entries) {
      entries = new Map();
      cacheStores.set(name, entries);
    }
    return {
      async match(key) {
        return entries.get(cacheKey(key))?.clone();
      },
      async put(key, response) {
        const resolvedKey = cacheKey(key);
        entries.set(resolvedKey, response.clone());
        cachePuts.push({ cacheName: name, key: resolvedKey, status: response.status });
      },
    };
  }

  const caches = {
    async open(name) {
      return openCache(name);
    },
    async keys() {
      return [...cacheStores.keys()];
    },
    async delete(name) {
      deletedCaches.push(name);
      return cacheStores.delete(name);
    },
    async match(request) {
      const key = cacheKey(request);
      for (const entries of cacheStores.values()) {
        const response = entries.get(key);
        if (response) return response.clone();
      }
      return undefined;
    },
  };

  const self = {
    location: {
      href: "http://localhost/ritual-atlas/sw.js",
      origin: "http://localhost",
    },
    clients: {
      async claim() {
        clientsClaimed = true;
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async skipWaiting() {},
  };

  async function mockedFetch(request) {
    const url = new URL(request.url);
    fetchedRequests.push({ url: url.href, pathname: url.pathname, cache: request.cache });
    activeFetches += 1;
    maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
    await Promise.resolve();
    try {
      if (url.pathname === options.failedPath) {
        return new Response("fixture unavailable", { status: 503 });
      }
      if (options.navigationUrl && url.href === options.navigationUrl) {
        return options.navigationResponse.clone();
      }
      if (url.pathname === "/ritual-atlas/") {
        return new Response(
          '<link href="/ritual-atlas/_next/static/app.css"><script src="/ritual-atlas/_next/static/app.js"></script>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.pathname === "/ritual-atlas/art/cards/index.json") {
        return new Response(artIndexText, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("fixture", { status: 200 });
    } finally {
      activeFetches -= 1;
    }
  }

  runInNewContext(serviceWorker, {
    URL,
    Request: ServiceWorkerRequest,
    Response,
    console,
    self,
    caches,
    fetch: mockedFetch,
  });

  async function install() {
    let installPromise;
    listeners.get("install")({
      waitUntil(promise) {
        installPromise = promise;
      },
    });
    assert.ok(installPromise, "service-worker install must extend its lifetime");
    await installPromise;
  }

  async function navigate(url) {
    let responsePromise;
    const backgroundWork = [];
    listeners.get("fetch")({
      request: { url, method: "GET", mode: "navigate" },
      respondWith(promise) {
        responsePromise = promise;
      },
      waitUntil(promise) {
        backgroundWork.push(promise);
      },
    });
    assert.ok(responsePromise, "navigation must be handled by the service worker");
    const response = await responsePromise;
    await Promise.all(backgroundWork);
    return response;
  }

  async function activate() {
    let activatePromise;
    listeners.get("activate")({
      waitUntil(promise) {
        activatePromise = promise;
      },
    });
    assert.ok(activatePromise, "service-worker activation must extend its lifetime");
    await activatePromise;
  }

  return {
    cachePuts,
    cacheStores,
    deletedCaches,
    fetchedRequests,
    install,
    activate,
    navigate,
    openedCaches,
    get clientsClaimed() {
      return clientsClaimed;
    },
    get maxConcurrentFetches() {
      return maxConcurrentFetches;
    },
  };
}

test("exports the Ritual Atlas application shell for GitHub Pages", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Ritual Atlas<\/title>/i);
  assert.match(html, /Ritual Atlas/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});

test("derives the release ID from every exported file including the service worker", async () => {
  const serviceWorker = await readFile(
    new URL("../dist/client/sw.js", import.meta.url),
    "utf8",
  );
  const injectedRelease = serviceWorker.match(
    /const RELEASE_ID = "([a-f0-9]{16})";/,
  )?.[1];
  assert.ok(injectedRelease, "expected a content-derived service-worker release ID");
  assert.equal(await computeExportReleaseId(), injectedRelease);
  assert.notEqual(
    await computeExportReleaseId((source) => `${source}\n// service-worker-only change\n`),
    injectedRelease,
  );
});

test("ships the complete local-first PWA surface", async () => {
  const [
    page,
    layout,
    component,
    cards,
    copy,
    storage,
    manifestText,
    serviceWorker,
    buildPages,
    verifyOffline,
    packageText,
    artIndexText,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TarotApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/cards.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/data/i18n.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/build-pages.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-offline.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/art/cards/index.json", import.meta.url), "utf8"),
  ]);

  const manifest = JSON.parse(manifestText);
  const packageJson = JSON.parse(packageText);
  const artIndex = JSON.parse(artIndexText);

  assert.match(page, /<TarotApp \/>/);
  assert.match(layout, /Ritual Atlas/);
  assert.match(layout, /\/ritual-gate-og\.jpg/);
  assert.match(component, /RitualGateMark/);
  assert.match(component, /loadStateSnapshot\(\)/);
  assert.match(component, /makeBackup\(appState\)/);
  assert.match(component, /\.register\(publicPath\("\/sw\.js"\)\)/);
  assert.match(component, /storageLoadFailed/);
  assert.match(component, /saveState\(backup\.state\)/);
  assert.match(component, /tagDrafts/);
  assert.match(cards, /CARDS\.length !== 79/);
  assert.match(cards, /mirra-garden-chimes-water-song/);
  assert.match(copy, /export const SPREAD_TEMPLATES/);
  assert.match(copy, /"app\.name": "Ritual Atlas"/);
  assert.equal(manifest.name, "Ritual Atlas");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, purpose }) => ({ src, sizes, purpose })),
    [
      { src: "ritual-gate-icon-192.png", sizes: "192x192", purpose: "any" },
      { src: "ritual-gate-icon-512.png", sizes: "512x512", purpose: "any" },
      { src: "ritual-gate-maskable-192.png", sizes: "192x192", purpose: "maskable" },
      { src: "ritual-gate-maskable-512.png", sizes: "512x512", purpose: "maskable" },
    ],
  );
  assert.match(storage, /const STATE_ENVELOPE_FORMAT = "ritual-atlas-state"/);
  assert.match(storage, /value\.format === STATE_ENVELOPE_FORMAT/);
  assert.match(storage, /Stored Ritual Atlas data is invalid/);
  assert.match(serviceWorker, /const RELEASE_ID = "__RITUAL_ATLAS_RELEASE__"/);
  assert.match(serviceWorker, /const CACHE_PREFIX =/);
  assert.match(serviceWorker, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(serviceWorker, /fetchFresh/);
  assert.match(serviceWorker, /CARD_ART_INDEX/);
  assert.match(serviceWorker, /ritual-gate-mark\.svg/);
  assert.match(serviceWorker, /ritual-gate-maskable-512\.png/);
  assert.match(buildPages, /includes\("__RITUAL_ATLAS_RELEASE__"\)/);
  assert.match(buildPages, /replaceAll\("__RITUAL_ATLAS_RELEASE__", releaseId\)/);
  assert.match(verifyOffline, /Dual Aspect/);
  assert.match(verifyOffline, /savedOnDevice/);
  assert.match(verifyOffline, /brand\/ritual-gate-mark\.svg/);
  assert.match(verifyOffline, /persistedDraft/);
  assert.match(verifyOffline, /hero-actions \.secondary-action/);
  assert.equal(packageJson.name, "ritual-atlas");
  assert.equal(packageJson.version, "1.0.0");
  assert.match(packageJson.scripts["verify:offline"], /--pages/);
  assert.match(packageJson.scripts["brand:audit"], /--check/);
  assert.equal(packageJson.dependencies["react-loading-skeleton"], undefined);
  assert.equal(artIndex.format, "ritual-atlas-card-art");
  assert.equal(artIndex.count, 79);
  assert.equal(artIndex.files.length, 79);
  assert.equal(new Set(artIndex.files).size, 79);

  await Promise.all([
    access(new URL("public/brand/ritual-gate-mark.svg", root)),
    access(new URL("public/brand/ritual-gate-micro.svg", root)),
    access(new URL("public/favicon.svg", root)),
    access(new URL("public/ritual-gate-favicon.png", root)),
    access(new URL("public/ritual-gate-icon-192.png", root)),
    access(new URL("public/ritual-gate-icon-512.png", root)),
    access(new URL("public/ritual-gate-maskable-192.png", root)),
    access(new URL("public/ritual-gate-maskable-512.png", root)),
    access(new URL("public/ritual-gate-apple-touch-icon.png", root)),
    access(new URL("public/ritual-gate-og.jpg", root)),
    ...artIndex.files.map((file) => access(new URL(`public/art/cards/${file}`, root))),
  ]);

  await assert.rejects(access(new URL("app/_sites-preview", root)));
});

test("ships deterministic, opaque Ritual Gate brand assets with safe maskable artwork", async () => {
  const pngAssets = [
    ["ritual-gate-favicon.png", 64],
    ["ritual-gate-apple-touch-icon.png", 180],
    ["ritual-gate-icon-192.png", 192],
    ["ritual-gate-icon-512.png", 512],
    ["ritual-gate-maskable-192.png", 192],
    ["ritual-gate-maskable-512.png", 512],
  ];

  for (const [file, size] of pngAssets) {
    const asset = fileURLToPath(new URL(`../public/${file}`, import.meta.url));
    const metadata = await sharp(asset).metadata();
    assert.equal(metadata.format, "png", `${file} must be a PNG`);
    assert.equal(metadata.width, size, `${file} width`);
    assert.equal(metadata.height, size, `${file} height`);
    const stats = await sharp(asset).ensureAlpha().stats();
    assert.equal(stats.channels[3].min, 255, `${file} must be fully opaque`);
  }

  for (const file of ["ritual-gate-maskable-192.png", "ritual-gate-maskable-512.png"]) {
    const asset = fileURLToPath(new URL(`../public/${file}`, import.meta.url));
    const { data, info } = await sharp(asset)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let importantPixels = 0;
    let maximumRadius = 0;

    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        const [red, green, blue] = data.subarray(offset, offset + 3);
        if (red > 130 && green > 90 && blue < 165 && red - blue > 45) {
          importantPixels += 1;
          maximumRadius = Math.max(
            maximumRadius,
            Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2),
          );
        }
      }
    }

    assert.ok(importantPixels > info.width, `${file} must contain the gold mark`);
    assert.ok(
      maximumRadius <= info.width * 0.4 + 1,
      `${file} artwork must remain inside the guaranteed maskable safe circle`,
    );
  }

  const social = await sharp(
    fileURLToPath(new URL("../public/ritual-gate-og.jpg", import.meta.url)),
  ).metadata();
  assert.equal(social.format, "jpeg");
  assert.equal(social.width, 1600);
  assert.equal(social.height, 840);
});

test("guards audited persistence, journal, spread, and security behavior", async () => {
  const [component, copy, layout] = await Promise.all([
    readFile(new URL("../app/components/TarotApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/i18n.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  const importControl = sourceSection(
    component,
    "ref={importInputRef}",
    "onChange={importBackup}",
  );
  assert.match(importControl, /\bhidden\b/);
  assert.match(importControl, /type="file"/);
  assert.match(importControl, /accept="application\/json,\.json"/);
  assert.match(importControl, /tabIndex=\{-1\}/);

  assert.match(component, /saveState\(state, storageRevisionRef\.current\)/);
  assert.match(component, /dirtyStateRef\.current = true;\s+setSaveStatus\("saving"\)/);
  assert.match(component, /new BroadcastChannel\("ritual-atlas-state"\)/);
  assert.match(component, /postMessage\(\{[\s\S]*?type: "state-saved"[\s\S]*?revision/);
  assert.match(component, /const revision = await saveState\(initial\)/);
  assert.doesNotMatch(component, /await clearStoredState\(\)/);
  assert.match(component, /let hasSeenController =/);
  assert.match(component, /if \(hasSeenController\) setUpdateAvailable\(true\)/);

  const globalNotice = sourceSection(component, "{storageConflict ? (", "<main");
  assert.match(globalNotice, /className="notice notice--error" role="alert"/);
  assert.match(globalNotice, /saveStatus === "error"/);
  assert.match(globalNotice, /errors\.staleData/);
  assert.match(globalNotice, /errors\.saveFailed/);
  assert.match(globalNotice, /actions\.exportUnsaved/);

  const freeformUpdate = sourceSection(
    component,
    "function addFreeformPosition()",
    "function removeFreeformPosition()",
  );
  assert.match(freeformUpdate, /status: "draft"/);
  assert.match(freeformUpdate, /activeDraftId: activeReading\.id/);

  const reflectionUpdate = sourceSection(
    component,
    "function addLaterReflection()",
    "async function exportBackup()",
  );
  assert.match(reflectionUpdate, /reflectionDrafts\[activeReading\.id\]/);
  assert.match(reflectionUpdate, /delete next\[activeReading\.id\]/);
  assert.match(component, /value=\{reflectionDrafts\[activeReading\.id\] \?\? ""\}/);

  const dateFormatter = sourceSection(component, "function formatDate(", "function toSpreadSnapshot(");
  assert.match(dateFormatter, /language === "nl" \? "nl-NL" : "en-GB"/);
  assert.match(dateFormatter, /timeZone \? \{ timeZone \} : \{\}/);
  assert.match(dateFormatter, /catch \{/);

  const journalFilter = sourceSection(component, "const filteredReadings = useMemo", "const insights = useMemo");
  assert.match(journalFilter, /\.\.\.card\.searchAliases/);
  assert.match(journalFilter, /laterReflections\.map\(\(reflection\) => reflection\.text\)/);
  assert.match(journalFilter, /pull\.firstImpression/);
  assert.match(journalFilter, /pull\.interpretation/);

  const dualAspect = sourceSection(copy, 'id: "dual-aspect"', 'id: "threshold"');
  assert.deepEqual(
    [...dualAspect.matchAll(/defaultLens: "(tarot|oracle|combined)"/g)].map((match) => match[1]),
    ["tarot", "oracle", "combined"],
  );

  const insightCalculation = sourceSection(component, "const insights = useMemo", "if (!loaded)");
  assert.match(insightCalculation, /spreadCounts\.get\(reading\.spreadSnapshot\.id\)/);
  assert.match(insightCalculation, /spreadCounts\.set\(reading\.spreadSnapshot\.id/);
  assert.match(component, /insights\.spreads\.map\(\(spread\) =>/);
  assert.match(component, /insights\.spreadPatterns/);

  assert.match(layout, /default-src 'self'/);
  assert.match(layout, /connect-src 'self'/);
  assert.match(layout, /object-src 'none'/);
  assert.match(layout, /base-uri 'self'/);
  assert.match(layout, /form-action 'none'/);
  assert.match(layout, /httpEquiv="Content-Security-Policy"/);
  assert.match(layout, /name="referrer" content="no-referrer"/);
});

test("prepares the complete 79-card library with fresh bounded cache writes", async () => {
  const [serviceWorker, artIndexText] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/art/cards/index.json", import.meta.url), "utf8"),
  ]);
  const artIndex = JSON.parse(artIndexText);
  const harness = createServiceWorkerHarness(serviceWorker, artIndexText);

  await harness.install();

  assert.equal(new Set(harness.openedCaches).size, 1);
  const cacheName = harness.openedCaches[0];
  assert.match(cacheName, /^ritual-atlas-ritual-atlas-/);
  const storedPaths = harness.cachePuts
    .filter((entry) => entry.cacheName === cacheName)
    .map((entry) => new URL(entry.key, "http://localhost").pathname);
  const expectedArt = artIndex.files.map((file) => `/ritual-atlas/art/cards/${file}`);
  assert.equal(expectedArt.length, 79);
  assert.deepEqual(
    storedPaths.filter((path) => path.startsWith("/ritual-atlas/art/cards/") && path.endsWith(".webp")),
    expectedArt,
  );
  assert.ok(storedPaths.includes("/ritual-atlas/"));
  assert.ok(storedPaths.includes("/ritual-atlas/art/cards/index.json"));
  for (const brandPath of [
    "/ritual-atlas/favicon.svg",
    "/ritual-atlas/ritual-gate-favicon.png",
    "/ritual-atlas/ritual-gate-icon-192.png",
    "/ritual-atlas/ritual-gate-icon-512.png",
    "/ritual-atlas/ritual-gate-maskable-192.png",
    "/ritual-atlas/ritual-gate-maskable-512.png",
    "/ritual-atlas/ritual-gate-apple-touch-icon.png",
    "/ritual-atlas/brand/ritual-gate-mark.svg",
    "/ritual-atlas/brand/ritual-gate-micro.svg",
    "/ritual-atlas/ritual-gate-og.jpg",
  ]) {
    assert.ok(storedPaths.includes(brandPath), `${brandPath} must be precached`);
  }
  assert.ok(
    harness.fetchedRequests.every((request) => request.cache === "reload"),
    "every install fetch should bypass the browser HTTP cache",
  );
  assert.ok(harness.maxConcurrentFetches > 1, "cache batches should fetch concurrently");
  assert.ok(harness.maxConcurrentFetches <= 8, "cache batches must stay bounded");
});

test("a failed install deletes only the current staging cache", async () => {
  const [serviceWorker, artIndexText] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/art/cards/index.json", import.meta.url), "utf8"),
  ]);
  const artIndex = JSON.parse(artIndexText);
  const previousAppCache = "ritual-atlas-ritual-atlas-previous";
  const unrelatedCache = "another-pwa-cache";
  const failedPath = `/ritual-atlas/art/cards/${artIndex.files[0]}`;
  const harness = createServiceWorkerHarness(serviceWorker, artIndexText, {
    failedPath,
    initialCacheNames: [previousAppCache, unrelatedCache],
  });

  await assert.rejects(harness.install(), /Unable to cache .* \(503\)/);

  const currentCache = harness.openedCaches.find(
    (name) => name !== previousAppCache && name !== unrelatedCache,
  );
  assert.ok(currentCache);
  assert.deepEqual(harness.deletedCaches, [currentCache]);
  assert.ok(harness.cacheStores.has(previousAppCache));
  assert.ok(harness.cacheStores.has(unrelatedCache));
  assert.equal(harness.cacheStores.has(currentCache), false);
});

test("activation removes only older Ritual Atlas caches and claims clients", async () => {
  const [serviceWorker, artIndexText] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/art/cards/index.json", import.meta.url), "utf8"),
  ]);
  const previousAppCache = "ritual-atlas-ritual-atlas-previous";
  const unrelatedCache = "another-pwa-cache";
  const harness = createServiceWorkerHarness(serviceWorker, artIndexText, {
    initialCacheNames: [previousAppCache, unrelatedCache],
  });

  await harness.install();
  const currentCache = harness.openedCaches.find(
    (name) => name !== previousAppCache && name !== unrelatedCache,
  );
  assert.ok(currentCache);
  await harness.activate();

  assert.deepEqual(harness.deletedCaches, [previousAppCache]);
  assert.equal(harness.cacheStores.has(previousAppCache), false);
  assert.equal(harness.cacheStores.has(currentCache), true);
  assert.equal(harness.cacheStores.has(unrelatedCache), true);
  assert.equal(harness.clientsClaimed, true);
});

test("returns a live 503 navigation response without poisoning the offline cache", async () => {
  const [serviceWorker, artIndexText] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/art/cards/index.json", import.meta.url), "utf8"),
  ]);
  const navigationUrl = "http://localhost/ritual-atlas/journal";
  const harness = createServiceWorkerHarness(serviceWorker, artIndexText, {
    navigationUrl,
    navigationResponse: new Response("maintenance", { status: 503 }),
  });

  const response = await harness.navigate(navigationUrl);

  assert.equal(response.status, 503);
  assert.equal(await response.text(), "maintenance");
  assert.deepEqual(harness.cachePuts, []);
});
