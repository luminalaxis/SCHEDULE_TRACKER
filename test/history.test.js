// The server prunes 변경 이력 older than 90 days itself (팀원 can no longer delete entries).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "fsk-hist-"));
process.env.DATA_DIR = dataDir;
const { docs, db, pruneHistory } = await import("../server/server.js");
after(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

test("history older than 90 days is pruned, newer entries stay", () => {
  const day = 86400000, at = (n) => new Date(Date.now() - n * day).toISOString();
  docs.set("history/old", { at: at(91), action: "오래됨" }, "system");
  docs.set("history/recent", { at: at(89), action: "최근" }, "system");
  docs.set("history/noat", { action: "시간 없음" }, "system");
  pruneHistory();
  assert.ok(!docs.get("history/old"));
  assert.ok(docs.get("history/recent"));
  assert.ok(!docs.get("history/noat"), "an entry without a time is pruned too");
});
