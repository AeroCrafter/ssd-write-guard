const state = {
  report: null,
  reportMode: null,
  controlToken: null,
  cleanupPreview: null,
  cleanupSelection: new Set(),
  cleanupHistory: []
};

const elements = Object.fromEntries([
  "scan-button", "download-button", "report-file", "mode-badge", "scan-summary", "scan-time",
  "hero-ring", "hero-risk-number", "privacy-note", "disk-free", "disk-total", "smart-status",
  "disk-model", "risk-count", "protected-count", "write-rate", "tracked-size", "source-count",
  "memory-percent", "memory-detail", "capacity-percent", "capacity-ring", "capacity-ring-value",
  "disk-used", "disk-available", "disk-filesystem", "sample-window", "write-bars", "storage-bars",
  "total-wal", "system-platform", "cpu-model", "cpu-cores", "system-memory", "system-uptime",
  "disk-protocol", "scan-elapsed", "codex-scope", "codex-max-id", "codex-rows",
  "codex-trace-rows", "codex-wal", "codex-rate", "source-rows", "agent-prompt", "copy-button",
  "copy-status", "cleanup-age", "cleanup-refresh", "cleanup-select-all", "cleanup-candidate-count",
  "cleanup-candidate-bytes", "cleanup-protected-count", "cleanup-groups", "cleanup-confirm",
  "cleanup-button", "cleanup-status", "cleanup-history"
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

function makeCompactionPrompt(source) {
  return `请帮我安全压缩这个已经停止增长的 Codex 日志数据库：${source.path}（当前约 ${formatBytes(source.bytes)}，WAL ${formatBytes(source.walBytes)}）。

严格要求：
1. 先用 lsof 和三次间隔采样确认数据库当前没有新增日志；不要删除数据库文件、WAL/SHM 或现有 trigger。
2. 使用 SQLite .backup 创建带时间戳的一致性备份，并运行 PRAGMA integrity_check；报告备份路径。
3. 统计 logs 表各 level 行数和可回收空间，先告诉我预计能释放多少。
4. 只有备份及完整性检查成功后，才清理历史 logs 行，并使用安全的 checkpoint/VACUUM 流程回收空间。不要处理聊天、索引、会话、模型或其他数据库。
5. 完成后再次运行 integrity_check，记录数据库与 WAL 的前后大小、MAX(id) 和 trigger 是否仍存在。
6. 如果数据库正被 Codex 占用或无法安全取得锁，停止修改并告诉我先退出哪个进程，不要强制操作。`;
}

function sourceCleanupInfo(source) {
  if (source.kind === "sqlite") return { level: "protected", text: "日志数据库，不能当普通文件删除", action: "compact" };
  if (source.kind === "wal") return { level: "protected", text: "数据库事务 WAL，由所属应用维护", action: null };
  if (!state.controlToken || state.reportMode !== "local") return { level: "neutral", text: "离线报告不能操作本机文件", action: null };
  if (!state.cleanupPreview) return { level: "neutral", text: "正在读取清理资格", action: null };
  const candidate = state.cleanupPreview.candidates?.find((item) => item.path === source.path);
  if (candidate) return { level: "ok", text: `可安全隔离 · ${candidate.ageDays} 天`, action: "select", candidate };
  const protectedItem = state.cleanupPreview.protected?.find((item) => item.path === source.path);
  if (protectedItem?.reasonCode === "active") return { level: "warning", text: "正在被进程使用，退出对应 Agent 后刷新", action: "refresh" };
  if (protectedItem?.reasonCode === "recent") return { level: "neutral", text: protectedItem.reason, action: "refresh" };
  return { level: "neutral", text: "不在普通旧日志清理范围", action: null };
}

function sourceCleanupCell(source) {
  const info = sourceCleanupInfo(source);
  const cell = document.createElement("td");
  cell.className = "source-cleanup-cell";
  const label = document.createElement("span");
  label.className = `source-cleanup-label ${info.level}`;
  label.textContent = info.text;
  cell.append(label);
  if (info.action === "select") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact-button";
    button.textContent = "选择清理";
    button.addEventListener("click", () => {
      state.cleanupSelection.add(info.candidate.id);
      renderCleanupPreview(state.cleanupPreview);
      document.querySelector("#cleanup")?.scrollIntoView({ behavior: "smooth" });
    });
    cell.append(button);
  } else if (info.action === "refresh") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact-button";
    button.textContent = "刷新资格";
    button.addEventListener("click", () => Promise.all([loadCleanupPreview(), scan()]));
    cell.append(button);
  } else if (info.action === "compact") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact-button";
    button.textContent = "生成安全压缩提示词";
    button.addEventListener("click", () => {
      elements.agent_prompt.value = makeCompactionPrompt(source);
      elements.copy_button.disabled = false;
      elements.copy_status.textContent = "已生成数据库备份与压缩提示词；不会直接删除数据库。";
      document.querySelector("#agent")?.scrollIntoView({ behavior: "smooth" });
    });
    cell.append(button);
  }
  return cell;
}

function renderSourceRows(report) {
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
    row.append(advice, sourceCleanupCell(source));
    return row;
  }));
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
  state.reportMode = mode;
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

  renderSourceRows(report);

  elements.agent_prompt.value = makePrompt(report);
  elements.copy_button.disabled = false;
  elements.download_button.disabled = false;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
}

function setCleanupStatus(message, level = "neutral") {
  elements.cleanup_status.textContent = message;
  elements.cleanup_status.dataset.level = level;
}

function updateCleanupControls() {
  const candidates = state.cleanupPreview?.candidates || [];
  const availableIds = new Set(candidates.map((candidate) => candidate.id));
  for (const id of state.cleanupSelection) {
    if (!availableIds.has(id)) state.cleanupSelection.delete(id);
  }
  const localReady = Boolean(state.controlToken);
  const selected = state.cleanupSelection.size;
  elements.cleanup_confirm.disabled = !localReady || selected === 0;
  if (selected === 0) elements.cleanup_confirm.checked = false;
  elements.cleanup_button.disabled = !localReady || selected === 0 || !elements.cleanup_confirm.checked;
  elements.cleanup_button.textContent = selected ? `移动 ${selected} 个日志到废纸篓` : "移动所选日志到废纸篓";
  elements.cleanup_select_all.disabled = !localReady || candidates.length === 0;
  elements.cleanup_select_all.textContent = candidates.length > 0 && selected === candidates.length ? "取消全选" : "全选候选";
}

function candidateRow(candidate) {
  const label = document.createElement("label");
  label.className = "cleanup-item";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = state.cleanupSelection.has(candidate.id);
  checkbox.disabled = !state.controlToken;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.cleanupSelection.add(candidate.id);
    else state.cleanupSelection.delete(candidate.id);
    updateCleanupControls();
  });
  const detail = document.createElement("span");
  detail.className = "cleanup-item-detail";
  const path = document.createElement("strong");
  path.textContent = candidate.path;
  const meta = document.createElement("small");
  meta.textContent = `${formatBytes(candidate.bytes)} · ${candidate.ageDays} 天前 · ${candidate.reason}`;
  detail.append(path, meta);
  label.append(checkbox, detail);
  return label;
}

function renderCleanupPreview(preview) {
  state.cleanupPreview = preview;
  elements.cleanup_candidate_count.textContent = formatInteger(preview.summary?.candidateFiles || 0);
  elements.cleanup_candidate_bytes.textContent = formatBytes(preview.summary?.candidateBytes || 0);
  const protectedCount = Number(preview.summary?.protectedActive || 0) + Number(preview.summary?.protectedRecent || 0);
  elements.cleanup_protected_count.textContent = formatInteger(protectedCount);
  const groups = new Map();
  for (const candidate of preview.candidates || []) {
    if (!groups.has(candidate.agent)) groups.set(candidate.agent, []);
    groups.get(candidate.agent).push(candidate);
  }
  if (!groups.size) {
    const empty = document.createElement("p");
    empty.className = "cleanup-empty";
    empty.textContent = `没有发现 ${preview.minAgeDays} 天以上、未被占用的可清理 Agent 日志。`;
    elements.cleanup_groups.replaceChildren(empty);
  } else {
    elements.cleanup_groups.replaceChildren(...[...groups.entries()].map(([agent, candidates]) => {
      const group = document.createElement("section");
      group.className = "cleanup-group";
      const heading = document.createElement("div");
      heading.className = "cleanup-group-heading";
      const title = document.createElement("strong");
      title.textContent = agent;
      const summary = document.createElement("span");
      summary.textContent = `${candidates.length} 个 · ${formatBytes(candidates.reduce((sum, item) => sum + item.bytes, 0))}`;
      const select = document.createElement("button");
      select.type = "button";
      select.className = "compact-button";
      select.textContent = "选择此组";
      select.disabled = !state.controlToken;
      select.addEventListener("click", () => {
        const allSelected = candidates.every((candidate) => state.cleanupSelection.has(candidate.id));
        for (const candidate of candidates) {
          if (allSelected) state.cleanupSelection.delete(candidate.id);
          else state.cleanupSelection.add(candidate.id);
        }
        renderCleanupPreview(state.cleanupPreview);
      });
      heading.append(title, summary, select);
      group.append(heading, ...candidates.map(candidateRow));
      return group;
    }));
  }
  updateCleanupControls();
  if (state.report) renderSourceRows(state.report);
}

function renderCleanupUnavailable() {
  state.controlToken = null;
  state.cleanupPreview = null;
  state.cleanupSelection.clear();
  elements.cleanup_candidate_count.textContent = "不可用";
  elements.cleanup_candidate_bytes.textContent = "—";
  elements.cleanup_protected_count.textContent = "—";
  const message = document.createElement("p");
  message.className = "cleanup-empty";
  message.textContent = "这是静态网页模式，浏览器没有本机文件权限。请下载项目并在本机运行 npm start 后使用清理功能。";
  elements.cleanup_groups.replaceChildren(message);
  elements.cleanup_refresh.disabled = true;
  elements.cleanup_age.disabled = true;
  elements.cleanup_history.replaceChildren(message.cloneNode(true));
  setCleanupStatus("清理按钮已安全禁用：未连接本地助手。", "warning");
  updateCleanupControls();
  if (state.report) renderSourceRows(state.report);
}

async function loadCleanupPreview() {
  if (!state.controlToken) return renderCleanupUnavailable();
  elements.cleanup_refresh.disabled = true;
  setCleanupStatus("正在重新扫描允许清理的旧日志…");
  try {
    const days = Number(elements.cleanup_age.value);
    const response = await fetch(`/api/cleanup/preview?days=${days}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderCleanupPreview(await response.json());
    setCleanupStatus("预览已刷新。只有所选文件在执行前再次通过安全检查才会被移动。", "ok");
  } catch (error) {
    setCleanupStatus(`预览失败：${error instanceof Error ? error.message : "未知错误"}`, "critical");
  } finally {
    elements.cleanup_refresh.disabled = false;
  }
}

function renderCleanupHistory(history) {
  state.cleanupHistory = history;
  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "cleanup-empty";
    empty.textContent = "暂无由网页创建的隔离记录。";
    elements.cleanup_history.replaceChildren(empty);
    return;
  }
  elements.cleanup_history.replaceChildren(...history.map((batch) => {
    const item = document.createElement("article");
    item.className = "history-item";
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${batch.files} 个日志 · ${formatBytes(batch.bytes)}`;
    const meta = document.createElement("small");
    meta.textContent = `${formatDate(batch.createdAt)} · ${batch.status} · ${batch.path}`;
    detail.append(title, meta);
    item.append(detail);
    if (batch.status === "quarantined") {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "compact-button";
      restore.textContent = "恢复原位";
      restore.addEventListener("click", () => restoreCleanup(batch.batchName, restore));
      item.append(restore);
    }
    return item;
  }));
}

async function loadCleanupHistory() {
  if (!state.controlToken) return;
  try {
    const response = await fetch("/api/cleanup/history", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    renderCleanupHistory(result.history || []);
  } catch (error) {
    setCleanupStatus(`无法读取隔离记录：${error instanceof Error ? error.message : "未知错误"}`, "warning");
  }
}

async function runCleanup() {
  if (!state.controlToken || !elements.cleanup_confirm.checked || state.cleanupSelection.size === 0) return;
  elements.cleanup_button.disabled = true;
  elements.cleanup_refresh.disabled = true;
  setCleanupStatus("正在执行二次安全扫描，并把符合条件的日志移动到废纸篓…");
  try {
    const response = await fetch("/api/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSD-Guard-Token": state.controlToken },
      body: JSON.stringify({ ids: [...state.cleanupSelection], minAgeDays: Number(elements.cleanup_age.value) })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    state.cleanupSelection.clear();
    elements.cleanup_confirm.checked = false;
    const failed = result.failed?.length ? `，${result.failed.length} 个因状态变化未移动` : "";
    const outcome = `已把 ${result.moved.length} 个日志（${formatBytes(result.movedBytes)}）移入 ${result.quarantinePath || "废纸篓"}${failed}。`;
    await Promise.all([loadCleanupPreview(), loadCleanupHistory(), scan()]);
    setCleanupStatus(outcome, result.moved.length ? "ok" : "warning");
  } catch (error) {
    setCleanupStatus(`清理失败：${error instanceof Error ? error.message : "未知错误"}`, "critical");
  } finally {
    elements.cleanup_refresh.disabled = false;
    updateCleanupControls();
  }
}

async function restoreCleanup(batchName, button) {
  if (!state.controlToken || !window.confirm("把这批日志恢复到原位置？如果原位置已有同名文件，系统会保留现有文件并跳过。")) return;
  button.disabled = true;
  setCleanupStatus("正在恢复隔离日志…");
  try {
    const response = await fetch("/api/cleanup/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SSD-Guard-Token": state.controlToken },
      body: JSON.stringify({ batchName })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const outcome = `已恢复 ${result.restored.length} 个日志${result.failed.length ? `，${result.failed.length} 个因冲突未恢复` : ""}。`;
    await Promise.all([loadCleanupPreview(), loadCleanupHistory()]);
    setCleanupStatus(outcome, result.failed.length ? "warning" : "ok");
  } catch (error) {
    button.disabled = false;
    setCleanupStatus(`恢复失败：${error instanceof Error ? error.message : "未知错误"}`, "critical");
  }
}

async function scan() {
  elements.scan_button.disabled = true;
  elements.scan_button.textContent = "采样中…";
  elements.source_rows.innerHTML = '<tr><td colspan="6" class="empty">正在进行两次间隔采样…</td></tr>';
  try {
    const response = await fetch("/api/scan", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json(), "local");
  } catch {
    setBadge("neutral", "静态网页模式");
    elements.scan_summary.textContent = "本地扫描器未连接";
    elements.scan_time.textContent = "请在项目目录运行 npm start，或导入 JSON 报告";
    elements.source_rows.innerHTML = '<tr><td colspan="6" class="empty">没有本机读取权限。远程网页无法直接读取你的磁盘。</td></tr>';
  } finally {
    elements.scan_button.disabled = false;
    elements.scan_button.textContent = "重新扫描本机";
  }
}

elements.scan_button.addEventListener("click", scan);
elements.cleanup_refresh.addEventListener("click", loadCleanupPreview);
elements.cleanup_age.addEventListener("change", () => {
  state.cleanupSelection.clear();
  elements.cleanup_confirm.checked = false;
  loadCleanupPreview();
});
elements.cleanup_select_all.addEventListener("click", () => {
  const candidates = state.cleanupPreview?.candidates || [];
  const allSelected = candidates.length > 0 && candidates.every((candidate) => state.cleanupSelection.has(candidate.id));
  state.cleanupSelection = allSelected ? new Set() : new Set(candidates.map((candidate) => candidate.id));
  renderCleanupPreview(state.cleanupPreview);
});
elements.cleanup_confirm.addEventListener("change", updateCleanupControls);
elements.cleanup_button.addEventListener("click", runCleanup);
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

async function initialize() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    if (health.mode !== "local" || typeof health.controlToken !== "string") throw new Error("Local helper unavailable");
    state.controlToken = health.controlToken;
    elements.cleanup_refresh.disabled = false;
    elements.cleanup_age.disabled = false;
    await Promise.all([scan(), loadCleanupPreview(), loadCleanupHistory()]);
  } catch {
    renderCleanupUnavailable();
    await scan();
  }
}

initialize();
