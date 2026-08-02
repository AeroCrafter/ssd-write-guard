import os from "node:os";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
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

async function runWithFailureOutput(command, args, timeout = 8000) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    return stdout.trim();
  } catch (error) {
    return String(error && typeof error === "object" && "stdout" in error ? error.stdout || "" : "").trim();
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

export function parseSmartctlJson(output) {
  if (!output) return { available: false, readable: false, reason: "smartctl 未安装或无法读取" };
  let data;
  try {
    data = JSON.parse(output);
  } catch {
    return { available: true, readable: false, reason: "SMART 输出无法解析" };
  }
  const health = data.nvme_smart_health_information_log;
  if (!health) return { available: true, readable: false, reason: "设备未公开 NVMe 寿命字段" };
  const percentageUsed = Number.isFinite(Number(health.percentage_used)) ? Number(health.percentage_used) : null;
  const dataUnitsWritten = Number.isFinite(Number(health.data_units_written)) ? Number(health.data_units_written) : null;
  return {
    available: true,
    readable: true,
    source: "NVMe SMART",
    passed: data.smart_status?.passed === true,
    percentageUsed,
    remainingLifePercent: percentageUsed == null ? null : Math.max(0, Math.min(100, 100 - percentageUsed)),
    availableSparePercent: Number.isFinite(Number(health.available_spare)) ? Number(health.available_spare) : null,
    spareThresholdPercent: Number.isFinite(Number(health.available_spare_threshold)) ? Number(health.available_spare_threshold) : null,
    temperatureCelsius: Number.isFinite(Number(health.temperature)) ? Number(health.temperature) : null,
    dataUnitsWritten,
    hostWritesBytes: dataUnitsWritten == null ? null : dataUnitsWritten * 512000,
    dataUnitsRead: Number.isFinite(Number(health.data_units_read)) ? Number(health.data_units_read) : null,
    powerOnHours: Number.isFinite(Number(health.power_on_hours)) ? Number(health.power_on_hours) : null,
    powerCycles: Number.isFinite(Number(health.power_cycles)) ? Number(health.power_cycles) : null,
    unsafeShutdowns: Number.isFinite(Number(health.unsafe_shutdowns)) ? Number(health.unsafe_shutdowns) : null,
    mediaErrors: Number.isFinite(Number(health.media_errors)) ? Number(health.media_errors) : null,
    errorLogEntries: Number.isFinite(Number(health.num_err_log_entries)) ? Number(health.num_err_log_entries) : null,
    criticalWarning: Number.isFinite(Number(health.critical_warning)) ? Number(health.critical_warning) : null,
    note: percentageUsed === 0 ? "厂商 Percentage Used 为 0%，该值通常按 1% 粒度计数" : "寿命来自设备 Percentage Used，不是容量估算"
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
  const [diskutilOutput, smartctlOutput] = process.platform === "darwin"
    ? await Promise.all([
        run("diskutil", ["info", "disk0"]),
        runWithFailureOutput("smartctl", ["-a", "-j", "/dev/disk0"], 12000)
      ])
    : ["", ""];
  const hardware = process.platform === "darwin"
    ? { ...parseDiskutil(diskutilOutput), nvmeHealth: parseSmartctlJson(smartctlOutput) }
    : { model: "Unavailable", protocol: "Unavailable", smartStatus: "Unavailable", solidState: "Unknown", diskSize: "Unavailable" };
  return { usage, hardware };
}

const baseMonitoredFiles = [
  {
    id: "claude-log",
    toolId: "claude",
    name: "Claude main.log",
    kind: "log",
    dataClass: "diagnostic-log",
    purpose: "Claude Desktop 的启动、网络、Agent 和错误诊断信息",
    cleanupPolicy: "退出 Claude 后，达到时间阈值的轮转日志可隔离；活跃 main.log 不应强删",
    path: homePath("Library", "Logs", "Claude", "main.log")
  },
  {
    id: "continue-wal",
    toolId: "continue",
    name: "Continue index WAL",
    kind: "wal",
    dataClass: "search-index",
    purpose: "Continue 代码索引数据库尚未 checkpoint 的事务",
    cleanupPolicy: "不是普通日志；由 Continue/SQLite 自动 checkpoint，不应单独删除",
    path: homePath(".continue", "index", "index.sqlite-wal")
  },
  {
    id: "copilot-wal",
    toolId: "copilot",
    name: "VS Code Copilot session WAL",
    kind: "wal",
    dataClass: "session-state",
    purpose: "Copilot Chat 会话状态数据库尚未 checkpoint 的事务",
    cleanupPolicy: "包含会话状态；退出 VS Code 后由 SQLite 维护，不应单独删除",
    path: homePath("Library", "Application Support", "Code", "User", "globalStorage", "github.copilot-chat", "session-store.db-wal")
  },
  {
    id: "ollama-wal",
    toolId: "ollama",
    name: "Ollama chat WAL",
    kind: "wal",
    dataClass: "conversation",
    purpose: "Ollama 本地聊天数据库尚未 checkpoint 的事务，不是模型文件",
    cleanupPolicy: "可能包含聊天状态；不要单独删除，模型也不属于日志清理范围",
    path: homePath("Library", "Application Support", "Ollama", "db.sqlite-wal")
  }
];

async function newestMatchingFile(directory, pattern) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const matches = await Promise.all(entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        return { filePath, info: await stat(filePath) };
      }));
    return matches.sort((a, b) => path.basename(b.filePath).localeCompare(path.basename(a.filePath)) || b.info.mtimeMs - a.info.mtimeMs)[0]?.filePath || null;
  } catch {
    return null;
  }
}

async function resolveMonitoredFiles() {
  const kimiRoot = homePath("Library", "Application Support", "kimi-desktop", "daimon-share", "daimon");
  const eventsDb = await newestMatchingFile(path.join(kimiRoot, "logs", "index"), /^events-.*[.]sqlite$/);
  const conversationDb = path.join(kimiRoot, "agents", "main", "sessions", "hosted-logical", "conversations.sqlite");
  return [
    ...baseMonitoredFiles,
    {
      id: "kimi-events-wal",
      toolId: "kimi",
      name: "Kimi agent event log database",
      kind: "sqlite-store",
      dataClass: "diagnostic-log-index",
      purpose: "Kimi Agent 的 event、trace、模块和耗时索引，用于运行诊断",
      cleanupPolicy: "属于日志索引，但活跃 WAL 不能强删；持续增长时应先退出 Kimi、备份并 checkpoint",
      path: eventsDb || path.join(kimiRoot, "logs", "index", "events-current.sqlite"),
      walPath: `${eventsDb || path.join(kimiRoot, "logs", "index", "events-current.sqlite")}-wal`
    },
    {
      id: "kimi-conversation-wal",
      toolId: "kimi",
      name: "Kimi conversation database",
      kind: "sqlite-store",
      dataClass: "conversation",
      purpose: "Kimi Agent 会话、conversation 和 session 状态的事务数据",
      cleanupPolicy: "这是会话数据库，不是可丢弃日志；不要直接删除",
      path: conversationDb,
      walPath: `${conversationDb}-wal`
    }
  ];
}

const aiToolDefinitions = [
  { id: "codex", name: "Codex / ChatGPT", processPattern: /\/(?:Codex|ChatGPT)[.]app\//i, roots: [homePath(".codex"), homePath("Library", "Application Support", "Codex")] },
  { id: "claude", name: "Claude", processPattern: /\/Claude[.]app\//i, roots: [homePath("Library", "Application Support", "Claude"), homePath("Library", "Logs", "Claude")] },
  { id: "kimi", name: "Kimi", processPattern: /\/Kimi[.]app\//i, roots: [homePath("Library", "Application Support", "kimi-desktop")] },
  { id: "ollama", name: "Ollama", processPattern: /\/Ollama[.]app\/|\bollama serve\b/i, roots: [homePath("Library", "Application Support", "Ollama")] },
  { id: "cursor", name: "Cursor", processPattern: /\/Cursor[.]app\//i, roots: [homePath("Library", "Application Support", "Cursor")] },
  { id: "continue", name: "Continue", processPattern: /continue[.]continue/i, roots: [homePath(".continue")] },
  { id: "copilot", name: "VS Code Copilot", processPattern: /\/Visual Studio Code[.]app\//i, roots: [homePath("Library", "Application Support", "Code", "User", "globalStorage", "github.copilot-chat")] }
];

async function directoryBytes(directory) {
  const output = await run("du", ["-sk", directory], 12000);
  const kilobytes = Number(output.split(/\s+/)[0]);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
}

async function inspectAiTools() {
  const processOutput = await run("ps", ["ax", "-o", "args="], 8000);
  return Promise.all(aiToolDefinitions.map(async (tool) => {
    const rootSizes = await Promise.all(tool.roots.map(directoryBytes));
    const bytes = rootSizes.reduce((sum, value) => sum + value, 0);
    return {
      id: tool.id,
      name: tool.name,
      detected: bytes > 0,
      active: tool.processPattern.test(processOutput),
      bytes,
      note: tool.id === "kimi"
        ? "体积包含 Kimi 内置 Agent runtime、Python 环境和缓存，不全是日志"
        : tool.id === "claude"
          ? "体积包含 Electron 缓存、网页存储和诊断日志"
          : tool.id === "codex"
            ? "体积包含任务、工具资源、缓存、日志数据库和可恢复备份"
            : "体积是该工具已知本机数据目录，不等于可清理日志"
    };
  }));
}

function classify(item) {
  if (!item.exists) return { level: "absent", label: "未发现" };
  if (item.growthBytesPerSecond >= 1024 * 1024) return { level: "critical", label: "高频增长" };
  if (item.growthBytesPerSecond >= 64 * 1024) return { level: "warning", label: "需要复查" };
  return { level: "ok", label: "采样稳定" };
}

export async function scanSystem() {
  const startedAt = new Date();
  const codexDbPath = homePath(".codex", "logs_2.sqlite");
  const monitoredFiles = await resolveMonitoredFiles();
  const [disk, codexBefore, filesBefore, aiTools] = await Promise.all([
    inspectDisk(),
    inspectCodexLogDb(codexDbPath),
    Promise.all(monitoredFiles.map(async (item) => ({
      ...item,
      ...(await fileSnapshot(item.path)),
      wal: item.walPath ? await fileSnapshot(item.walPath) : null
    }))),
    inspectAiTools()
  ]);

  await new Promise((resolve) => setTimeout(resolve, sampleMs));

  const [codexAfter, filesAfter] = await Promise.all([
    inspectCodexLogDb(codexDbPath),
    Promise.all(monitoredFiles.map(async (item) => ({
      ...item,
      ...(await fileSnapshot(item.path)),
      wal: item.walPath ? await fileSnapshot(item.walPath) : null
    })))
  ]);

  const seconds = Math.max(sampleMs / 1000, 0.001);
  const sources = filesAfter.map((after, index) => {
    const before = filesBefore[index];
    const fileGrowthBytes = Math.max(0, after.bytes - before.bytes);
    const walGrowthBytes = after.wal ? Math.max(0, after.wal.bytes - (before.wal?.bytes || 0)) : 0;
    const growthBytes = fileGrowthBytes + walGrowthBytes;
    const item = {
      id: after.id,
      toolId: after.toolId,
      name: after.name,
      kind: after.kind,
      dataClass: after.dataClass,
      purpose: after.purpose,
      cleanupPolicy: after.cleanupPolicy,
      path: privatePath(after.path),
      exists: after.exists,
      bytes: after.bytes,
      walBytes: after.wal?.bytes || 0,
      walGrowthBytes,
      modifiedAt: after.modifiedAt,
      growthBytes,
      growthBytesPerSecond: growthBytes / seconds,
      hardwareRisk: growthBytes / seconds >= 1024 * 1024
        ? "high"
        : growthBytes / seconds >= 64 * 1024
          ? "review"
          : "low"
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
    toolId: "codex",
    dataClass: "diagnostic-log-database",
    purpose: "Codex 的结构化运行日志，包含 level、target、span 和诊断事件",
    cleanupPolicy: "可在一致性备份后清理历史 logs 行并 VACUUM；不能直接删除活跃数据库",
    hardwareRisk: (codexRate ?? 0) >= 10 || codexWalGrowth / seconds >= 1024 * 1024 ? "high" : "low",
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
    aiTools: aiTools.map((tool) => {
      const related = sources.filter((source) => source.toolId === tool.id);
      const risk = related.some((source) => source.hardwareRisk === "high")
        ? "high"
        : related.some((source) => source.hardwareRisk === "review")
          ? "review"
          : "low";
      return { ...tool, monitoredSources: related.length, hardwareRisk: risk };
    }),
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
