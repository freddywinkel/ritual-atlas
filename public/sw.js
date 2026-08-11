const CACHE_NAME = "ritual-atlas-v6";
const APP_BASE = new URL("./", self.location.href).pathname.replace(/\/$/, "");
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

async function cacheInBatches(cache, assets, batchSize = 8) {
  for (let index = 0; index < assets.length; index += batchSize) {
    await cache.addAll(assets.slice(index, index + batchSize));
  }
}

async function precacheCardArt(cache) {
  const indexResponse = await fetch(new Request(CARD_ART_INDEX, { cache: "reload" }));
  if (!indexResponse.ok) {
    throw new Error("Unable to load the Ritual Atlas card-art index.");
  }

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
  const pageResponse = await fetch(new Request(APP_ROOT, { cache: "reload" }));

  if (!pageResponse.ok) {
    throw new Error("Unable to cache the Ritual Atlas application shell.");
  }

  const pageText = await pageResponse.clone().text();
  const linkedAssets = [...pageText.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => `${url.pathname}${url.search}`)
    .filter((url) => !url.startsWith("/signin-with-chatgpt"));

  await cache.put(APP_ROOT, pageResponse);
  await cache.addAll([...new Set([...CORE_ASSETS, ...linkedAssets])]);
  await precacheCardArt(cache);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    precacheApplicationShell().then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("ritual-atlas-") && key !== CACHE_NAME)
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
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match(APP_ROOT))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
