const state = { report: null };

const elements = Object.fromEntries([
  "scan-button", "download-button", "report-file", "mode-badge", "scan-summary", "scan-time",
  "hero-ring", "hero-risk-number", "privacy-note", "disk-free", "disk-total", "smart-status",
  "disk-model", "risk-count", "protected-count", "write-rate", "tracked-size", "source-count",
  "memory-percent", "memory-detail", "capacity-percent", "capacity-ring", "capacity-ring-value",
  "disk-used", "disk-available", "disk-filesystem", "sample-window", "write-bars", "storage-bars",
  "total-wal", "system-platform", "cpu-model", "cpu-cores", "system-memory", "system-uptime",
  "disk-protocol", "scan-elapsed", "codex-scope", "codex-max-id", "codex-rows",
  "codex-trace-rows", "codex-wal", "codex-rate", "source-rows", "agent-prompt", "copy-button",
  "copy-status"
].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]));

const byteUnits = ["B", "KB", "MB", "GB", "TB"];

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), byteUnits.length - 1);
  return `${(bytes / (1000 ** index)).toFixed(index > 1 ? 1 : 0)} ${byteUnits[index]}`;
}

function formatRate(value) {
  const rate = Number(value || 0);
  return rate < 1 ? `${rate.toFixed(1)} B/s` : `${formatBytes(rate)}/s`;
}

function formatInteger(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat("zh-CN").format(Number(value)) : "—";
}

function formatUptime(seconds) {
  const totalHours = Math.floor(Number(seconds || 0) / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

function formatGrowth(source, seconds) {
  if (!source.exists) return "—";
  if (source.kind === "sqlite") {
    const inserts = source.insertsPerSecond == null ? "未知" : `${source.insertsPerSecond.toFixed(1)} INSERT/s`;
    return `${inserts} · WAL ${formatBytes(source.walGrowthBytes)} / ${seconds}s`;
  }
  return `${formatBytes(source.growthBytes)} / ${seconds}s`;
}

function renderBars(container, sources, valueOf, formatValue) {
  const values = sources.map((source) => Math.max(0, Number(valueOf(source) || 0)));
  const maximum = Math.max(...values, 1);
  container.replaceChildren(...sources.map((source, index) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = source.name;
    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.width = `${Math.max(values[index] > 0 ? 2 : 0, (values[index] / maximum) * 100)}%`;
    track.append(fill);
    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = formatValue(values[index]);
    row.append(label, track, value);
    return row;
  }));
}

function recommendation(source) {
  if (source.status.level === "critical") return "先备份，再由 Agent 判定是否仅拦截 TRACE";
  if (source.status.level === "warning") return "延长采样；确认持续增长后再处理";
  if (source.status.level === "protected") return source.triggerScope === "all-logs"
    ? "当前拦截全部日志；保留 trigger 并定期复测"
    : "当前仅拦截 TRACE；定期确认 TRACE MAX(id) 与 WAL";
  if (source.status.level === "absent") return "无需处理";
  return "保持现状；不要清理正常索引或会话 WAL";
}

function makePrompt(report) {
  const disk = report.system?.disk?.usage;
  const sourceLines = report.sources.map((source) => {
    const details = source.kind === "sqlite"
      ? `db=${formatBytes(source.bytes)}, wal=${formatBytes(source.walBytes)}, MAX(id)=${source.maxId ?? "未知"}, sample_growth=${source.maxIdGrowth ?? "未知"}, triggers=${source.triggerCount ?? 0}, trigger_scope=${source.triggerScope ?? "未知"}`
      : `size=${formatBytes(source.bytes)}, sample_growth=${formatBytes(source.growthBytes)}`;
    return `- ${source.name} (${source.path}): ${source.status.label}; ${details}`;
  }).join("\n");

  return `请在我的电脑上诊断并安全处理 AI 工具可能存在的高频 SSD 写盘问题。当前网页只读扫描摘要如下：

系统：${report.system.os} / ${report.system.architecture}
磁盘：${disk ? `${formatBytes(disk.availableBytes)} 可用，共 ${formatBytes(disk.totalBytes)}，使用率 ${disk.capacityPercent}%` : "未取得"}
SMART：${report.system.disk.hardware.smartStatus}
采样时长：${report.sampleSeconds} 秒
${sourceLines}

请严格按以下流程执行：
1. 先做只读检查，不要直接修改。确认目标确实是日志 SQLite，检查表结构、level/target 分布，并至少做三次间隔采样，记录 MAX(id)、文件大小和 WAL 大小。
2. 只有确认持续高频增长才修复。先使用 SQLite .backup 创建带时间戳的一致性备份，再执行 PRAGMA integrity_check；报告备份完整路径和校验结果。
3. 默认采用最小范围：如果 logs 表存在 level 列，只用 BEFORE INSERT trigger + RAISE(IGNORE) 拦截 level=TRACE。不要拦截索引库、聊天库、缓存库或所有日志。
4. 如果最小拦截后仍高频增长，先向我说明剩余日志级别和速率；只有我明确同意后，才能拦截 logs 表的全部 INSERT。
5. 执行 PRAGMA wal_checkpoint(TRUNCATE)，随后三次间隔采样确认 TRACE MAX(id)、总 MAX(id) 和 WAL 的变化。区分“TRACE 停止”和“全部日志停止”。
6. 验证相关 AI 工具仍能正常启动和完成基本请求。提供恢复命令（DROP TRIGGER），不要删除原数据库或备份。
7. 保留无关文件和用户改动，不清理 Ollama 模型、会话历史、索引或正常缓存。

请把诊断证据、实际修改、备份位置、验收采样值和恢复方式简洁汇报给我。`;
}

function setBadge(level, text) {
  elements.mode_badge.className = `badge ${level}`;
  elements.mode_badge.textContent = text;
}

function render(report, mode = "local") {
  state.report = report;
  const disk = report.system?.disk?.usage;
  const hardware = report.system?.disk?.hardware || {};
  const resources = report.system?.resources || {};
  const critical = report.summary?.critical || 0;
  const warning = report.summary?.warning || 0;
  const protectedCount = report.summary?.protected || 0;
  const riskCount = critical + warning;
  const codex = report.sources.find((source) => source.id === "codex-logs") || {};

  setBadge(critical ? "critical" : warning ? "warning" : "ok", mode === "local" ? "本机实时报告" : "已导入离线报告");
  elements.scan_summary.textContent = critical ? `发现 ${critical} 个高风险写入源` : warning ? `发现 ${warning} 个需要复查的来源` : "未发现持续高频写盘";
  elements.scan_time.textContent = `生成于 ${new Date(report.generatedAt).toLocaleString()} · 采样 ${report.sampleSeconds}s`;
  elements.privacy_note.textContent = report.privacy || "报告不包含文件内容。";
  elements.disk_free.textContent = disk ? formatBytes(disk.availableBytes) : "不可用";
  elements.disk_total.textContent = disk ? `总容量 ${formatBytes(disk.totalBytes)}` : "未取得磁盘数据";
  elements.smart_status.textContent = hardware.smartStatus || "不可用";
  elements.disk_model.textContent = [hardware.model, hardware.protocol].filter(Boolean).join(" · ");
  elements.risk_count.textContent = String(riskCount);
  elements.protected_count.textContent = `${protectedCount} 个来源已保护`;
  elements.write_rate.textContent = formatRate(report.summary?.activeWriteBytesPerSecond);
  elements.tracked_size.textContent = formatBytes(report.summary?.totalTrackedBytes);
  elements.source_count.textContent = `${report.summary?.monitoredSources || report.sources.length} 个数据源 · WAL ${formatBytes(report.summary?.totalWalBytes)}`;
  elements.memory_percent.textContent = resources.memoryUsedPercent == null ? "不可用" : `${resources.memoryUsedPercent.toFixed(0)}%`;
  elements.memory_detail.textContent = resources.totalMemoryBytes ? `${formatBytes(resources.usedMemoryBytes)} / ${formatBytes(resources.totalMemoryBytes)}` : "未取得内存数据";
  elements.hero_risk_number.textContent = String(riskCount);
  const riskPercent = report.sources.length ? Math.min(100, (riskCount / report.sources.length) * 100) : 0;
  elements.hero_ring.style.background = riskCount
    ? `conic-gradient(var(--danger) 0 ${riskPercent}%, rgba(87,126,176,.1) ${riskPercent}% 100%)`
    : "conic-gradient(var(--mint) 0 100%, rgba(87,126,176,.1) 0)";

  const percent = Math.min(100, Math.max(0, disk?.capacityPercent || 0));
  elements.capacity_percent.textContent = disk ? `${percent}% 已使用` : "—";
  elements.capacity_ring_value.textContent = disk ? `${percent}%` : "—";
  elements.capacity_ring.style.setProperty("--capacity", `${percent}%`);
  elements.capacity_ring.setAttribute("aria-label", disk ? `磁盘使用率 ${percent}%` : "磁盘使用率不可用");
  elements.disk_used.textContent = disk ? formatBytes(disk.usedBytes) : "—";
  elements.disk_available.textContent = disk ? formatBytes(disk.availableBytes) : "—";
  elements.disk_filesystem.textContent = disk?.filesystem || "—";
  elements.sample_window.textContent = `${report.sampleSeconds}s 窗口`;
  elements.total_wal.textContent = `WAL ${formatBytes(report.summary?.totalWalBytes)}`;
  elements.system_platform.textContent = `${report.system.platform} · ${report.system.architecture}`;
  elements.cpu_model.textContent = resources.cpuModel || "—";
  elements.cpu_cores.textContent = resources.cpuCores ? `${resources.cpuCores} 逻辑核心` : "—";
  elements.system_memory.textContent = resources.totalMemoryBytes ? formatBytes(resources.totalMemoryBytes) : "—";
  elements.system_uptime.textContent = formatUptime(resources.uptimeSeconds);
  elements.disk_protocol.textContent = hardware.protocol || "—";
  elements.scan_elapsed.textContent = report.summary?.elapsedMs == null ? "—" : `${report.summary.elapsedMs} ms`;
  elements.codex_scope.textContent = codex.triggerScope === "all-logs" ? "全部日志已拦截" : codex.triggerScope === "trace-only" ? "仅 TRACE 已拦截" : "未发现拦截 trigger";
  elements.codex_scope.className = `badge ${codex.status?.level || "neutral"}`;
  elements.codex_max_id.textContent = formatInteger(codex.maxId);
  elements.codex_rows.textContent = formatInteger(codex.rows);
  elements.codex_trace_rows.textContent = formatInteger(codex.traceRows);
  elements.codex_wal.textContent = formatBytes(codex.walBytes);
  elements.codex_rate.textContent = codex.insertsPerSecond == null ? "—" : `${codex.insertsPerSecond.toFixed(1)}/s`;

  renderBars(
    elements.write_bars,
    report.sources,
    (source) => source.kind === "sqlite" ? (source.walGrowthBytes || 0) / report.sampleSeconds : source.growthBytesPerSecond,
    formatRate
  );
  renderBars(elements.storage_bars, report.sources, (source) => source.bytes || 0, formatBytes);

  elements.source_rows.replaceChildren(...report.sources.map((source) => {
    const row = document.createElement("tr");
    const size = source.kind === "sqlite" ? `${formatBytes(source.bytes)} · WAL ${formatBytes(source.walBytes)}` : formatBytes(source.bytes);
    for (const value of [source.name, size, formatGrowth(source, report.sampleSeconds)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const statusCell = document.createElement("td");
    const status = document.createElement("span");
    status.className = "status-cell";
    const dot = document.createElement("span");
    dot.className = `status-dot ${source.status.level}`;
    dot.setAttribute("aria-hidden", "true");
    status.append(dot, document.createTextNode(source.status.label));
    statusCell.append(status);
    row.append(statusCell);
    const advice = document.createElement("td");
    advice.textContent = recommendation(source);
    row.append(advice);
    return row;
  }));

  elements.agent_prompt.value = makePrompt(report);
  elements.copy_button.disabled = false;
  elements.download_button.disabled = false;
}

async function scan() {
  elements.scan_button.disabled = true;
  elements.scan_button.textContent = "采样中…";
  elements.source_rows.innerHTML = '<tr><td colspan="5" class="empty">正在进行两次间隔采样…</td></tr>';
  try {
    const response = await fetch("/api/scan", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json(), "local");
  } catch {
    setBadge("neutral", "静态网页模式");
    elements.scan_summary.textContent = "本地扫描器未连接";
    elements.scan_time.textContent = "请在项目目录运行 npm start，或导入 JSON 报告";
    elements.source_rows.innerHTML = '<tr><td colspan="5" class="empty">没有本机读取权限。远程网页无法直接读取你的磁盘。</td></tr>';
  } finally {
    elements.scan_button.disabled = false;
    elements.scan_button.textContent = "重新扫描本机";
  }
}

elements.scan_button.addEventListener("click", scan);
elements.copy_button.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.agent_prompt.value);
    elements.copy_status.textContent = "已复制，可以粘贴给 Codex、Claude Code 或其他本机 Agent。";
  } catch {
    elements.copy_status.textContent = "浏览器未授予剪贴板权限，请手动选择提示词复制。";
  }
});
elements.download_button.addEventListener("click", () => {
  if (!state.report) return;
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `ssd-write-guard-${new Date().toISOString().replaceAll(":", "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});
elements.report_file.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const report = JSON.parse(await file.text());
    if (report.schemaVersion !== 1 || !Array.isArray(report.sources)) throw new Error("Unsupported report");
    render(report, "import");
  } catch {
    setBadge("critical", "报告格式错误");
    elements.scan_summary.textContent = "无法读取此 JSON 报告";
  }
});

scan();
