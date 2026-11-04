// The daily automatic backup follows the server's local clock (TZ), not UTC. Runs in Korean time on purpose: there
// the UTC date changes at 09:00, which used to move the 04:00 backup to 09:00 every day.
process.env.TZ = "Asia/Seoul";
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoBackupDue, localStamp } from "../server/durable.js";

test("automatic backups run once a local day at the chosen hour", () => {
  const names = [], made = [];
  for (let t = Date.parse("2026-10-27T00:00:00+09:00"); t < Date.parse("2026-10-31T00:00:00+09:00"); t += 10 * 60000) {
    const now = new Date(t);
    if (!autoBackupDue(now, 4, names)) continue;
    names.push(`fsk-${localStamp(now)}-auto.json`); made.push(localStamp(now));
  }
  assert.deepEqual(made, ["20261027-040000", "20261028-040000", "20261029-040000", "20261030-040000"]);
});

test("other kinds of backup on the same day do not count as the automatic one", () => {
  const now = new Date("2026-10-27T05:00:00+09:00");
  assert.equal(autoBackupDue(now, 4, ["fsk-20261027-030000-manual.json", "fsk-20261027-031000-pre-restore.json"]), true);
  assert.equal(autoBackupDue(now, 4, ["fsk-20261027-041000-auto.json"]), false);
  assert.equal(autoBackupDue(new Date("2026-10-27T03:59:00+09:00"), 4, []), false, "not before the hour");
});

test("backup names use local time", () => {
  assert.equal(localStamp(new Date("2026-10-27T04:05:06+09:00")), "20261027-040506");
});
