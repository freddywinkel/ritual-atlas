const RELEASE_ID = "__RITUAL_ATLAS_RELEASE__";
const APP_BASE = new URL("./", self.location.href).pathname.replace(/\/$/, "");
const CACHE_SCOPE = APP_BASE.replace(/^\/+/, "").replace(/[^a-z0-9-]+/gi, "-") || "root";
const CACHE_PREFIX = `ritual-atlas-${CACHE_SCOPE}-`;
const CACHE_NAME = `${CACHE_PREFIX}${RELEASE_ID}`;
const withBase = (path) => `${APP_BASE}${path.startsWith("/") ? path : `/${path}`}`;
const APP_ROOT = `${APP_BASE}/`;
const CORE_ASSETS = [
  withBase("/manifest.webmanifest"),
  withBase("/favicon.png"),
  withBase("/icon-192.png"),
  withBase("/icon-512.png"),
  withBase("/apple-touch-icon.png"),
  withBase("/og.jpg"),
];

const CARD_ART_INDEX = withBase("/art/cards/index.json");

async function fetchFresh(asset) {
  const response = await fetch(new Request(asset, { cache: "reload" }));
  if (!response.ok) {
    throw new Error(`Unable to cache ${asset} (${response.status}).`);
  }
  return response;
}

async function cacheInBatches(cache, assets, batchSize = 8) {
  for (let index = 0; index < assets.length; index += batchSize) {
    const batch = assets.slice(index, index + batchSize);
    await Promise.all(
      batch.map(async (asset) => {
        const response = await fetchFresh(asset);
        await cache.put(asset, response);
      }),
    );
  }
}

async function precacheCardArt(cache) {
  const indexResponse = await fetchFresh(CARD_ART_INDEX);
  const index = await indexResponse.clone().json();
  if (
    index?.format !== "ritual-atlas-card-art" ||
    index?.count !== 79 ||
    !Array.isArray(index.files) ||
    index.files.length !== 79 ||
    index.files.some((file) => !/^[a-z0-9-]+\.webp$/.test(file))
  ) {
    throw new Error("The Ritual Atlas card-art index is invalid.");
  }

  await cache.put(CARD_ART_INDEX, indexResponse);
  await cacheInBatches(
    cache,
    index.files.map((file) => withBase(`/art/cards/${file}`)),
  );
}

async function precacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  const pageResponse = await fetchFresh(APP_ROOT);
  const pageText = await pageResponse.clone().text();
  const appRootUrl = new URL(APP_ROOT, self.location.origin);
  const linkedAssets = [...pageText.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], appRootUrl))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => `${url.pathname}${url.search}`)
    .filter((url) => url !== APP_ROOT && !url.startsWith("/signin-with-chatgpt"));

  await cache.put(APP_ROOT, pageResponse);
  await cacheInBatches(cache, [...new Set([...CORE_ASSETS, ...linkedAssets])]);
  await precacheCardArt(cache);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await precacheApplicationShell();
        await self.skipWaiting();
      } catch (error) {
        await caches.delete(CACHE_NAME);
        throw error;
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())),
            );
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(request)) || (await cache.match(APP_ROOT));
        }),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          event.waitUntil(cache.put(request, response.clone()));
        }
        return response;
      });
    }),
  );
});
