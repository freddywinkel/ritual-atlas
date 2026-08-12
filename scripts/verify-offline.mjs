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
      .find((button) => button.textContent.includes("Adjust spread and lens"))?.click();
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

    button("Adjust spread and lens")?.click();
    await waitFor(
      () => !document.querySelector("#setup-advanced-options")?.hidden,
      "expanded spread and lens options",
    );

    const oneCard = [...document.querySelectorAll(".spread-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "One Card");
    const tarot = [...document.querySelectorAll(".lens-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "Prisma · Tarot");
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
    controlFlowSetup.lens !== "Prisma · Tarot" ||
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

    button("Adjust spread and lens")?.click();
    await waitFor(
      () => !document.querySelector("#setup-advanced-options")?.hidden,
      "expanded persisted options",
    );

    const dualAspect = [...document.querySelectorAll(".spread-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "Dual Aspect");
    dualAspect?.click();
    await waitFor(() => selectedChoice(".lens-choice") === "Mixed", "Dual Aspect Mixed lens");
    const combined = [...document.querySelectorAll(".lens-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "Mirra · Combined");
    combined?.click();
    await wait(80);
    const dualAspectLens = {
      selected: selectedChoice(".lens-choice"),
      combinedDisabled: Boolean(combined?.disabled),
    };

    const oneCard = [...document.querySelectorAll(".spread-choice")]
      .find((candidate) => text(candidate.querySelector("strong")) === "One Card");
    oneCard?.click();
    await wait(80);
    combined?.click();
    await wait(80);
    const begin = [...document.querySelectorAll("button")]
      .find((candidate) => text(candidate) === "Begin Reading →");
    begin?.click();
    await waitFor(
      () => document.querySelector("h1")?.textContent?.trim() === "Control flow persistence check",
      "one-card reading",
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
      combined: button("Combined")?.getAttribute("aria-pressed"),
      primary: button("Main card")?.getAttribute("aria-pressed"),
      firstSeen: [...document.querySelectorAll('[role="group"] button[aria-pressed="true"]')]
        .some((candidate) => ["Prisma image", "Cosma image", "Both / shifting", "Unclear"].includes(text(candidate))),
      impression: document.querySelector("#card-impression")?.value,
      interpretation: document.querySelector("#card-interpretation")?.value,
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
      dualAspectLens,
      missingRecovery,
      searchCases,
      selectedSemantics,
      removed,
      resetDefaults,
      reopened,
      laterReflection: document.querySelector("#later-reflection")?.value,
    };
  })()`);

  const searchIncludes = (query, expected) =>
    controlFlowReading.searchCases[query]?.some((name) => name.includes(expected));
  if (
    controlFlowReading.persistedSetup.spread !== "One Card" ||
    controlFlowReading.persistedSetup.lens !== "Prisma · Tarot" ||
    controlFlowReading.persistedSetup.question !== "Control flow persistence check" ||
    controlFlowReading.dualAspectLens.selected !== "Mixed" ||
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
    controlFlowReading.removed.progress !== "0/1" ||
    controlFlowReading.removed.empty !== "Empty position" ||
    controlFlowReading.removed.controlsPresent ||
    controlFlowReading.resetDefaults.upright !== "true" ||
    controlFlowReading.resetDefaults.combined !== "true" ||
    controlFlowReading.resetDefaults.primary !== "true" ||
    controlFlowReading.resetDefaults.firstSeen ||
    controlFlowReading.resetDefaults.impression !== "" ||
    controlFlowReading.resetDefaults.interpretation !== "" ||
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
    const laterReflection = document.querySelector("#later-reflection")?.value;
    document.querySelector('.reading-topbar button[aria-label="Back"]')?.click();
    await waitFor(() => document.querySelector("h1")?.textContent?.trim() === "Journal", "Journal-origin Back");
    return {
      laterReflection,
      backHeading: document.querySelector("h1")?.textContent?.trim(),
      scrollY: window.scrollY,
      focus: document.activeElement?.tagName,
    };
  })()`);

  if (
    controlFlowReload.laterReflection !== "Later reflection survives reload" ||
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
