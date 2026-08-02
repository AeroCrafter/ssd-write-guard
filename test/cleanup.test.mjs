import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile, rm } from "node:fs/promises";
import { quarantineCleanupCandidates, restoreCleanupBatch, scanCleanupCandidates } from "../src/cleanup.mjs";

test("cleanup preview, quarantine, and restore are recoverable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ssd-write-guard-"));
  const logsRoot = path.join(tempRoot, "logs");
  const trashRoot = path.join(tempRoot, "trash");
  await mkdir(logsRoot, { recursive: true });
  await mkdir(trashRoot, { recursive: true });
  const oldLog = path.join(logsRoot, "old-agent.log");
  const recentLog = path.join(logsRoot, "recent-agent.log");
  await writeFile(oldLog, "old log\n");
  await writeFile(recentLog, "recent log\n");
  const now = new Date("2026-08-02T10:00:00Z");
  const oldTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await utimes(oldLog, oldTime, oldTime);
  const definitions = [{ id: "test-agent", name: "Test Agent", roots: [logsRoot], matches: (filePath) => filePath.endsWith(".log") }];

  try {
    const preview = await scanCleanupCandidates({ minAgeDays: 7, definitions, now: now.getTime(), checkOpen: false });
    assert.equal(preview.candidates.length, 1);
    assert.equal(preview.candidates[0].path, oldLog);
    assert.equal(preview.summary.protectedRecent, 1);

    const cleaned = await quarantineCleanupCandidates([preview.candidates[0].id], { minAgeDays: 7, definitions, trashRoot, now, checkOpen: false });
    assert.equal(cleaned.moved.length, 1);
    await assert.rejects(stat(oldLog));
    const manifest = JSON.parse(await readFile(path.join(trashRoot, cleaned.batchName, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "quarantined");

    const restored = await restoreCleanupBatch(cleaned.batchName, { definitions, trashRoot, now: new Date(now.getTime() + 1000) });
    assert.equal(restored.restored.length, 1);
    assert.equal((await readFile(oldLog, "utf8")), "old log\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
