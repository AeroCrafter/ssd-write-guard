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

const defaultAllowedOrigins = new Set([
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://[::1]:4173",
  "https://aerocrafter.github.io",
  "http://47.107.65.111",
  "https://47.107.65.111",
  "http://codextest.com",
  "https://codextest.com",
  "http://www.codextest.com",
  "https://www.codextest.com",
  "http://www.aerocrafter.com",
  "https://www.aerocrafter.com"
]);
const configuredAllowedOrigins = String(process.env.SSD_GUARD_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

function originAllowed(origin) {
  return !origin || allowedOrigins.has(origin);
}

function corsHeaders(request) {
  const origin = request?.headers.origin;
  if (!origin || !originAllowed(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-SSD-Guard-Token",
    "Access-Control-Allow-Private-Network": "true",
    Vary: "Origin"
  };
}

function sendJson(response, status, body, request) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...corsHeaders(request)
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
  return origin === `http://${request.headers.host}` || originAllowed(origin);
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
    sendJson(response, 403, { error: "Forbidden" }, request);
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
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:4173 http://localhost:4173 http://[::1]:4173; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    });
    response.end(contents);
  } catch {
    sendJson(response, 404, { error: "Not found" }, request);
  }
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "OPTIONS") {
    if (!originAllowed(request.headers.origin)) {
      sendJson(response, 403, { error: "Origin is not allowed" }, request);
      return;
    }
    response.writeHead(204, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      ...corsHeaders(request)
    });
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, mode: "local", version: "1.4.0", controlToken }, request);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/scan") {
    try {
      sendJson(response, 200, await scanSystem(), request);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Scan failed" }, request);
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cleanup/preview") {
    try {
      const preview = await scanCleanupCandidates({ minAgeDays: requestedAgeDays(requestUrl) });
      const { internalCandidates, ...publicPreview } = preview;
      sendJson(response, 200, publicPreview, request);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Cleanup preview failed" }, request);
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cleanup/history") {
    try {
      sendJson(response, 200, { history: await listCleanupHistory() }, request);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Cleanup history failed" }, request);
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cleanup") {
    if (!authorizedMutation(request)) {
      sendJson(response, 403, { error: "Invalid local control token or origin" }, request);
      return;
    }
    try {
      const body = await readJsonBody(request);
      const result = await quarantineCleanupCandidates(body.ids, { minAgeDays: body.minAgeDays });
      sendJson(response, 200, result, request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Cleanup failed" }, request);
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cleanup/restore") {
    if (!authorizedMutation(request)) {
      sendJson(response, 403, { error: "Invalid local control token or origin" }, request);
      return;
    }
    try {
      const body = await readJsonBody(request);
      sendJson(response, 200, await restoreCleanupBatch(body.batchName), request);
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Restore failed" }, request);
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" }, request);
    return;
  }

  await serveStatic(request, response, requestUrl);
});

server.listen(port, host, () => {
  console.log(`SSD Write Guard is running at http://${host}:${port}`);
  console.log("System inspection stays local; cleanup moves selected stale logs to Trash.");
  if (!loopbackHosts.has(host)) console.warn("WARNING: remote binding is enabled; do not expose this helper to the public internet.");
});
