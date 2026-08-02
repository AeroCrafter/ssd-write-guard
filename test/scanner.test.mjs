import test from "node:test";
import assert from "node:assert/strict";
import { parseDf } from "../src/scanner.mjs";

test("parseDf reads macOS df output", () => {
  const result = parseDf(`Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on
/dev/disk3s5 971298980 546422964 389902540 59% 1939510 3899025400 0% /System/Volumes/Data`);
  assert.equal(result.capacityPercent, 59);
  assert.equal(result.totalBytes, 971298980 * 1024);
  assert.equal(result.mount, "/System/Volumes/Data");
});

test("parseDf returns null for incomplete output", () => {
  assert.equal(parseDf("Filesystem"), null);
});
