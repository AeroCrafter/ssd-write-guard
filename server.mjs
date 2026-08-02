import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { scanSystem } from "./src/scanner.mjs";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(projectDir, "public");
const host = process.env.SSD_GUARD_HOST || "127.0.0.1";
const port = Number(process.env.SSD_GUARD_PORT || 4173);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const resolvedPath = path.resolve(publicDir, relativePath);

  if (!resolvedPath.startsWith(`${publicDir}${path.sep}`) && resolvedPath !== path.join(publicDir, "index.html")) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileInfo = await stat(resolvedPath);
    if (!fileInfo.isFile()) throw new Error("Not a file");
    const contents = await readFile(resolvedPath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(resolvedPath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'"
    });
    response.end(contents);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, { ok: true, mode: "local", version: "1.0.0" });
    return;
  }

  if (request.method === "GET" && request.url === "/api/scan") {
    try {
      sendJson(response, 200, await scanSystem());
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Scan failed" });
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  await serveStatic(request, response);
});

server.listen(port, host, () => {
  console.log(`SSD Write Guard is running at http://${host}:${port}`);
  console.log("All system inspection stays on this computer.");
});
