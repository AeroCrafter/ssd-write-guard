import test from "node:test";
import assert from "node:assert/strict";
import { parseDf, parseSmartctlJson } from "../src/scanner.mjs";

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

test("parseSmartctlJson derives NVMe remaining life and written bytes", () => {
  const health = parseSmartctlJson(JSON.stringify({
    smart_status: { passed: true },
    nvme_smart_health_information_log: {
      percentage_used: 3,
      available_spare: 100,
      available_spare_threshold: 10,
      temperature: 39,
      data_units_written: 1000,
      data_units_read: 2000,
      power_on_hours: 143,
      power_cycles: 168,
      unsafe_shutdowns: 11,
      media_errors: 0,
      num_err_log_entries: 0,
      critical_warning: 0
    }
  }));
  assert.equal(health.remainingLifePercent, 97);
  assert.equal(health.hostWritesBytes, 512000000);
  assert.equal(health.mediaErrors, 0);
});
