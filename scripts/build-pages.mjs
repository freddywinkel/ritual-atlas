import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientDirectory = path.join(projectRoot, "dist", "client");
const vinextCli = path.join(projectRoot, "node_modules", "vinext", "dist", "cli.js");

const requestedBasePath =
  process.env.PAGES_BASE_PATH ??
  process.env.NEXT_PUBLIC_BASE_PATH ??
  "/ritual-atlas";
const basePath = requestedBasePath === "/" ? "" : requestedBasePath.replace(/\/$/, "");
const siteOrigin =
  process.env.PAGES_ORIGIN ??
  process.env.NEXT_PUBLIC_SITE_ORIGIN ??
  "https://freddywinkel.github.io";

if (basePath && !/^\/[a-z0-9][a-z0-9._-]*$/i.test(basePath)) {
  throw new Error(`Invalid GitHub Pages base path: ${basePath}`);
}

await rm(path.join(projectRoot, "dist"), { recursive: true, force: true });

await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [vinextCli, "build"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RITUAL_ATLAS_STATIC_EXPORT: "true",
      NEXT_PUBLIC_BASE_PATH: basePath,
      NEXT_PUBLIC_SITE_ORIGIN: siteOrigin,
    },
    stdio: "inherit",
  });

  child.once("error", reject);
  child.once("exit", async (code) => {
    if (code === 0) {
      resolve();
      return;
    }

    // vinext 1.0.0-beta.2 currently trips a Windows libuv assertion after a
    // successful static export. Accept it only when the expected export exists.
    if (process.platform === "win32") {
      try {
        await access(path.join(clientDirectory, "index.html"));
        resolve();
        return;
      } catch {
        // Fall through to the real build failure below.
      }
    }

    reject(new Error(`vinext static export exited with code ${code}.`));
  });
});

if (basePath) {
  const nestedNextDirectory = path.join(
    clientDirectory,
    basePath.slice(1),
    "_next",
  );
  const rootNextDirectory = path.join(clientDirectory, "_next");

  try {
    await access(nestedNextDirectory);
    await rm(rootNextDirectory, { recursive: true, force: true });
    await rename(nestedNextDirectory, rootNextDirectory);
    await rm(path.dirname(nestedNextDirectory), { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await mkdir(clientDirectory, { recursive: true });
await writeFile(path.join(clientDirectory, ".nojekyll"), "", "utf8");

const [html, artIndexText] = await Promise.all([
  readFile(path.join(clientDirectory, "index.html"), "utf8"),
  readFile(path.join(clientDirectory, "art", "cards", "index.json"), "utf8"),
]);
const artIndex = JSON.parse(artIndexText);

if (!html.includes(`<title>Ritual Atlas</title>`)) {
  throw new Error("The GitHub Pages export is missing the Ritual Atlas shell.");
}
if (basePath && !html.includes(`${basePath}/_next/`)) {
  throw new Error("The GitHub Pages export does not contain the configured asset prefix.");
}
if (artIndex?.count !== 79 || artIndex?.files?.length !== 79) {
  throw new Error("The GitHub Pages export does not contain all 79 card assets.");
}

await Promise.all([
  access(path.join(clientDirectory, "_next")),
  access(path.join(clientDirectory, "manifest.webmanifest")),
  access(path.join(clientDirectory, "sw.js")),
  ...artIndex.files.map((file) =>
    access(path.join(clientDirectory, "art", "cards", file)),
  ),
]);

console.log(
  `GitHub Pages export ready at dist/client${basePath ? ` for ${basePath}/` : ""}.`,
);
