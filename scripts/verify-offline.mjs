import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const appPort = 3010;
const pagesMode = process.argv.includes("--pages");
const pageBasePath = pagesMode ? "/ritual-atlas" : "";
const appUrl = `http://127.0.0.1:${appPort}${pageBasePath}/`;
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profileDirectory = await mkdtemp(path.join(os.tmpdir(), "ritual-atlas-offline-"));
let server;
let chrome;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    const command = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    server = spawn(command, ["/d", "/s", "/c", `npm.cmd run start -- --port ${appPort}`], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: "ignore",
    });
  }
  await poll(async () => {
    const response = await fetch(appUrl);
    if (!response.ok) throw new Error(`Local production server returned ${response.status}.`);
  });

  chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
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
    const cache = await caches.open("ritual-atlas-v6");
    const keys = await cache.keys();
    return {
      controller: Boolean(navigator.serviceWorker.controller),
      cacheEntries: keys.length,
      cachedCards: keys.filter((request) => request.url.includes("/art/cards/") && request.url.endsWith(".webp")).length,
    };
  })()`);

  if (!installed.controller || installed.cachedCards !== 79) {
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
    return {
      title: document.title,
      navigatorOnline: navigator.onLine,
      uncachedRequestFailed,
      cardStatus: cardResponse.status,
      cardBytes: (await cardResponse.arrayBuffer()).byteLength,
      nextHeading: document.querySelector("h1")?.textContent?.trim(),
    };
  })()`);

  if (
    offlineResult.title !== "Ritual Atlas" ||
    !offlineResult.uncachedRequestFailed ||
    offlineResult.cardStatus !== 200 ||
    offlineResult.cardBytes < 80_000 ||
    offlineResult.nextHeading !== "New Reading"
  ) {
    throw new Error(`Offline interaction failed: ${JSON.stringify(offlineResult)}`);
  }

  console.log({ installed, offlineResult });
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
