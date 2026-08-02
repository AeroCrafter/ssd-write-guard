import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, open, opendir, readFile, rename, stat, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILES_PER_ROOT = 3000;

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function privatePath(filePath) {
  const userDir = os.homedir();
  return filePath.startsWith(userDir) ? `~${filePath.slice(userDir.length)}` : filePath;
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function logExtension(filePath) {
  return /(?:\.log(?:\.[a-z0-9_-]+)?|\.out)$/i.test(path.basename(filePath));
}

export function createCleanupDefinitions(userDir = os.homedir()) {
  const fromUser = (...parts) => path.join(userDir, ...parts);
  return [
    {
      id: "codex",
      name: "Codex",
      roots: [fromUser("Library", "Logs", "Codex"), fromUser(".codex", "logs")],
      matches: logExtension
    },
    {
      id: "claude",
      name: "Claude",
      roots: [fromUser("Library", "Logs", "Claude")],
      matches: logExtension
    },
    {
      id: "cursor",
      name: "Cursor",
      roots: [fromUser("Library", "Application Support", "Cursor", "logs"), fromUser("Library", "Logs", "Cursor")],
      matches: logExtension
    },
    {
      id: "vscode-agents",
      name: "VS Code Agents",
      roots: [fromUser("Library", "Application Support", "Code", "logs")],
      matches: (filePath) => logExtension(filePath) && /(github[.]copilot|anthropic[.]claude|agenthost|agentsessions|mcpgateway|ollama|windows-ai-studio|foundry toolkit)/i.test(filePath)
    },
    {
      id: "continue",
      name: "Continue",
      roots: [fromUser(".continue", "logs")],
      matches: logExtension
    },
    {
      id: "aider",
      name: "Aider",
      roots: [fromUser(".aider", "logs")],
      matches: logExtension
    },
    {
      id: "ollama",
      name: "Ollama",
      roots: [fromUser("Library", "Logs", "Ollama")],
      matches: logExtension
    },
    {
      id: "chatgpt",
      name: "ChatGPT / OpenAI",
      roots: [fromUser("Library", "Logs", "ChatGPT"), fromUser("Library", "Logs", "OpenAI")],
      matches: logExtension
    }
  ];
}

async function walkFiles(root, limit = MAX_FILES_PER_ROOT) {
  const files = [];
  const queue = [root];
  while (queue.length && files.length < limit) {
    const current = queue.shift();
    let directory;
    try {
      directory = await opendir(current);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile()) files.push(child);
      if (files.length >= limit) break;
    }
  }
  return files;
}

async function openPathsUnder(root) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-Fn", "+D", root], {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    return new Set(stdout.split(/\r?\n/).filter((line) => line.startsWith("n/")).map((line) => line.slice(1)));
  } catch {
    return new Set();
  }
}

function candidateId(filePath) {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 24);
}

export async function scanCleanupCandidates({
  minAgeDays = 7,
  now = Date.now(),
  definitions = createCleanupDefinitions(),
  checkOpen = true
} = {}) {
  const safeAgeDays = Math.min(365, Math.max(1, Number(minAgeDays) || 7));
  const threshold = now - safeAgeDays * DAY_MS;
  const candidates = [];
  const seen = new Set();
  let scannedFiles = 0;
  let protectedActive = 0;
  let protectedRecent = 0;

  for (const definition of definitions) {
    for (const root of definition.roots) {
      const [files, openPaths] = await Promise.all([
        walkFiles(root),
        checkOpen ? openPathsUnder(root) : Promise.resolve(new Set())
      ]);
      scannedFiles += files.length;
      for (const filePath of files) {
        if (seen.has(filePath) || !definition.matches(filePath)) continue;
        seen.add(filePath);
        let info;
        try {
          info = await stat(filePath);
        } catch {
          continue;
        }
        if (!info.isFile()) continue;
        if (openPaths.has(filePath)) {
          protectedActive += 1;
          continue;
        }
        if (info.mtimeMs > threshold) {
          protectedRecent += 1;
          continue;
        }
        candidates.push({
          id: candidateId(filePath),
          agentId: definition.id,
          agent: definition.name,
          path: privatePath(filePath),
          absolutePath: filePath,
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          ageDays: Math.floor((now - info.mtimeMs) / DAY_MS),
          reason: `${safeAgeDays} 天以上且未被进程占用`
        });
      }
    }
  }

  candidates.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return {
    generatedAt: new Date(now).toISOString(),
    minAgeDays: safeAgeDays,
    candidates: candidates.map(({ absolutePath, ...candidate }) => candidate),
    internalCandidates: candidates,
    summary: {
      scannedFiles,
      candidateFiles: candidates.length,
      candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
      protectedActive,
      protectedRecent
    }
  };
}

function batchName(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `SSD-Write-Guard-${stamp}-${randomBytes(3).toString("hex")}`;
}

async function writeManifest(batchDir, manifest) {
  const manifestPath = path.join(batchDir, "manifest.json");
  const handle = await open(manifestPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function quarantineCleanupCandidates(ids, {
  minAgeDays = 7,
  definitions = createCleanupDefinitions(),
  trashRoot = homePath(".Trash"),
  now = new Date(),
  checkOpen = true
} = {}) {
  const selectedIds = [...new Set(Array.isArray(ids) ? ids : [])].slice(0, 1000);
  if (!selectedIds.length) return { moved: [], failed: [], movedBytes: 0, quarantinePath: null };

  const preview = await scanCleanupCandidates({ minAgeDays, definitions, now: now.getTime(), checkOpen });
  const allowed = new Map(preview.internalCandidates.map((candidate) => [candidate.id, candidate]));
  const selected = selectedIds.map((id) => allowed.get(id)).filter(Boolean);
  const failed = selectedIds.filter((id) => !allowed.has(id)).map((id) => ({ id, reason: "文件已变化、仍在使用或不在允许列表" }));
  if (!selected.length) return { moved: [], failed, movedBytes: 0, quarantinePath: null };

  const name = batchName(now);
  const batchDir = path.join(trashRoot, name);
  await mkdir(batchDir, { recursive: false, mode: 0o700 });
  const moved = [];

  for (const candidate of selected) {
    const agentDir = path.join(batchDir, candidate.agentId);
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const destination = path.join(agentDir, `${candidate.id}-${path.basename(candidate.absolutePath)}`);
    try {
      await rename(candidate.absolutePath, destination);
      moved.push({
        id: candidate.id,
        agentId: candidate.agentId,
        agent: candidate.agent,
        bytes: candidate.bytes,
        originalPath: candidate.absolutePath,
        displayOriginalPath: candidate.path,
        quarantinePath: destination
      });
    } catch (error) {
      failed.push({ id: candidate.id, reason: error instanceof Error ? error.message : "移动失败" });
    }
  }

  const manifest = {
    schemaVersion: 1,
    batchName: name,
    createdAt: now.toISOString(),
    status: "quarantined",
    minAgeDays: preview.minAgeDays,
    items: moved
  };
  await writeManifest(batchDir, manifest);
  return {
    batchName: name,
    moved: moved.map(({ originalPath, quarantinePath, ...item }) => item),
    failed,
    movedBytes: moved.reduce((sum, item) => sum + item.bytes, 0),
    quarantinePath: privatePath(batchDir)
  };
}

function validBatchName(name) {
  return /^SSD-Write-Guard-[0-9TZ-]+-[a-f0-9]{6}$/.test(name);
}

export async function listCleanupHistory({ trashRoot = homePath(".Trash") } = {}) {
  let directory;
  try {
    directory = await opendir(trashRoot);
  } catch {
    return [];
  }
  const history = [];
  for await (const entry of directory) {
    if (!entry.isDirectory() || !validBatchName(entry.name)) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(trashRoot, entry.name, "manifest.json"), "utf8"));
      history.push({
        batchName: entry.name,
        createdAt: manifest.createdAt,
        restoredAt: manifest.restoredAt || null,
        status: manifest.status,
        files: manifest.items?.length || 0,
        bytes: (manifest.items || []).reduce((sum, item) => sum + (item.bytes || 0), 0),
        path: privatePath(path.join(trashRoot, entry.name))
      });
    } catch {
      continue;
    }
  }
  return history.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
}

export async function restoreCleanupBatch(name, {
  definitions = createCleanupDefinitions(),
  trashRoot = homePath(".Trash"),
  now = new Date()
} = {}) {
  if (!validBatchName(name)) throw new Error("Invalid cleanup batch");
  const batchDir = path.join(trashRoot, name);
  if (!isWithin(batchDir, trashRoot)) throw new Error("Invalid cleanup path");
  const manifestPath = path.join(batchDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.status !== "quarantined") throw new Error("Cleanup batch is not restorable");
  const allowedRoots = definitions.flatMap((definition) => definition.roots);
  const restored = [];
  const failed = [];

  for (const item of manifest.items || []) {
    const source = item.quarantinePath;
    const destination = item.originalPath;
    if (!isWithin(source, batchDir) || !allowedRoots.some((root) => isWithin(destination, root))) {
      failed.push({ id: item.id, reason: "清单路径不在允许范围" });
      continue;
    }
    try {
      await stat(destination);
      failed.push({ id: item.id, reason: "原位置已有同名文件" });
      continue;
    } catch {
      // Destination is available.
    }
    try {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await rename(source, destination);
      restored.push({ id: item.id, path: privatePath(destination), bytes: item.bytes });
    } catch (error) {
      failed.push({ id: item.id, reason: error instanceof Error ? error.message : "恢复失败" });
    }
  }

  manifest.status = failed.length ? "partially-restored" : "restored";
  manifest.restoredAt = now.toISOString();
  manifest.restoreFailures = failed;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { batchName: name, restored, failed };
}
