import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Ritual Atlas application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Ritual Atlas<\/title>/i);
  assert.match(html, /Ritual Atlas/);
  assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});

test("ships the complete local-first PWA surface", async () => {
  const [page, layout, component, cards, copy, storage, manifestText, serviceWorker, packageText, artIndexText] =
    await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/components/TarotApp.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/data/cards.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/data/i18n.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/lib/storage.ts", import.meta.url), "utf8"),
      readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
      readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../public/art/cards/index.json", import.meta.url), "utf8"),
    ]);

  const manifest = JSON.parse(manifestText);
  const packageJson = JSON.parse(packageText);
  const artIndex = JSON.parse(artIndexText);

  assert.match(page, /<TarotApp \/>/);
  assert.match(layout, /Ritual Atlas/);
  assert.match(layout, /\/og\.jpg/);
  assert.match(component, /loadState\(\)/);
  assert.match(component, /makeBackup\(appState\)/);
  assert.match(component, /\.register\(publicPath\("\/sw\.js"\)\)/);
  assert.match(component, /storageLoadFailed/);
  assert.match(component, /await saveState\(backup\.state\)/);
  assert.match(component, /tagDrafts/);
  assert.match(cards, /CARDS\.length !== 79/);
  assert.match(cards, /mirra-garden-chimes-water-song/);
  assert.match(copy, /export const SPREAD_TEMPLATES/);
  assert.match(copy, /"app\.name": "Ritual Atlas"/);
  assert.equal(manifest.name, "Ritual Atlas");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons.length, 2);
  assert.match(storage, /isValidDateString/);
  assert.match(storage, /Stored Ritual Atlas data is invalid/);
  assert.match(serviceWorker, /ritual-atlas-v6/);
  assert.match(serviceWorker, /linkedAssets/);
  assert.match(serviceWorker, /CARD_ART_INDEX/);
  assert.match(serviceWorker, /key\.startsWith\("ritual-atlas-"\)/);
  assert.equal(packageJson.name, "ritual-atlas");
  assert.equal(packageJson.dependencies["react-loading-skeleton"], undefined);
  assert.equal(artIndex.format, "ritual-atlas-card-art");
  assert.equal(artIndex.count, 79);
  assert.equal(artIndex.files.length, 79);
  assert.equal(new Set(artIndex.files).size, 79);

  await Promise.all([
    access(new URL("public/icon-192.png", root)),
    access(new URL("public/icon-512.png", root)),
    access(new URL("public/apple-touch-icon.png", root)),
    access(new URL("public/og.jpg", root)),
    ...artIndex.files.map((file) => access(new URL(`public/art/cards/${file}`, root))),
  ]);

  await assert.rejects(access(new URL("app/_sites-preview", root)));
});

test("prepares the complete 79-card library for offline installation", async () => {
  const [serviceWorker, artIndexText] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/art/cards/index.json", import.meta.url), "utf8"),
  ]);
  const artIndex = JSON.parse(artIndexText);
  const listeners = new Map();
  const addedBatches = [];
  const stored = new Map();
  let installPromise;

  class ServiceWorkerRequest extends Request {
    constructor(input, init) {
      const source = typeof input === "string" ? input : input.url;
      super(new URL(source, "http://localhost"), init);
    }
  }

  const cache = {
    async put(key, response) {
      stored.set(typeof key === "string" ? key : key.url, response);
    },
    async addAll(assets) {
      addedBatches.push([...assets]);
    },
  };
  const self = {
    location: {
      href: "http://localhost/ritual-atlas/sw.js",
      origin: "http://localhost",
    },
    clients: { async claim() {} },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async skipWaiting() {},
  };

  runInNewContext(serviceWorker, {
    URL,
    Request: ServiceWorkerRequest,
    Response,
    console,
    self,
    caches: {
      async open() { return cache; },
      async keys() { return []; },
      async delete() { return true; },
      async match() { return undefined; },
    },
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/ritual-atlas/") {
        return new Response('<link href="/ritual-atlas/_next/static/app.css"><script src="/ritual-atlas/_next/static/app.js"></script>', {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (pathname === "/ritual-atlas/art/cards/index.json") {
        return new Response(artIndexText, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("fixture", { status: 200 });
    },
  });

  listeners.get("install")({ waitUntil(promise) { installPromise = promise; } });
  await installPromise;

  const addedAssets = addedBatches.flat();
  const expectedArt = artIndex.files.map((file) => `/ritual-atlas/art/cards/${file}`);
  assert.equal(expectedArt.length, 79);
  assert.deepEqual(
    addedAssets.filter((asset) => asset.startsWith("/ritual-atlas/art/cards/") && asset.endsWith(".webp")),
    expectedArt,
  );
  assert.ok(stored.has("/ritual-atlas/"));
  assert.ok(stored.has("/ritual-atlas/art/cards/index.json"));
  assert.ok(addedBatches.length > 2, "large assets should be cached in bounded batches");
});
