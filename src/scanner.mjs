import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const configuredSampleMs = Number(process.env.SSD_GUARD_SAMPLE_MS || 2000);
const sampleMs = Number.isFinite(configuredSampleMs) ? Math.min(30000, Math.max(500, configuredSampleMs)) : 2000;

async function run(command, args, timeout = 8000) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function fileSnapshot(filePath) {
  try {
    const info = await stat(filePath);
    return { exists: true, bytes: info.size, modifiedAt: info.mtime.toISOString() };
  } catch {
    return { exists: false, bytes: 0, modifiedAt: null };
  }
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

function privatePath(filePath) {
  const home = os.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function parseDf(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const cells = lines.at(-1).trim().split(/\s+/);
  if (cells.length < 6) return null;
  const [filesystem, totalKb, usedKb, availableKb, capacity] = cells;
  return {
    filesystem,
    totalBytes: Number(totalKb) * 1024,
    usedBytes: Number(usedKb) * 1024,
    availableBytes: Number(availableKb) * 1024,
    capacityPercent: Number(capacity.replace("%", "")),
    mount: cells.at(-1)
  };
}

function parseDiskutil(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  return {
    model: values["Device / Media Name"] || "Unknown",
    protocol: values.Protocol || "Unknown",
    smartStatus: values["SMART Status"] || "Unavailable",
    solidState: values["Solid State"] || "Unknown",
    diskSize: values["Disk Size"] || "Unknown"
  };
}

async function inspectCodexLogDb(dbPath) {
  const database = await fileSnapshot(dbPath);
  const wal = await fileSnapshot(`${dbPath}-wal`);
  if (!database.exists) return { database, wal, sqliteAvailable: false };

  const tableExists = await run("sqlite3", ["-readonly", dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='logs';"]);
  if (tableExists !== "1") return { database, wal, sqliteAvailable: Boolean(tableExists) };

  const values = await run("sqlite3", [
    "-readonly",
    dbPath,
    "SELECT COALESCE(MAX(id),0), COUNT(*), COALESCE(SUM(upper(level)='TRACE'),0), (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='logs' AND upper(COALESCE(sql,'')) LIKE '%RAISE(IGNORE)%' AND upper(COALESCE(sql,'')) LIKE '%TRACE%'), (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='logs' AND upper(COALESCE(sql,'')) LIKE '%RAISE(IGNORE)%' AND upper(COALESCE(sql,'')) NOT LIKE '%TRACE%') FROM logs;"
  ]);
  const [maxId, rows, traceRows, traceTriggerCount, allTriggerCount] = values.split("|").map(Number);
  return {
    database,
    wal,
    sqliteAvailable: values.length > 0,
    maxId: Number.isFinite(maxId) ? maxId : null,
    rows: Number.isFinite(rows) ? rows : null,
    traceRows: Number.isFinite(traceRows) ? traceRows : null,
    traceTriggerCount: Number.isFinite(traceTriggerCount) ? traceTriggerCount : 0,
    allTriggerCount: Number.isFinite(allTriggerCount) ? allTriggerCount : 0,
    triggerCount: (Number.isFinite(traceTriggerCount) ? traceTriggerCount : 0) + (Number.isFinite(allTriggerCount) ? allTriggerCount : 0)
  };
}

async function inspectDisk() {
  const preferredMount = process.platform === "darwin" ? "/System/Volumes/Data" : "/";
  let dfOutput = await run("df", ["-k", preferredMount]);
  if (!dfOutput) dfOutput = await run("df", ["-k", "/"]);
  const usage = parseDf(dfOutput);
  const hardware = process.platform === "darwin"
    ? parseDiskutil(await run("diskutil", ["info", "disk0"]))
    : { model: "Unavailable", protocol: "Unavailable", smartStatus: "Unavailable", solidState: "Unknown", diskSize: "Unavailable" };
  return { usage, hardware };
}

const monitoredFiles = [
  { id: "claude-log", name: "Claude main.log", kind: "log", path: homePath("Library", "Logs", "Claude", "main.log") },
  { id: "continue-wal", name: "Continue index WAL", kind: "wal", path: homePath(".continue", "index", "index.sqlite-wal") },
  { id: "copilot-wal", name: "VS Code Copilot session WAL", kind: "wal", path: homePath("Library", "Application Support", "Code", "User", "globalStorage", "github.copilot-chat", "session-store.db-wal") },
  { id: "ollama-wal", name: "Ollama chat WAL", kind: "wal", path: homePath("Library", "Application Support", "Ollama", "db.sqlite-wal") }
];

function classify(item) {
  if (!item.exists) return { level: "absent", label: "未发现" };
  if (item.growthBytesPerSecond >= 1024 * 1024) return { level: "critical", label: "高频增长" };
  if (item.growthBytesPerSecond >= 64 * 1024) return { level: "warning", label: "需要复查" };
  return { level: "ok", label: "采样稳定" };
}

export async function scanSystem() {
  const startedAt = new Date();
  const codexDbPath = homePath(".codex", "logs_2.sqlite");
  const [disk, codexBefore, filesBefore] = await Promise.all([
    inspectDisk(),
    inspectCodexLogDb(codexDbPath),
    Promise.all(monitoredFiles.map(async (item) => ({ ...item, ...(await fileSnapshot(item.path)) })))
  ]);

  await new Promise((resolve) => setTimeout(resolve, sampleMs));

  const [codexAfter, filesAfter] = await Promise.all([
    inspectCodexLogDb(codexDbPath),
    Promise.all(monitoredFiles.map(async (item) => ({ ...item, ...(await fileSnapshot(item.path)) })))
  ]);

  const seconds = Math.max(sampleMs / 1000, 0.001);
  const sources = filesAfter.map((after, index) => {
    const before = filesBefore[index];
    const growthBytes = Math.max(0, after.bytes - before.bytes);
    const item = {
      id: after.id,
      name: after.name,
      kind: after.kind,
      path: privatePath(after.path),
      exists: after.exists,
      bytes: after.bytes,
      modifiedAt: after.modifiedAt,
      growthBytes,
      growthBytesPerSecond: growthBytes / seconds
    };
    return { ...item, status: classify(item) };
  });

  const codexMaxGrowth = codexBefore.maxId == null || codexAfter.maxId == null ? null : Math.max(0, codexAfter.maxId - codexBefore.maxId);
  const codexWalGrowth = Math.max(0, codexAfter.wal.bytes - codexBefore.wal.bytes);
  const codexProtected = codexAfter.triggerCount > 0 && codexMaxGrowth === 0;
  const codexRate = codexMaxGrowth == null ? null : codexMaxGrowth / seconds;
  const codexStatus = !codexAfter.database.exists
    ? { level: "absent", label: "未发现" }
    : !codexAfter.sqliteAvailable
      ? { level: "warning", label: "缺少 sqlite3，无法判定" }
    : codexProtected
      ? { level: "protected", label: "已拦截并稳定" }
      : (codexRate ?? 0) >= 10 || codexWalGrowth / seconds >= 1024 * 1024
        ? { level: "critical", label: "疑似高频写入" }
        : { level: "ok", label: "采样稳定" };

  sources.unshift({
    id: "codex-logs",
    name: "Codex logs SQLite",
    kind: "sqlite",
    path: privatePath(codexDbPath),
    exists: codexAfter.database.exists,
    bytes: codexAfter.database.bytes,
    walBytes: codexAfter.wal.bytes,
    walGrowthBytes: codexWalGrowth,
    maxId: codexAfter.maxId,
    maxIdGrowth: codexMaxGrowth,
    insertsPerSecond: codexRate,
    rows: codexAfter.rows,
    traceRows: codexAfter.traceRows,
    triggerCount: codexAfter.triggerCount,
    triggerScope: codexAfter.allTriggerCount > 0 ? "all-logs" : codexAfter.traceTriggerCount > 0 ? "trace-only" : "none",
    status: codexStatus
  });

  const cpus = os.cpus();
  const totalMemoryBytes = os.totalmem();
  const memoryPressureOutput = process.platform === "darwin" ? await run("memory_pressure", ["-Q"]) : "";
  const memoryFreeMatch = memoryPressureOutput.match(/System-wide memory free percentage:\s*(\d+)%/i);
  const effectiveFreePercent = memoryFreeMatch ? Number(memoryFreeMatch[1]) : (os.freemem() / totalMemoryBytes) * 100;
  const memoryUsedPercent = Math.min(100, Math.max(0, 100 - effectiveFreePercent));
  const freeMemoryBytes = totalMemoryBytes * (effectiveFreePercent / 100);
  const totalTrackedBytes = sources.reduce((sum, source) => sum + (source.bytes || 0), 0);
  const totalWalBytes = sources.reduce((sum, source) => sum + (source.walBytes || (source.kind === "wal" ? source.bytes : 0) || 0), 0);
  const activeWriteBytesPerSecond = sources.reduce((sum, source) => {
    if (source.kind === "sqlite") return sum + ((source.walGrowthBytes || 0) / seconds);
    return sum + (source.growthBytesPerSecond || 0);
  }, 0);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sampleSeconds: seconds,
    privacy: "No file contents, usernames, prompts, or conversation data are included.",
    system: {
      platform: process.platform,
      os: `${os.type()} ${os.release()}`,
      architecture: os.arch(),
      hostname: "redacted",
      disk,
      resources: {
        cpuModel: cpus[0]?.model || "Unavailable",
        cpuCores: cpus.length,
        totalMemoryBytes,
        freeMemoryBytes,
        usedMemoryBytes: totalMemoryBytes - freeMemoryBytes,
        memoryUsedPercent,
        memoryFreePercent: effectiveFreePercent,
        memoryMetric: memoryFreeMatch ? "memory_pressure" : "os.freemem",
        uptimeSeconds: os.uptime(),
        loadAverage: os.loadavg()
      }
    },
    sources,
    summary: {
      critical: sources.filter((source) => source.status.level === "critical").length,
      warning: sources.filter((source) => source.status.level === "warning").length,
      protected: sources.filter((source) => source.status.level === "protected").length,
      stable: sources.filter((source) => source.status.level === "ok").length,
      monitoredSources: sources.length,
      totalTrackedBytes,
      totalWalBytes,
      activeWriteBytesPerSecond,
      elapsedMs: Date.now() - startedAt.getTime()
    }
  };
}
