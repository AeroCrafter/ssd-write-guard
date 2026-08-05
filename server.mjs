import http from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { scanSystem } from "./src/scanner.mjs";
import { listCleanupHistory, quarantineCleanupCandidates, restoreCleanupBatch, scanCleanupCandidates } from "./src/cleanup.mjs";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(projectDir, "public");
const host = process.env.SSD_GUARD_HOST || "127.0.0.1";
const port = Number(process.env.SSD_GUARD_PORT || 4173);
const controlToken = randomBytes(32).toString("base64url");

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
if (!loopbackHosts.has(host) && process.env.SSD_GUARD_ALLOW_REMOTE !== "1") {
  throw new Error("Refusing non-loopback bind. Set SSD_GUARD_ALLOW_REMOTE=1 only for a deliberate, private-network test.");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY"
  });
  response.end(JSON.stringify(body));
}

function tokenMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(controlToken);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function authorizedMutation(request) {
  if (!tokenMatches(request.headers["x-ssd-guard-token"])) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://${request.headers.host}`;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requestedAgeDays(requestUrl) {
  return Math.min(365, Math.max(1, Number(requestUrl.searchParams.get("days")) || 7));
}

async function serveStatic(request, response, requestUrl) {
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
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    });
    response.end(contents);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, mode: "local", version: "1.3.0", controlToken });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/scan") {
    try {
      sendJson(response, 200, await scanSystem());
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Scan failed" });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cleanup/preview") {
    try {
      const preview = await scanCleanupCandidates({ minAgeDays: requestedAgeDays(requestUrl) });
      const { internalCandidates, ...publicPreview } = preview;
      sendJson(response, 200, publicPreview);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Cleanup preview failed" });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cleanup/history") {
    try {
      sendJson(response, 200, { history: await listCleanupHistory() });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Cleanup history failed" });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cleanup") {
    if (!authorizedMutation(request)) {
      sendJson(response, 403, { error: "Invalid local control token or origin" });
      return;
    }
    try {
      const body = await readJsonBody(request);
      const result = await quarantineCleanupCandidates(body.ids, { minAgeDays: body.minAgeDays });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Cleanup failed" });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cleanup/restore") {
    if (!authorizedMutation(request)) {
      sendJson(response, 403, { error: "Invalid local control token or origin" });
      return;
    }
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await restoreCleanupBatch(body.batchName));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Restore failed" });
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  await serveStatic(request, response, requestUrl);
});

server.listen(port, host, () => {
  console.log(`SSD Write Guard is running at http://${host}:${port}`);
  console.log("System inspection stays local; cleanup moves selected stale logs to Trash.");
  if (!loopbackHosts.has(host)) console.warn("WARNING: remote binding is enabled; do not expose this helper to the public internet.");
});
