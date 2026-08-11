import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const valueFor = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const port = Number(valueFor("--port", "3010"));
const requestedBasePath = valueFor("--base-path", "/ritual-atlas");
const basePath = requestedBasePath === "/" ? "" : requestedBasePath.replace(/\/$/, "");
const root = path.resolve("dist", "client");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".rsc", "text/x-component; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      response.writeHead(404).end("Not found");
      return;
    }

    let relativePath = basePath ? url.pathname.slice(basePath.length) : url.pathname;
    if (relativePath === "" || relativePath === "/") relativePath = "/index.html";
    const decodedPath = decodeURIComponent(relativePath).replace(/^\/+/, "");
    const filePath = path.resolve(root, decodedPath);

    if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== root) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");

    const contentType = contentTypes.get(path.extname(filePath).toLowerCase());
    response.writeHead(200, {
      ...(contentType ? { "Content-Type": contentType } : {}),
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Serving the GitHub Pages artifact at http://127.0.0.1:${port}${basePath}/`);
});
