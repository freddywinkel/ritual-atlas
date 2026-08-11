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
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let uncachedRequestFailed = false;
    try {
      await fetch(${JSON.stringify(pageBasePath + "/offline-network-probe-")} + Date.now(), { cache: "no-store" });
    } catch {
      uncachedRequestFailed = true;
    }
    const cardResponse = await fetch(${JSON.stringify(pageBasePath + "/art/cards/major-21.webp")});
    const startButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent.includes("Start a Reading"));
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
      const saved = [...document.querySelectorAll('[role="status"]')]
        .some((status) => status.textContent.includes("Saved on this device"));
      if (document.querySelector("h1")?.textContent?.trim() === "Reading" && saved) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      title: document.title,
      navigatorOnline: navigator.onLine,
      uncachedRequestFailed,
      cardStatus: cardResponse.status,
      cardBytes: (await cardResponse.arrayBuffer()).byteLength,
      nextHeading: document.querySelector("h1")?.textContent?.trim(),
      mixedSelected,
      savedOnDevice: [...document.querySelectorAll('[role="status"]')]
        .some((status) => status.textContent.includes("Saved on this device")),
    };
  })()`);

  if (
    offlineResult.title !== "Ritual Atlas" ||
    !offlineResult.uncachedRequestFailed ||
    offlineResult.cardStatus !== 200 ||
    offlineResult.cardBytes < 80_000 ||
    offlineResult.nextHeading !== "Reading" ||
    !offlineResult.mixedSelected ||
    !offlineResult.savedOnDevice
  ) {
    throw new Error(`Offline interaction failed: ${JSON.stringify(offlineResult)}`);
  }

  const persistedLoad = cdp.waitForEvent("Page.loadEventFired");
  await cdp.send("Page.reload");
  await persistedLoad;
  const persistedDraft = await evaluate(cdp, `(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const continueButton = [...document.querySelectorAll("button")]
        .find((button) => button.textContent.includes("Continue draft"));
      if (continueButton) {
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
    };
  })()`);

  if (
    persistedDraft.heading !== "Reading" ||
    persistedDraft.spread !== "Dual Aspect" ||
    persistedDraft.position !== "Tarot voice" ||
    persistedDraft.progress !== "0/3" ||
    persistedDraft.hasSaveError
  ) {
    throw new Error(`Persisted draft did not survive an offline reload: ${JSON.stringify(persistedDraft)}`);
  }

  console.log({ installed, offlineResult, persistedDraft });
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
