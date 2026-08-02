# SSD Write Guard

一个本地优先的 SSD 与 AI 工具写盘看板。它会只读检测磁盘容量、Apple SSD SMART 状态、系统资源，以及常见 AI 工具日志和 SQLite WAL 的短时增长量；用户明确选择后，也可以把够旧且未占用的普通日志移入可恢复的废纸篓隔离区。

网页采用浅色液态玻璃界面，通过透明层、边缘折射和高光表现材质，不依赖毛玻璃模糊。扫描不会上传文件内容、聊天记录、提示词、用户名或主机名。

## 功能

- APFS Data 卷容量、SSD 型号、接口与 SMART 状态
- CPU、逻辑核心、系统运行时间与 macOS `memory_pressure` 内存数据
- Codex 日志数据库大小、WAL、`MAX(id)`、TRACE 行数和 trigger 范围
- Claude、Continue、VS Code Copilot 和 Ollama 的日志/WAL 增长采样
- 实时写入速率、总监控体积、总 WAL 与各数据源对比看板
- 区分仅拦截 TRACE 与拦截全部日志
- 下载或导入隐私友好的 JSON 报告
- 按 7 / 30 / 90 天筛选 Codex、Claude、Cursor、VS Code Agents、Continue、Aider、Ollama 与 ChatGPT/OpenAI 的旧日志
- 按工具或逐文件选择，二次确认后移入废纸篓，并可从清理记录恢复原位
- 安全分步教程和一键复制 Agent 处理提示词
- 桌面与移动端响应式布局

## 本机运行

需要 Node.js 20 或更新版本。macOS 上建议保留系统自带的 `sqlite3` 命令行工具。

```bash
npm start
```

浏览器打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。服务默认只绑定 `127.0.0.1`，局域网和互联网无法访问本机扫描接口。

## 给其他用户使用

最安全的方式是让用户下载项目并在自己的电脑运行 `npm start`。这样网页看到的是用户本机数据，检查过程全部留在本机。

如果只部署 `public/` 为静态网站，远程浏览器没有权限直接读取或清理用户磁盘，清理按钮会保持禁用。用户需要先在本机项目目录生成报告：

```bash
npm run scan --silent > ssd-write-guard-report.json
```

随后在网页中点击“导入报告”。报告只包含容量、文件大小、增长速率、匿名化路径和状态，不包含文件内容或主机名。

## 项目结构

```text
public/             浏览器界面、看板与 Agent 提示词
src/scanner.mjs     只读系统与 SQLite/WAL 扫描器
src/cleanup.mjs     旧日志白名单扫描、废纸篓隔离与恢复
server.mjs          仅监听 127.0.0.1 的本地 HTTP 服务
report.mjs          隐私报告命令行输出
test/               Node 单元测试
```

## 检测范围与阈值

- Codex `~/.codex/logs_2.sqlite`
- Claude `~/Library/Logs/Claude/main.log`
- Continue 索引 WAL
- VS Code Copilot Chat 会话 WAL
- Ollama 聊天数据库 WAL

阈值只用于筛查：增长达到 64 KB/s 标记为需要复查，达到 1 MB/s 标记为高风险；Codex 日志达到 10 INSERT/s 也会标记为高风险。单次存在 WAL 不等于异常。

## 安全日志清理

网页只把以下条件全部成立的文件列为候选：文件位于内置 Agent 日志白名单目录、扩展名为 `.log` / 轮转日志 / `.out`、早于所选阈值，并且 `lsof` 未发现进程正在占用。执行清理时服务端会重新扫描，网页提交的只是候选 ID，不能指定任意文件路径。

选中的文件会移动到 `~/.Trash/SSD-Write-Guard-<时间>-<随机值>/`，并生成权限为 `0600` 的恢复清单。网页没有永久删除接口；隔离记录中的“恢复原位”会避免覆盖已经存在的同名文件。

明确排除：SQLite 数据库、`-wal`、`-shm`、聊天、索引、模型、缓存和备份。Codex 的 `~/.codex/logs_*.sqlite` 不属于清理根目录。

看板中的“监控占用”会同时显示日志数据库与 WAL，用来判断写盘风险，并不代表这些空间都能直接删除。“清理方式”列会区分可隔离的旧普通日志、仍被进程占用或过新的日志，以及必须由数据库安全流程处理的 SQLite/WAL。

## 安全边界

- 服务默认只监听 `127.0.0.1`。改变本机文件的请求需要随机会话令牌、自定义请求头和同源校验。
- 清理端点只支持移动到废纸篓和恢复，不提供永久删除。
- Agent 提示词要求先重复采样、SQLite 一致性备份和完整性检查。
- 默认只建议拦截 TRACE；拦截全部日志必须再次获得用户确认。
- 不删除 Ollama 模型、聊天记录、索引、缓存、数据库、WAL 或备份。
- 报告中的用户主目录会匿名化为 `~`，主机名固定输出为 `redacted`。

## 测试

```bash
npm test
```

调整端口与采样时间：

```bash
SSD_GUARD_PORT=4180 SSD_GUARD_SAMPLE_MS=5000 npm start
```

## 部署状态

当前仓库只包含项目源码，没有启用 GitHub Pages、Actions 部署或其他线上发布流程。
