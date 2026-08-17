import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const appPort = 3010;
const pagesMode = process.argv.includes("--pages");
const pageBasePath = pagesMode ? "/ritual-atlas" : "";
const appUrl = `http://127.0.0.1:${appPort}${pageBasePath}/`;
const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "ritual-atlas-offline-"));
let server;
let chrome;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking for an installed Chromium-based browser.
    }
  }
  throw new Error("Chrome or Chromium was not found. Set CHROME_PATH to run offline verification.");
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

async function findAvailablePort(startingPort) {
  for (let port = startingPort; port < startingPort + 100; port += 1) {
    try {
      await assertPortAvailable(port);
      return port;
    } catch {
      // Try the next local debugging port without disturbing another process.
    }
  }
  throw new Error("No available Chrome debugging port was found.");
}

async function poll(task, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError ?? new Error("Timed out waiting for a local verification dependency.");
}

function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const waiters = new Map();
  let sequence = 0;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    const listeners = waiters.get(message.method) ?? [];
    waiters.delete(message.method);
    listeners.forEach((listener) => listener.resolve(message.params));
  });

  function send(method, params = {}) {
    const id = ++sequence;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  function waitForEvent(method, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      const listener = { resolve, reject };
      waiters.set(method, [...(waiters.get(method) ?? []), listener]);
      setTimeout(() => {
        const current = waiters.get(method) ?? [];
        waiters.set(method, current.filter((candidate) => candidate !== listener));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeout).unref();
    });
  }

  return { send, waitForEvent, close: () => socket.close() };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

function touchPoint(x, y) {
  return {
    x,
    y,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
    id: 0,
  };
}

async function dispatchTouchSwipe(cdp, { startX, startY, endX, endY, steps = 12 }) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint(startX, startY)],
  });
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(
        startX + (endX - startX) * progress,
        startY + (endY - startY) * progress,
      )],
    });
    await wait(16);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await wait(400);
}

async function dispatchTouchTap(cdp, { x, y }) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint(x, y)],
  });
  await wait(40);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await wait(250);
}

try {
  await assertPortAvailable(appPort);
  const debugPort = await findAvailablePort(9231);

  if (pagesMode) {
    server = spawn(
      process.execPath,
      ["scripts/serve-pages.mjs", "--port", String(appPort), "--base-path", pageBasePath],
      {
        cwd: projectRoot,
        windowsHide: true,
        stdio: "ignore",
      },
    );
  } else {
    server = process.platform === "win32"
      ? spawn(
          process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
          ["/d", "/s", "/c", `npm.cmd run start -- --port ${appPort}`],
          { cwd: projectRoot, windowsHide: true, stdio: "ignore" },
        )
      : spawn("npm", ["run", "start", "--", "--port", String(appPort)], {
          cwd: projectRoot,
          stdio: "ignore",
        });
  }
  await poll(async () => {
    const response = await fetch(appUrl);
    if (!response.ok) throw new Error(`Local production server returned ${response.status}.`);
  });

  const chromePath = await findChromePath();
  chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    "about:blank",
  ], { windowsHide: true, stdio: "ignore" });

  const page = await poll(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const pages = await response.json();
    const target = pages.find((candidate) => candidate.type === "page");
    if (!target) throw new Error("Chrome did not expose a page target.");
    return target;
  });

  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  await Promise.all([cdp.send("Page.enable"), cdp.send("Runtime.enable"), cdp.send("Network.enable")]);
  const firstLoad = cdp.waitForEvent("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: appUrl });
  await firstLoad;

  const installed = await evaluate(cdp, `(async () => {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("service worker timeout")), 60000)),
    ]);
    const scope = ${JSON.stringify(pageBasePath)}.replace(/^\\/+/, "").replace(/[^a-z0-9-]+/gi, "-") || "root";
    const prefix = "ritual-atlas-" + scope + "-";
    const cacheNames = (await caches.keys()).filter((name) => name.startsWith(prefix));
    if (cacheNames.length !== 1) throw new Error("expected one active cache, found " + cacheNames.length);
    const cache = await caches.open(cacheNames[0]);
    const keys = await cache.keys();
    return {
      cacheName: cacheNames[0],
      controller: Boolean(navigator.serviceWorker.controller),
      cacheEntries: keys.length,
      cachedCards: keys.filter((request) => request.url.includes("/art/cards/") && request.url.endsWith(".webp")).length,
    };
  })()`);

  if (
    !installed.controller ||
    installed.cachedCards !== 79 ||
    (pagesMode && installed.cacheName.includes("__RITUAL_ATLAS_RELEASE__"))
  ) {
    throw new Error(`Offline installation was incomplete: ${JSON.stringify(installed)}`);
  }

  stopProcessTree(server);
  server = undefined;
  await poll(() => assertPortAvailable(appPort), 10_000);

  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
  const offlineLoad = cdp.waitForEvent("Page.loadEventFired");
  await cdp.send("Page.reload");
  await offlineLoad;

  const offlineResult = await evaluate(cdp, `(async () => {
    async function readStoredSummary() {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ritual-atlas", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const raw = await new Promise((resolve, reject) => {
          const transaction = database.transaction("app-state", "readonly");
          const request = transaction.objectStore("app-state").get("current");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const state = raw?.state ?? raw;
        return {
          revision: raw?.revision ?? 0,
          readings: Array.isArray(state?.readings) ? state.readings.length : -1,
          activeDraft: typeof state?.activeDraftId === "string",
        };
      } finally {
        database.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let uncachedRequestFailed = false;
    try {
      await fetch(${JSON.stringify(pageBasePath + "/offline-network-probe-")} + Date.now(), { cache: "no-store" });
    } catch {
      uncachedRequestFailed = true;
    }
    const cardResponse = await fetch(${JSON.stringify(pageBasePath + "/art/cards/major-21.webp")});
    const brandResponse = await fetch(${JSON.stringify(pageBasePath + "/brand/ritual-gate-mark.svg")});
    const startButton = [...document.querySelectorAll("button")]
      .find((button) => /^Start (?:a|another) Reading$/.test(button.textContent.trim()));
    startButton?.click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelector("h1")?.textContent?.trim() === "New Reading") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const dualAspectButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Dual Aspect"));
    dualAspectButton?.click();
    let mixedSelected = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const mixedButton = [...document.querySelectorAll("button")]
        .find((button) => button.textContent.trim().startsWith("Mixed"));
      mixedSelected = mixedButton?.getAttribute("aria-pressed") === "true";
      if (mixedSelected) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const beginButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Begin Reading"));
    beginButton?.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const saved = document.querySelector(".reading-status-line")?.textContent
        .includes("Saved on this device");
      if (document.querySelector("h1")?.textContent?.trim() === "Reading" && saved) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      title: document.title,
      navigatorOnline: navigator.onLine,
      uncachedRequestFailed,
      cardStatus: cardResponse.status,
      cardBytes: (await cardResponse.arrayBuffer()).byteLength,
      brandStatus: brandResponse.status,
      brandBytes: (await brandResponse.arrayBuffer()).byteLength,
      nextHeading: document.querySelector("h1")?.textContent?.trim(),
      mixedSelected,
      savedOnDevice: document.querySelector(".reading-status-line")?.textContent
        .includes("Saved on this device") ?? false,
      storage: await readStoredSummary(),
    };
  })()`);

  if (
    offlineResult.title !== "Ritual Atlas" ||
    !offlineResult.uncachedRequestFailed ||
    offlineResult.cardStatus !== 200 ||
    offlineResult.cardBytes < 80_000 ||
    offlineResult.brandStatus !== 200 ||
    offlineResult.brandBytes < 500 ||
    offlineResult.nextHeading !== "Reading" ||
    !offlineResult.mixedSelected ||
    !offlineResult.savedOnDevice ||
    offlineResult.storage.revision < 1 ||
    offlineResult.storage.readings !== 1 ||
    !offlineResult.storage.activeDraft
  ) {
    throw new Error(`Offline interaction failed: ${JSON.stringify(offlineResult)}`);
  }

  const navigationUi = await evaluate(cdp, `(async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const activeDraft = document.querySelector(".reading-topbar h1")?.textContent?.trim() === "Reading";
    if (!activeDraft) throw new Error("Expected the offline draft to be open before UI navigation checks.");

    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    await wait(30);
    const homeButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "Ritual Atlas");
    homeButton?.click();
    await wait(50);
    const homeReset = {
      scrollY: window.scrollY,
      heading: document.querySelector("h1")?.textContent?.trim(),
      focus: document.activeElement?.tagName,
    };

    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    await wait(30);
    const startButton = [...document.querySelectorAll("button")]
      .find((button) => /^Start (?:a|another) Reading$/.test(button.textContent.trim()));
    startButton?.click();
    await wait(50);
    const setupReset = {
      scrollY: window.scrollY,
      heading: document.querySelector("h1")?.textContent?.trim(),
      focus: document.activeElement?.tagName,
    };

    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    await wait(30);
    const activeSetupButton = [...document.querySelectorAll(".bottom-nav button")]
      .find((button) => button.textContent.includes("New Reading"));
    activeSetupButton?.click();
    await wait(50);
    const sameScreenReset = {
      scrollY: window.scrollY,
      heading: document.querySelector("h1")?.textContent?.trim(),
      focus: document.activeElement?.tagName,
    };

    return { homeReset, setupReset, sameScreenReset };
  })()`);

  for (const [name, result] of Object.entries(navigationUi)) {
    if (
      result.scrollY !== 0 ||
      result.focus !== "MAIN" ||
      (name === "homeReset" ? result.heading !== "What would you like to explore?" : result.heading !== "New Reading")
    ) {
      throw new Error(`UI navigation did not reset the screen: ${JSON.stringify(navigationUi)}`);
    }
  }

  const persistedLoad = cdp.waitForEvent("Page.loadEventFired");
  await cdp.send("Page.reload");
  await persistedLoad;
  const persistedDraft = await evaluate(cdp, `(async () => {
    async function readStoredSummary() {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ritual-atlas", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const raw = await new Promise((resolve, reject) => {
          const transaction = database.transaction("app-state", "readonly");
          const request = transaction.objectStore("app-state").get("current");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const state = raw?.state ?? raw;
        return {
          revision: raw?.revision ?? 0,
          readings: Array.isArray(state?.readings) ? state.readings.length : -1,
          activeDraft: typeof state?.activeDraftId === "string",
        };
      } finally {
        database.close();
      }
    }
    let continueFound = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const continueButton = [...document.querySelectorAll(".hero-actions button")]
        .find((button) => button.textContent.trim().startsWith("Continue draft"));
      if (continueButton) {
        continueFound = true;
        continueButton.click();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelector("h1")?.textContent?.trim() === "Reading") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      heading: document.querySelector("h1")?.textContent?.trim(),
      spread: document.querySelector(".reading-topbar .eyebrow")?.textContent?.trim(),
      position: document.querySelector(".position-banner h2")?.textContent?.trim(),
      progress: document.querySelector(".reading-status-line [aria-label]")?.textContent?.trim(),
      hasSaveError: Boolean(document.querySelector(".notice--error")),
      continueFound,
      homeButtons: [...document.querySelectorAll("button")]
        .map((button) => button.textContent.trim().replace(/\\s+/g, " "))
        .filter(Boolean)
        .slice(0, 12),
      storage: await readStoredSummary(),
    };
  })()`);

  if (
    persistedDraft.heading !== "Reading" ||
    persistedDraft.spread !== "Dual Aspect" ||
    persistedDraft.position !== "Tarot voice" ||
    persistedDraft.progress !== "0/3" ||
    persistedDraft.hasSaveError ||
    !persistedDraft.continueFound ||
    persistedDraft.storage.revision < 1 ||
    persistedDraft.storage.readings !== 1 ||
    !persistedDraft.storage.activeDraft
  ) {
    throw new Error(`Persisted draft did not survive an offline reload: ${JSON.stringify(persistedDraft)}`);
  }

  await Promise.all([
    cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
      screenOrientation: { angle: 0, type: "portraitPrimary" },
    }),
    cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }),
  ]);

  const touchSetup = await evaluate(cdp, `(async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const waitForHeading = async (expected) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (document.querySelector("h1")?.textContent?.trim() === expected) return;
        await wait(50);
      }
      throw new Error("Timed out waiting for " + expected);
    };

    document.querySelector(".reading-topbar .icon-button")?.click();
    await waitForHeading("What would you like to explore?");
    [...document.querySelectorAll("button")]
      .find((button) => /^Start (?:a|another) Reading$/.test(button.textContent.trim()))?.click();
    await waitForHeading("New Reading");
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Adjust spread and reading mode"))?.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!document.querySelector("#setup-advanced-options")?.hidden) break;
      await wait(50);
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      touchPoints: navigator.maxTouchPoints,
      heading: document.querySelector("h1")?.textContent?.trim(),
      optionsExpanded: !document.querySelector("#setup-advanced-options")?.hidden,
    };
  })()`);

  if (
    touchSetup.width !== 390 ||
    touchSetup.height !== 844 ||
    touchSetup.touchPoints < 1 ||
    touchSetup.heading !== "New Reading" ||
    !touchSetup.optionsExpanded
  ) {
    throw new Error(`Touch emulation was not configured: ${JSON.stringify(touchSetup)}`);
  }

  const spreadBeforeSwipe = await evaluate(cdp, `(async () => {
    const target = [...document.querySelectorAll(".spread-choice")]
      .find((button) => button.querySelector("strong")?.textContent?.trim() === "Panorama");
    if (!target || target.getAttribute("aria-pressed") !== "false") {
      throw new Error("Expected Panorama to be an unselected spread target.");
    }
    const absoluteTop = target.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, absoluteTop - 480), behavior: "auto" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    return {
      scrollY: window.scrollY,
      maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
      selected: document.querySelector('.spread-choice[aria-pressed="true"] strong')?.textContent?.trim(),
      states: [...document.querySelectorAll(".spread-choice")]
        .map((button) => button.getAttribute("aria-pressed")),
      targetPressed: target.getAttribute("aria-pressed"),
      startX: rect.left + rect.width / 2,
      startY: Math.min(rect.bottom - 24, 760),
      endX: rect.left + rect.width / 2,
      endY: Math.max(80, Math.min(rect.bottom - 24, 760) - 260),
    };
  })()`);

  await dispatchTouchSwipe(cdp, spreadBeforeSwipe);
  const spreadAfterSwipe = await evaluate(cdp, `({
    scrollY: window.scrollY,
    selected: document.querySelector('.spread-choice[aria-pressed="true"] strong')?.textContent?.trim(),
    states: [...document.querySelectorAll(".spread-choice")]
      .map((button) => button.getAttribute("aria-pressed")),
    targetPressed: [...document.querySelectorAll(".spread-choice")]
      .find((button) => button.querySelector("strong")?.textContent?.trim() === "Panorama")
      ?.getAttribute("aria-pressed"),
  })`);

  if (
    spreadBeforeSwipe.maxScrollY <= spreadBeforeSwipe.scrollY ||
    spreadAfterSwipe.scrollY < spreadBeforeSwipe.scrollY + 40 ||
    spreadAfterSwipe.selected !== spreadBeforeSwipe.selected ||
    JSON.stringify(spreadAfterSwipe.states) !== JSON.stringify(spreadBeforeSwipe.states) ||
    spreadAfterSwipe.targetPressed !== "false"
  ) {
    throw new Error(`Spread touch scroll failed: ${JSON.stringify({ spreadBeforeSwipe, spreadAfterSwipe })}`);
  }

  const panoramaTapTarget = await evaluate(cdp, `(async () => {
    const target = [...document.querySelectorAll(".spread-choice")]
      .find((button) => button.querySelector("strong")?.textContent?.trim() === "Panorama");
    if (!target) throw new Error("Panorama spread was not found.");
    const absoluteTop = target.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, absoluteTop - 260), behavior: "auto" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await dispatchTouchTap(cdp, panoramaTapTarget);
  const panoramaTapped = await evaluate(cdp, `({
    selected: document.querySelector('.spread-choice[aria-pressed="true"] strong')?.textContent?.trim(),
    pressed: [...document.querySelectorAll(".spread-choice")]
      .find((button) => button.querySelector("strong")?.textContent?.trim() === "Panorama")
      ?.getAttribute("aria-pressed"),
  })`);
  if (panoramaTapped.selected !== "Panorama" || panoramaTapped.pressed !== "true") {
    throw new Error(`Touch tap did not activate the intended spread: ${JSON.stringify(panoramaTapped)}`);
  }

  const readingReady = await evaluate(cdp, `(async () => {
    const beginButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Begin Reading"));
    beginButton?.click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const positions = document.querySelectorAll(".position-map button").length;
      if (document.querySelector("h1")?.textContent?.trim() === "Reading" && positions === 5) {
        return { heading: "Reading", positions };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      heading: document.querySelector("h1")?.textContent?.trim(),
      positions: document.querySelectorAll(".position-map button").length,
    };
  })()`);
  if (readingReady.heading !== "Reading" || readingReady.positions !== 5) {
    throw new Error(`Panorama reading did not open: ${JSON.stringify(readingReady)}`);
  }

  const positionBeforeSwipe = await evaluate(cdp, `(async () => {
    const map = document.querySelector(".position-map");
    if (!map) throw new Error("Position map was not found.");
    map.scrollLeft = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = map.getBoundingClientRect();
    return {
      scrollLeft: map.scrollLeft,
      overflow: map.scrollWidth - map.clientWidth,
      active: map.querySelector('[aria-current="step"]')?.getAttribute("data-position-index"),
      startX: rect.right - 24,
      startY: rect.top + rect.height / 2,
      endX: rect.left + 24,
      endY: rect.top + rect.height / 2,
    };
  })()`);
  await dispatchTouchSwipe(cdp, positionBeforeSwipe);
  const positionAfterSwipe = await evaluate(cdp, `(() => {
    const map = document.querySelector(".position-map");
    return {
      scrollLeft: map?.scrollLeft ?? -1,
      active: map?.querySelector('[aria-current="step"]')?.getAttribute("data-position-index"),
    };
  })()`);
  if (
    positionBeforeSwipe.overflow <= 1 ||
    positionAfterSwipe.scrollLeft <= positionBeforeSwipe.scrollLeft + 1 ||
    positionAfterSwipe.active !== positionBeforeSwipe.active
  ) {
    throw new Error(`Position-map touch scroll failed: ${JSON.stringify({ positionBeforeSwipe, positionAfterSwipe })}`);
  }

  const artworkBeforeSwipe = await evaluate(cdp, `(async () => {
    const target = document.querySelector(".artwork-button");
    if (!target) throw new Error("Artwork button was not found.");
    window.scrollTo({ top: 0, behavior: "auto" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    const startY = Math.min(rect.bottom - 30, 760);
    return {
      scrollY: window.scrollY,
      maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
      pickerOpen: Boolean(document.querySelector(".card-picker")),
      startX: rect.left + rect.width / 2,
      startY,
      endX: rect.left + rect.width / 2,
      endY: Math.max(80, startY - 240),
    };
  })()`);
  await dispatchTouchSwipe(cdp, artworkBeforeSwipe);
  const artworkAfterSwipe = await evaluate(cdp, `({
    scrollY: window.scrollY,
    pickerOpen: Boolean(document.querySelector(".card-picker")),
  })`);
  if (
    artworkBeforeSwipe.pickerOpen ||
    artworkBeforeSwipe.maxScrollY <= artworkBeforeSwipe.scrollY ||
    artworkAfterSwipe.scrollY < artworkBeforeSwipe.scrollY + 40 ||
    artworkAfterSwipe.pickerOpen
  ) {
    throw new Error(`Artwork touch scroll failed: ${JSON.stringify({ artworkBeforeSwipe, artworkAfterSwipe })}`);
  }

  const artworkTapTarget = await evaluate(cdp, `(async () => {
    const target = document.querySelector(".artwork-button");
    if (!target) throw new Error("Artwork button was not found.");
    const absoluteTop = target.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, absoluteTop - 230), behavior: "auto" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: Math.min(rect.top + rect.height / 2, 760) };
  })()`);
  await dispatchTouchTap(cdp, artworkTapTarget);
  const pickerBeforeSwipe = await evaluate(cdp, `(async () => {
    const picker = document.querySelector(".card-picker");
    const results = document.querySelector(".card-results");
    if (!picker || !results) throw new Error("Touch tap did not open the card picker.");
    results.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = results.getBoundingClientRect();
    return {
      open: true,
      scrollTop: results.scrollTop,
      overflow: results.scrollHeight - results.clientHeight,
      selected: results.querySelectorAll("button.is-selected").length,
      startX: rect.left + rect.width / 2,
      startY: rect.bottom - 28,
      endX: rect.left + rect.width / 2,
      endY: rect.top + 28,
    };
  })()`);
  await dispatchTouchSwipe(cdp, pickerBeforeSwipe);
  const pickerAfterSwipe = await evaluate(cdp, `(() => {
    const results = document.querySelector(".card-results");
    return {
      open: Boolean(document.querySelector(".card-picker")),
      scrollTop: results?.scrollTop ?? -1,
      selected: results?.querySelectorAll("button.is-selected").length ?? -1,
    };
  })()`);
  if (
    !pickerBeforeSwipe.open ||
    pickerBeforeSwipe.overflow <= 40 ||
    pickerAfterSwipe.scrollTop < pickerBeforeSwipe.scrollTop + 40 ||
    !pickerAfterSwipe.open ||
    pickerAfterSwipe.selected !== pickerBeforeSwipe.selected
  ) {
    throw new Error(`Card-picker touch scroll failed: ${JSON.stringify({ pickerBeforeSwipe, pickerAfterSwipe })}`);
  }

  const controlFlowSetup = await evaluate(cdp, `(async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const text = (element) => element?.textContent?.trim().replace(/\\s+/g, " ") ?? "";
    const buttonName = (element) => {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
      return element.getAttribute("aria-label") ?? text(clone);
    };
    const button = (label, root = document) => [...root.querySelectorAll("button")]
      .find((candidate) => buttonName(candidate) === label);
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const value = predicate();
        if (value) return value;
        await wait(50);
      }
      throw new Error("Timed out waiting for " + label);
    };
    const setInputValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    document.querySelector('.card-picker button[aria-label="Close"]')?.click();
    await wait(80);
    document.querySelector('.reading-topbar button[aria-label="Back"]')?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "What would you like to explore?",
      "Home after closing the gesture-test reading",
    );

    [...document.querySelectorAll(".bottom-nav button")]
      .find((candidate) => text(candidate).includes("Settings"))?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "Settings",
      "Settings",
    );
    button("Erase local data")?.click();
    const resetDialog = await waitFor(
      () => document.querySelector(".confirmation-dialog"),
      "reset confirmation",
    );
    const resetInput = resetDialog.querySelector("input");
    setInputValue(resetInput, "DELETE");
    await waitFor(
      () => !button("Erase local data", resetDialog)?.disabled,
      "enabled reset action",
    );
    button("Erase local data", resetDialog)?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "What would you like to explore?",
      "Home after reset",
    );

    button("Start a Reading")?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "New Reading",
      "New Reading setup",
    );

    const beginButtons = [...document.querySelectorAll("button")]
      .filter((candidate) => text(candidate) === "Begin Reading →");
    const quickBegin = beginButtons.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    const bottomNavTop = document.querySelector(".bottom-nav")?.getBoundingClientRect().top ?? window.innerHeight;
    const headerBottom = document.querySelector(".mobile-header")?.getBoundingClientRect().bottom ?? 0;
    const quickRect = quickBegin?.getBoundingClientRect();

    button("Adjust spread and reading mode")?.click();
    await waitFor(
      () => !document.querySelector("#setup-advanced-options")?.hidden,
      "expanded spread and lens options",
    );

    const oneCard = [...document.querySelectorAll(".spread-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "One Card");
    const tarot = [...document.querySelectorAll(".lens-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "Tarot deck");
    oneCard?.click();
    tarot?.click();
    const question = document.querySelector("#reading-question");
    setInputValue(question, "Control flow persistence check");
    await wait(800);

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      beginCount: beginButtons.length,
      quickBegin: quickRect
        ? { top: quickRect.top, bottom: quickRect.bottom, height: quickRect.height }
        : null,
      headerBottom,
      bottomNavTop,
      spread: document.querySelector('.spread-choice[aria-pressed="true"] strong')?.textContent?.trim(),
      lens: document.querySelector('.lens-choice[aria-pressed="true"] strong')?.textContent?.trim(),
      question: question?.value,
    };
  })()`);

  if (
    controlFlowSetup.viewport.width !== 390 ||
    controlFlowSetup.viewport.height !== 844 ||
    !controlFlowSetup.quickBegin ||
    controlFlowSetup.quickBegin.top < controlFlowSetup.headerBottom ||
    controlFlowSetup.quickBegin.bottom > controlFlowSetup.bottomNavTop ||
    controlFlowSetup.spread !== "One Card" ||
    controlFlowSetup.lens !== "Tarot deck" ||
    controlFlowSetup.question !== "Control flow persistence check"
  ) {
    throw new Error(`Quick setup did not provide a visible, ready entry path: ${JSON.stringify(controlFlowSetup)}`);
  }

  const setupReload = cdp.waitForEvent("Page.loadEventFired");
  await cdp.send("Page.reload");
  await setupReload;
  const controlFlowReading = await evaluate(cdp, `(async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const text = (element) => element?.textContent?.trim().replace(/\\s+/g, " ") ?? "";
    const buttonName = (element) => {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
      return element.getAttribute("aria-label") ?? text(clone);
    };
    const button = (label, root = document) => [...root.querySelectorAll("button")]
      .find((candidate) => buttonName(candidate) === label);
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const value = predicate();
        if (value) return value;
        await wait(50);
      }
      throw new Error("Timed out waiting for " + label);
    };
    const setInputValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const selectedChoice = (selector) => document.querySelector(selector + '[aria-pressed="true"] strong')?.textContent?.trim();
    const readDeckProjection = async (picker, nativeQuery, crossDeckQuery) => {
      const search = picker.querySelector("input");
      const titles = () => [...picker.querySelectorAll(".card-results > button strong")]
        .map((element) => text(element));
      const initialTitles = titles();
      const projection = {
        resultCount: Number(text(picker.querySelector(".picker-result-count")).match(/\\d+/)?.[0] ?? -1),
        rowCount: initialTitles.length,
        fixedDeck: text(picker.querySelector(".picker-deck-label")),
        hasDeckSwitch: Boolean(picker.querySelector(".deck-switch")),
        hasPairedTitle: initialTitles.some((title) => title.includes(" / ")),
        hasCombinedOnlyRow: Boolean(picker.querySelector(".card-results em")),
      };

      setInputValue(search, nativeQuery);
      await wait(80);
      projection.nativeMatches = titles();
      setInputValue(search, crossDeckQuery);
      await wait(80);
      projection.crossDeckMatches = titles();
      setInputValue(search, "79");
      await wait(80);
      projection.card79Matches = titles();
      return projection;
    };
    const deleteCurrentReading = async (label) => {
      button("Delete")?.click();
      const dialog = await waitFor(() => document.querySelector(".confirmation-dialog"), label + " delete confirmation");
      button("Delete", dialog)?.click();
      await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "Journal", label + " deletion");
      [...document.querySelectorAll(".bottom-nav button")]
        .find((candidate) => text(candidate).includes("Home"))?.click();
      await waitFor(
        () => document.querySelector("h1")?.textContent?.trim() === "What would you like to explore?",
        "Home after " + label + " deletion",
      );
    };
    const openSetup = async (label) => {
      button("Start a Reading")?.click();
      await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "New Reading", label + " setup");
      const options = document.querySelector("#setup-advanced-options");
      if (options?.hidden) button("Adjust spread and reading mode")?.click();
      await waitFor(() => !document.querySelector("#setup-advanced-options")?.hidden, label + " setup options");
    };

    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "What would you like to explore?",
      "Home after setup reload",
    );
    button("Start a Reading")?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "New Reading",
      "persisted setup",
    );
    const persistedSetup = {
      spread: selectedChoice(".spread-choice"),
      lens: selectedChoice(".lens-choice"),
      question: document.querySelector("#reading-question")?.value,
    };

    [...document.querySelectorAll("button")]
      .find((candidate) => text(candidate) === "Begin Reading →")?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "Control flow persistence check",
      "Tarot projection reading",
    );
    button("Complete Reading")?.click();
    const tarotProjectionPicker = await waitFor(
      () => document.querySelector(".card-picker"),
      "Tarot projection picker",
    );
    const tarotProjection = await readDeckProjection(tarotProjectionPicker, "magier", "crow");
    tarotProjectionPicker.querySelector('button[aria-label="Close"]')?.click();
    await waitFor(() => !document.querySelector(".card-picker"), "Tarot projection picker close");
    await deleteCurrentReading("Tarot projection reading");

    await openSetup("Oracle projection");

    const dualAspect = [...document.querySelectorAll(".spread-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "Dual Aspect");
    dualAspect?.click();
    await waitFor(() => selectedChoice(".lens-choice") === "Mixed faces", "Dual Aspect Mixed deck");
    await wait(80);
    const dualAspectLens = {
      selected: selectedChoice(".lens-choice"),
      choiceCount: document.querySelectorAll(".lens-choice").length,
      mirraPresent: [...document.querySelectorAll(".lens-choice")]
        .some((candidate) => text(candidate.querySelector("strong")) === "Mirra · Tarot + Oracle"),
    };

    const oneCard = [...document.querySelectorAll(".spread-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "One Card");
    oneCard?.click();
    await wait(80);
    const oracle = [...document.querySelectorAll(".lens-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "Oracle deck");
    oracle?.click();
    setInputValue(document.querySelector("#reading-question"), "Oracle deck projection check");
    await wait(80);
    [...document.querySelectorAll("button")]
      .find((candidate) => text(candidate) === "Begin Reading →")?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "Oracle deck projection check",
      "Oracle projection reading",
    );
    button("Complete Reading")?.click();
    const oracleProjectionPicker = await waitFor(
      () => document.querySelector(".card-picker"),
      "Oracle projection picker",
    );
    const oracleProjection = await readDeckProjection(oracleProjectionPicker, "crow", "magier");
    oracleProjectionPicker.querySelector('button[aria-label="Close"]')?.click();
    await waitFor(() => !document.querySelector(".card-picker"), "Oracle projection picker close");
    await deleteCurrentReading("Oracle projection reading");

    await openSetup("Mirra control flow");
    const mirraOneCard = [...document.querySelectorAll(".spread-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "One Card");
    mirraOneCard?.click();
    await wait(80);
    const mirra = [...document.querySelectorAll(".lens-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "Mirra · Tarot + Oracle");
    mirra?.click();
    setInputValue(document.querySelector("#reading-question"), "Control flow persistence check");
    await wait(80);
    [...document.querySelectorAll("button")]
      .find((candidate) => text(candidate) === "Begin Reading →")?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "Control flow persistence check",
      "Mirra one-card reading",
    );

    button("Complete Reading")?.click();
    const picker = await waitFor(() => document.querySelector(".card-picker"), "picker for first missing card");
    await waitFor(() => document.activeElement === picker.querySelector("input"), "focused picker search");
    const missingRecovery = {
      pickerOpen: Boolean(picker),
      searchFocused: document.activeElement === picker.querySelector("input"),
      position: document.querySelector('.position-map [aria-current="step"]')?.getAttribute("data-position-index"),
    };
    const search = picker.querySelector("input");
    const searchCases = {};
    for (const query of ["three w", "3 wands", "magier", "25"]) {
      setInputValue(search, query);
      await wait(80);
      searchCases[query] = [...picker.querySelectorAll(".card-results > button strong")]
        .map((element) => text(element));
    }

    setInputValue(search, "three w");
    await wait(80);
    const threeOfWands = [...picker.querySelectorAll(".card-results > button")]
      .find((candidate) => text(candidate.querySelector("strong")).includes("Three of Wands"));
    threeOfWands?.click();
    await waitFor(() => !document.querySelector(".card-picker"), "picker close after selection");

    button("Change card")?.click();
    const reopenedPicker = await waitFor(() => document.querySelector(".card-picker"), "reopened picker");
    const reopenedSearch = reopenedPicker.querySelector("input");
    setInputValue(reopenedSearch, "three w");
    await wait(80);
    const selectedRow = [...reopenedPicker.querySelectorAll(".card-results > button")]
      .find((candidate) => text(candidate.querySelector("strong")).includes("Three of Wands"));
    const selectedSemantics = {
      pressed: selectedRow?.getAttribute("aria-pressed"),
      text: text(selectedRow),
      hasPlus: text(selectedRow).includes("＋"),
    };
    reopenedPicker.querySelector('button[aria-label="Close"]')?.click();
    await waitFor(() => !document.querySelector(".card-picker"), "picker close before card reset");

    const revealButton = button("Reveal companion interpretation");
    const revealGate = {
      meaningInitiallyPresent: Boolean(document.querySelector(".interpretation-meaning")),
      buttonDisabledInitially: Boolean(revealButton?.disabled),
      expandedInitially: revealButton?.getAttribute("aria-expanded"),
    };
    setInputValue(document.querySelector("#card-interpretation"), "   ");
    await wait(80);
    revealGate.whitespaceStillDisabled = Boolean(button("Reveal companion interpretation")?.disabled);
    setInputValue(
      document.querySelector("#card-interpretation"),
      "My own reading comes before the companion interpretation.",
    );
    await waitFor(
      () => !button("Reveal companion interpretation")?.disabled,
      "reader interpretation unlock",
    );
    revealGate.buttonEnabledAfterText = !button("Reveal companion interpretation")?.disabled;
    revealGate.meaningBeforeReveal = Boolean(document.querySelector(".interpretation-meaning"));

    const artwork = document.querySelector(".artwork-button");
    const mirraArtworkBefore = {
      face: artwork?.getAttribute("data-card-face"),
      title: text(document.querySelector(".card-title-block h2")),
      pickerOpen: Boolean(document.querySelector(".card-picker")),
    };
    artwork?.click();
    await waitFor(
      () => document.querySelector(".artwork-button")?.getAttribute("data-card-face") === "oracle",
      "Mirra artwork face toggle",
    );
    const mirraArtworkAfter = {
      face: document.querySelector(".artwork-button")?.getAttribute("data-card-face"),
      title: text(document.querySelector(".card-title-block h2")),
      pickerOpen: Boolean(document.querySelector(".card-picker")),
    };
    const mirraArtworkToggle = { before: mirraArtworkBefore, after: mirraArtworkAfter };

    button("Tarot")?.click();
    await waitFor(
      () => document.querySelector(".artwork-button")?.getAttribute("data-card-face") === "tarot",
      "Tarot face restored",
    );
    button("Reveal companion interpretation")?.click();
    const uprightTarotMeaning = text(await waitFor(
      () => document.querySelector(".interpretation-meaning"),
      "upright Tarot interpretation",
    ));
    revealGate.expandedAfterReveal = button("Hide companion interpretation")?.getAttribute("aria-expanded");
    button("Reversed")?.click();
    await wait(80);
    const reversedTarotMeaning = text(document.querySelector(".interpretation-meaning"));
    button("Oracle")?.click();
    await wait(80);
    const reversedOracleMeaning = text(document.querySelector(".interpretation-meaning"));
    button("Upright")?.click();
    await wait(80);
    const uprightOracleMeaning = text(document.querySelector(".interpretation-meaning"));
    button("Reversed")?.click();
    await wait(80);
    const oracleMode = text(document.querySelector(".interpretation-mode"));

    button("Back")?.click();
    await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "What would you like to explore?", "Home before Dutch switch");
    button("Switch to Dutch")?.click();
    await waitFor(() => document.documentElement.lang === "nl", "Dutch UI");
    [...document.querySelectorAll("button")]
      .find((candidate) => buttonName(candidate).startsWith("Ga verder met het concept"))
      ?.click();
    await waitFor(() => document.querySelector(".interpretation-meaning"), "Dutch interpretation");
    const dutchOracleMeaning = text(document.querySelector(".interpretation-meaning"));
    const dutchMode = text(document.querySelector(".interpretation-mode"));
    const dutchDisclaimer = text(document.querySelector(".interpretation-disclaimer"));
    button("Terug")?.click();
    await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "Wat wil je verkennen?", "Dutch Home");
    button("Schakel over naar Engels")?.click();
    await waitFor(() => document.documentElement.lang === "en", "English UI restored");
    [...document.querySelectorAll("button")]
      .find((candidate) => buttonName(candidate).startsWith("Continue draft"))
      ?.click();
    await waitFor(() => document.querySelector(".interpretation-meaning"), "English interpretation restored");

    const interpretation = {
      uprightTarotMeaning,
      reversedTarotMeaning,
      uprightOracleMeaning,
      reversedOracleMeaning,
      oracleMode,
      dutchOracleMeaning,
      dutchMode,
      dutchDisclaimer,
      reflection: text(document.querySelector(".interpretation-reflection p")),
      keywordCount: document.querySelectorAll(".interpretation-keywords li").length,
    };

    button("Change card")?.click();
    const combinedOnlyPicker = await waitFor(() => document.querySelector(".card-picker"), "picker for card 79");
    setInputValue(combinedOnlyPicker.querySelector("input"), "79");
    await wait(80);
    [...combinedOnlyPicker.querySelectorAll(".card-results > button")]
      .find((candidate) => text(candidate.querySelector("strong")).includes("Garden Chimes"))
      ?.click();
    await waitFor(
      () => document.querySelector(".card-title-block h2")?.textContent?.includes("Garden Chimes"),
      "combined-only card",
    );
    setInputValue(document.querySelector("#card-interpretation"), "");
    await wait(80);
    const combinedRevealInitiallyDisabled = Boolean(button("Reveal companion interpretation")?.disabled);
    const combinedMeaningInitiallyPresent = Boolean(document.querySelector(".interpretation-meaning"));
    setInputValue(
      document.querySelector("#card-interpretation"),
      "My own reading of the unique Mirra card.",
    );
    await waitFor(
      () => !button("Reveal companion interpretation")?.disabled,
      "combined-only reader interpretation unlock",
    );
    button("Reveal companion interpretation")?.click();
    await waitFor(() => document.querySelector(".interpretation-meaning"), "combined-only interpretation");
    const combinedOnly = {
      cardName: text(document.querySelector(".card-title-block h2")),
      artworkFace: document.querySelector(".artwork-button")?.getAttribute("data-card-face") ?? null,
      artworkSwitchable: document.querySelector(".artwork-button")?.classList.contains("artwork-button--switchable") ?? false,
      faceControlCount: document.querySelector('.quick-card-controls [role="group"][aria-label="Card face"]')
        ?.querySelectorAll("button").length ?? 0,
      note: text(document.querySelector(".field-note")),
      revealInitiallyDisabled: combinedRevealInitiallyDisabled,
      meaningInitiallyPresent: combinedMeaningInitiallyPresent,
      meaning: text(document.querySelector(".interpretation-meaning")),
      mode: text(document.querySelector(".interpretation-mode")),
    };

    document.querySelector(".artwork-button")?.click();
    const threeAgainPicker = await waitFor(() => document.querySelector(".card-picker"), "picker after card 79");
    combinedOnly.artworkOpenedPicker = Boolean(threeAgainPicker);
    setInputValue(threeAgainPicker.querySelector("input"), "three w");
    await wait(80);
    [...threeAgainPicker.querySelectorAll(".card-results > button")]
      .find((candidate) => text(candidate.querySelector("strong")).includes("Three of Wands"))
      ?.click();
    await waitFor(
      () => document.querySelector(".card-title-block h2")?.textContent?.includes("Three of Wands"),
      "Three of Wands restored",
    );
    button("Reversed")?.click();
    button("Tarot")?.click();
    button("Jumper")?.click();
    button("Cosma image")?.click();
    setInputValue(document.querySelector("#card-impression"), "Reset this impression");
    setInputValue(document.querySelector("#card-interpretation"), "Reset this interpretation");
    await wait(350);
    button("Remove card")?.click();
    const removeDialog = await waitFor(
      () => document.querySelector(".confirmation-dialog"),
      "remove-card confirmation",
    );
    button("Remove card", removeDialog)?.click();
    await waitFor(() => !document.querySelector(".confirmation-dialog"), "card removal");
    await waitFor(
      () => document.querySelector(".card-title-block h2")?.textContent?.trim() === "Empty position",
      "empty position after card removal",
    );
    const removed = {
      progress: document.querySelector(".reading-status-line [aria-label]")?.textContent?.trim(),
      empty: document.querySelector(".card-title-block h2")?.textContent?.trim(),
      controlsPresent: Boolean(document.querySelector(".reading-controls")),
    };

    button("Add card")?.click();
    const resetPicker = await waitFor(() => document.querySelector(".card-picker"), "picker after removal");
    const resetSearch = resetPicker.querySelector("input");
    setInputValue(resetSearch, "three w");
    await wait(80);
    [...resetPicker.querySelectorAll(".card-results > button")]
      .find((candidate) => text(candidate.querySelector("strong")).includes("Three of Wands"))
      ?.click();
    await waitFor(() => !document.querySelector(".card-picker"), "card reselection");
    const resetDefaults = {
      upright: button("Upright")?.getAttribute("aria-pressed"),
      tarot: button("Tarot")?.getAttribute("aria-pressed"),
      primary: button("Main card")?.getAttribute("aria-pressed"),
      firstSeen: [...document.querySelectorAll('[role="group"] button[aria-pressed="true"]')]
        .some((candidate) => ["Prisma image", "Cosma image", "Both / shifting", "Unclear"].includes(text(candidate))),
      impression: document.querySelector("#card-impression")?.value,
      interpretation: document.querySelector("#card-interpretation")?.value,
    };

    setInputValue(
      document.querySelector("#card-interpretation"),
      "Reader interpretation survives reload",
    );
    await waitFor(
      () => !button("Reveal companion interpretation")?.disabled,
      "reload interpretation unlock",
    );
    button("Reveal companion interpretation")?.click();
    await waitFor(() => document.querySelector(".interpretation-meaning"), "pre-reload companion reveal");
    const revealBeforeCompletion = {
      readerText: document.querySelector("#card-interpretation")?.value,
      meaningPresent: Boolean(document.querySelector(".interpretation-meaning")),
      expanded: button("Hide companion interpretation")?.getAttribute("aria-expanded"),
    };

    button("Complete Reading")?.click();
    await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "Journal", "Journal after completion");
    [...document.querySelectorAll(".reading-preview")]
      .find((candidate) => text(candidate).includes("Control flow persistence check"))
      ?.click();
    await waitFor(() => document.querySelector(".reading-topbar h1")?.textContent?.trim() === "Control flow persistence check", "completed reading");
    button("Reopen Reading")?.click();
    await waitFor(() => button("Complete Reading"), "reopened draft controls");
    const reopened = {
      completeAction: Boolean(button("Complete Reading")),
      reopenAction: Boolean(button("Reopen Reading")),
    };
    button("Complete Reading")?.click();
    await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "Journal", "Journal after recompletion");
    [...document.querySelectorAll(".reading-preview")]
      .find((candidate) => text(candidate).includes("Control flow persistence check"))
      ?.click();
    await waitFor(() => document.querySelector("#later-reflection"), "later reflection field");
    setInputValue(document.querySelector("#later-reflection"), "Later reflection survives reload");
    await wait(800);

    return {
      persistedSetup,
      tarotProjection,
      oracleProjection,
      dualAspectLens,
      missingRecovery,
      searchCases,
      selectedSemantics,
      revealGate,
      mirraArtworkToggle,
      interpretation,
      combinedOnly,
      removed,
      resetDefaults,
      revealBeforeCompletion,
      reopened,
      laterReflection: document.querySelector("#later-reflection")?.value,
    };
  })()`);

  const searchIncludes = (query, expected) =>
    controlFlowReading.searchCases[query]?.some((name) => name.includes(expected));
  if (
    controlFlowReading.persistedSetup.spread !== "One Card" ||
    controlFlowReading.persistedSetup.lens !== "Tarot deck" ||
    controlFlowReading.persistedSetup.question !== "Control flow persistence check" ||
    controlFlowReading.tarotProjection.resultCount !== 78 ||
    controlFlowReading.tarotProjection.rowCount !== 78 ||
    controlFlowReading.tarotProjection.fixedDeck !== "Tarot deck" ||
    controlFlowReading.tarotProjection.hasDeckSwitch ||
    controlFlowReading.tarotProjection.hasPairedTitle ||
    controlFlowReading.tarotProjection.hasCombinedOnlyRow ||
    !controlFlowReading.tarotProjection.nativeMatches.includes("The Magician") ||
    controlFlowReading.tarotProjection.crossDeckMatches.length !== 0 ||
    controlFlowReading.tarotProjection.card79Matches.length !== 0 ||
    controlFlowReading.oracleProjection.resultCount !== 78 ||
    controlFlowReading.oracleProjection.rowCount !== 78 ||
    controlFlowReading.oracleProjection.fixedDeck !== "Oracle deck" ||
    controlFlowReading.oracleProjection.hasDeckSwitch ||
    controlFlowReading.oracleProjection.hasPairedTitle ||
    controlFlowReading.oracleProjection.hasCombinedOnlyRow ||
    !controlFlowReading.oracleProjection.nativeMatches.includes("The Crow") ||
    controlFlowReading.oracleProjection.crossDeckMatches.length !== 0 ||
    controlFlowReading.oracleProjection.card79Matches.length !== 0 ||
    controlFlowReading.dualAspectLens.selected !== "Mixed faces" ||
    controlFlowReading.dualAspectLens.choiceCount !== 1 ||
    controlFlowReading.dualAspectLens.mirraPresent ||
    !controlFlowReading.missingRecovery.pickerOpen ||
    !controlFlowReading.missingRecovery.searchFocused ||
    controlFlowReading.missingRecovery.position !== "0" ||
    !searchIncludes("three w", "Three of Wands") ||
    !searchIncludes("3 wands", "Three of Wands") ||
    !searchIncludes("magier", "Magician") ||
    !searchIncludes("25", "Three of Wands") ||
    controlFlowReading.selectedSemantics.pressed !== "true" ||
    !controlFlowReading.selectedSemantics.text.includes("Selected") ||
    controlFlowReading.selectedSemantics.hasPlus ||
    controlFlowReading.revealGate.meaningInitiallyPresent ||
    !controlFlowReading.revealGate.buttonDisabledInitially ||
    controlFlowReading.revealGate.expandedInitially !== "false" ||
    !controlFlowReading.revealGate.whitespaceStillDisabled ||
    !controlFlowReading.revealGate.buttonEnabledAfterText ||
    controlFlowReading.revealGate.meaningBeforeReveal ||
    controlFlowReading.revealGate.expandedAfterReveal !== "true" ||
    controlFlowReading.mirraArtworkToggle.before.face !== "tarot" ||
    controlFlowReading.mirraArtworkToggle.before.title !== "Three of Wands" ||
    controlFlowReading.mirraArtworkToggle.before.pickerOpen ||
    controlFlowReading.mirraArtworkToggle.after.face !== "oracle" ||
    controlFlowReading.mirraArtworkToggle.after.title !== "Three of Embers" ||
    controlFlowReading.mirraArtworkToggle.after.pickerOpen ||
    new Set([
      controlFlowReading.interpretation.uprightTarotMeaning,
      controlFlowReading.interpretation.reversedTarotMeaning,
      controlFlowReading.interpretation.uprightOracleMeaning,
      controlFlowReading.interpretation.reversedOracleMeaning,
    ]).size !== 4 ||
    controlFlowReading.interpretation.uprightTarotMeaning.length < 70 ||
    controlFlowReading.interpretation.reversedTarotMeaning.length < 70 ||
    controlFlowReading.interpretation.uprightOracleMeaning.length < 70 ||
    controlFlowReading.interpretation.reversedOracleMeaning.length < 70 ||
    controlFlowReading.interpretation.dutchOracleMeaning.length < 70 ||
    !controlFlowReading.interpretation.oracleMode.includes("Oracle") ||
    !controlFlowReading.interpretation.oracleMode.includes("Reversed") ||
    !controlFlowReading.interpretation.dutchMode.includes("Orakel") ||
    !controlFlowReading.interpretation.dutchMode.includes("Omgekeerd") ||
    !controlFlowReading.interpretation.dutchDisclaimer.includes("niet de officiële gids") ||
    !controlFlowReading.interpretation.reflection.endsWith("?") ||
    controlFlowReading.interpretation.keywordCount !== 3 ||
    controlFlowReading.combinedOnly.cardName !== "Garden Chimes and Water Song" ||
    controlFlowReading.combinedOnly.artworkFace !== null ||
    controlFlowReading.combinedOnly.artworkSwitchable ||
    controlFlowReading.combinedOnly.faceControlCount !== 0 ||
    !controlFlowReading.combinedOnly.note.includes("combined interpretation only") ||
    !controlFlowReading.combinedOnly.revealInitiallyDisabled ||
    controlFlowReading.combinedOnly.meaningInitiallyPresent ||
    !controlFlowReading.combinedOnly.artworkOpenedPicker ||
    controlFlowReading.combinedOnly.meaning.length < 70 ||
    !controlFlowReading.combinedOnly.mode.includes("Combined") ||
    controlFlowReading.removed.progress !== "0/1" ||
    controlFlowReading.removed.empty !== "Empty position" ||
    controlFlowReading.removed.controlsPresent ||
    controlFlowReading.resetDefaults.upright !== "true" ||
    controlFlowReading.resetDefaults.tarot !== "true" ||
    controlFlowReading.resetDefaults.primary !== "true" ||
    controlFlowReading.resetDefaults.firstSeen ||
    controlFlowReading.resetDefaults.impression !== "" ||
    controlFlowReading.resetDefaults.interpretation !== "" ||
    controlFlowReading.revealBeforeCompletion.readerText !== "Reader interpretation survives reload" ||
    !controlFlowReading.revealBeforeCompletion.meaningPresent ||
    controlFlowReading.revealBeforeCompletion.expanded !== "true" ||
    !controlFlowReading.reopened.completeAction ||
    controlFlowReading.reopened.reopenAction ||
    controlFlowReading.laterReflection !== "Later reflection survives reload"
  ) {
    throw new Error(`Control-flow regression failed: ${JSON.stringify(controlFlowReading)}`);
  }

  const reflectionReload = cdp.waitForEvent("Page.loadEventFired");
  await cdp.send("Page.reload");
  await reflectionReload;
  const controlFlowReload = await evaluate(cdp, `(async () => {
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const text = (element) => element?.textContent?.trim().replace(/\\s+/g, " ") ?? "";
    const buttonName = (element) => {
      const clone = element.cloneNode(true);
      clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
      return element.getAttribute("aria-label") ?? text(clone);
    };
    const button = (label, root = document) => [...root.querySelectorAll("button")]
      .find((candidate) => buttonName(candidate) === label);
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const value = predicate();
        if (value) return value;
        await wait(50);
      }
      throw new Error("Timed out waiting for " + label);
    };

    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "What would you like to explore?",
      "Home after reflection reload",
    );
    [...document.querySelectorAll(".bottom-nav button")]
      .find((candidate) => text(candidate).includes("Journal"))?.click();
    await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "Journal", "Journal after reload");
    [...document.querySelectorAll(".reading-preview")]
      .find((candidate) => text(candidate).includes("Control flow persistence check"))
      ?.click();
    await waitFor(() => document.querySelector("#later-reflection"), "persisted later reflection");
    const revealButton = button("Reveal companion interpretation");
    const interpretationAfterReload = {
      readerText: document.querySelector("#card-interpretation")?.value,
      meaningPresent: Boolean(document.querySelector(".interpretation-meaning")),
      revealDisabled: Boolean(revealButton?.disabled),
      expanded: revealButton?.getAttribute("aria-expanded"),
    };
    const laterReflection = document.querySelector("#later-reflection")?.value;
    document.querySelector('.reading-topbar button[aria-label="Back"]')?.click();
    await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "Journal", "Journal-origin Back");
    return {
      laterReflection,
      interpretationAfterReload,
      backHeading: document.querySelector("h1")?.textContent?.trim(),
      scrollY: window.scrollY,
      focus: document.activeElement?.tagName,
    };
  })()`);

  if (
    controlFlowReload.laterReflection !== "Later reflection survives reload" ||
    controlFlowReload.interpretationAfterReload.readerText !== "Reader interpretation survives reload" ||
    controlFlowReload.interpretationAfterReload.meaningPresent ||
    controlFlowReload.interpretationAfterReload.revealDisabled ||
    controlFlowReload.interpretationAfterReload.expanded !== "false" ||
    controlFlowReload.backHeading !== "Journal" ||
    controlFlowReload.scrollY !== 0 ||
    controlFlowReload.focus !== "MAIN"
  ) {
    throw new Error(`Reload and origin-navigation regression failed: ${JSON.stringify(controlFlowReload)}`);
  }

  const touchGestures = {
    viewport: touchSetup,
    spread: {
      scrollDelta: spreadAfterSwipe.scrollY - spreadBeforeSwipe.scrollY,
      selectedBefore: spreadBeforeSwipe.selected,
      selectedAfter: spreadAfterSwipe.selected,
    },
    tap: panoramaTapped,
    positionMap: {
      overflow: positionBeforeSwipe.overflow,
      scrollDelta: positionAfterSwipe.scrollLeft - positionBeforeSwipe.scrollLeft,
      activeBefore: positionBeforeSwipe.active,
      activeAfter: positionAfterSwipe.active,
    },
    artwork: {
      scrollDelta: artworkAfterSwipe.scrollY - artworkBeforeSwipe.scrollY,
      pickerOpen: artworkAfterSwipe.pickerOpen,
    },
    picker: {
      overflow: pickerBeforeSwipe.overflow,
      scrollDelta: pickerAfterSwipe.scrollTop - pickerBeforeSwipe.scrollTop,
      selectedBefore: pickerBeforeSwipe.selected,
      selectedAfter: pickerAfterSwipe.selected,
      open: pickerAfterSwipe.open,
    },
  };

  console.log({
    installed,
    offlineResult,
    persistedDraft,
    touchGestures,
    controlFlowSetup,
    controlFlowReading,
    controlFlowReload,
  });
  cdp.close();
} finally {
  stopProcessTree(chrome);
  stopProcessTree(server);
  await wait(750);
  const resolvedProfile = path.resolve(profileDirectory);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (resolvedProfile.startsWith(resolvedTemp) && path.basename(resolvedProfile).startsWith("ritual-atlas-offline-")) {
    await rm(resolvedProfile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  }
}
