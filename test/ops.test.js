// Server operations: audit log in backups and its archive files, health check-ins, sign-up races, locked files,
// streamed uploads, compression and live-stream limits. Starts its own servers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { startServer, Client, member, ROOT } from "./helpers/server.js";
import { readTarGz } from "../server/archive.js";
import { statementXlsx } from "./helpers/xlsx.js";

let srv, ping, pings = [], dev, a, b;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

before(async () => {
  ping = http.createServer((req, res) => { let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => { pings.push({ url: req.url, body }); res.end("OK"); }); });
  await new Promise((r) => ping.listen(0, "127.0.0.1", r));
  srv = await startServer({ HEALTH_PING_URL: `http://127.0.0.1:${ping.address().port}/check-uuid` });
  dev = new Client(srv.base);
  await dev.post("/api/auth/signup", { username: "dev", password: "password1", name: "개발자" });
  a = await member(srv.base, dev, "aaa", "에이", { dept: "chassis" });
  b = await member(srv.base, dev, "bbb", "비", { dept: "aero" });
});
after(() => { srv.stop(); ping.close(); });

test("two first sign-ups at once make only one developer", async () => {
  const s = await startServer();
  try {
    const rs = await Promise.all(["one", "two", "three"].map((u) => new Client(s.base).post("/api/auth/signup", { username: u, password: "password-" + u, name: u, dept: "aero" })));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(rs.filter((r) => r.json.role === "developer").length, 1);
    const same = await Promise.all([1, 2].map(() => new Client(s.base).post("/api/auth/signup", { username: "twin", password: "password-twin", name: "twin", dept: "aero" })));
    assert.deepEqual(same.map((r) => r.status).sort(), [200, 409], "the same id at once: one wins, one is told it is taken");
  } finally { s.stop(); }
});

test("a submitted 사비 file cannot be deleted by its submitter", async () => {
  const xlsx = Buffer.from(statementXlsx({ items: [{ team: "에어로", date: 46300, cat: "프레임&바디", purpose: "윙", product: "카본", vendor: "https://smartstore.naver.com/c", price: 1000, qty: 1 }] }).buffer.toString("base64"));
  const fileAsset = (await a.post("/api/assets", xlsx, { "content-type": "text/plain" })).json.id;
  const receipt = (await a.post("/api/assets", PNG, { "content-type": "image/png" })).json.id;
  const spare = (await a.post("/api/assets", PNG, { "content-type": "image/png" })).json.id;
  const s1 = { id: "s1", applicant: "에이", fileName: "개인사비사용내역서_에이_20261015.xlsx", total: 1000, fileAsset, receipts: [{ asset: receipt, slot: 1, type: "image/png" }] };
  assert.equal((await a.post("/api/db/set", { path: `expenses/${a.id}`, data: { subs: { s1 } } })).status, 200);
  for (const id of [fileAsset, receipt]) {
    const r = await a.req("DELETE", `/api/assets/${id}`);
    assert.equal(r.status, 403); assert.equal(r.json.code, "locked");
  }
  assert.equal((await a.get(`/_blob/${fileAsset}`)).status, 200, "the original is still there");
  assert.equal((await a.req("DELETE", `/api/assets/${spare}`)).json.deleted, true, "files in no 사비 record can still be removed");
  assert.equal((await dev.req("DELETE", `/api/assets/${receipt}`)).json.deleted, true, "developers keep 완전 삭제");
});

test("a locked part's attachments are removed only by those who manage its department", async () => {
  const photo = (await a.post("/api/assets", PNG, { "content-type": "image/png" })).json.id;
  assert.equal((await a.post("/api/db/set", { path: "parts/lk", data: { name: "업라이트", dept: "chassis", attachments: [{ id: photo, name: "u.png" }] } })).status, 200);
  assert.equal((await dev.post("/api/db/update", { path: "parts/lk", data: { locked: true } })).status, 200);
  const r = await a.req("DELETE", `/api/assets/${photo}`);
  assert.equal(r.status, 403); assert.equal(r.json.code, "locked");
  await dev.post("/api/db/update", { path: "parts/lk", data: { locked: false } });
  assert.equal((await a.req("DELETE", `/api/assets/${photo}`)).json.deleted, true, "unlocked: the uploader may remove it again");
});

test("uploads are streamed to disk and refused early when too large", async () => {
  const big = await new Promise((resolve) => {
    const req = http.request(srv.base + "/api/assets", { method: "POST", headers: { "x-fsk": "1", cookie: a.cookie, "content-type": "image/png", "content-length": 21 * 1024 * 1024 } }, (res) => { let t = ""; res.on("data", (d) => { t += d; }); res.on("end", () => resolve({ status: res.statusCode, body: t })); });
    req.on("error", () => resolve({ status: 0 }));
    req.end();
  });
  assert.equal(big.status, 413);
  const bad = await a.post("/api/assets", Buffer.from("not a png at all"), { "content-type": "image/png" });
  assert.equal(bad.status, 415);
  const ok = await a.post("/api/assets", Buffer.concat([PNG, Buffer.alloc(200 * 1024, 1)]), { "content-type": "image/png" });
  assert.equal(ok.status, 200); assert.equal(ok.json.sizeBytes, PNG.length + 200 * 1024);
  assert.equal((await a.get(`/_blob/${ok.json.id}`)).buf.length, PNG.length + 200 * 1024);
  assert.deepEqual(readdirSync(join(srv.dataDir, "assets")).filter((f) => f.endsWith(".part")), [], "no partial files left behind");
});

test("backups carry the audit log, and the log is archived to its own files before old entries leave the database", async () => {
  // an entry from two years ago, as if the server had been running that long
  const sql = new DatabaseSync(join(srv.dataDir, "fsk.db"));
  sql.prepare("INSERT INTO audit (at, actor, actor_name, action, target, detail, ip) VALUES (?, NULL, 'old', 'login', 'ancient', '', '1.2.3.4')").run("2024-10-15T03:00:00.000Z");
  sql.close();
  const name = (await dev.post("/api/admin/backups", { note: "audit" })).json.name;
  const backup = JSON.parse((await dev.get(`/api/admin/backups/${name}`)).text);
  assert.ok(Array.isArray(backup.audit) && backup.audit.some((e) => e.target === "ancient"), "the backup holds the whole audit log");
  assert.ok(backup.audit.some((e) => e.action === "backup.create" && e.target === name), "including the record of this backup");

  const list = (await dev.get("/api/admin/backups")).json.auditArchives.map((f) => f.name);
  assert.ok(list.includes("fsk-audit-2024-10.jsonl"), list.join());
  const old = (await dev.get("/api/admin/audit-archives/fsk-audit-2024-10.jsonl")).text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(old[0].target, "ancient");
  assert.ok(!(await dev.get("/api/admin/audit?limit=1000")).json.entries.some((e) => e.target === "ancient"), "archived and older than a year: out of the database");

  const before = readFileSync(join(srv.dataDir, "backups", "audit", list[0]), "utf8");
  await a.post("/api/auth/login", { username: "aaa", password: "password-aaa" });
  const r = (await dev.post("/api/admin/audit-archive", {})).json;
  assert.ok(r.archived >= 1);
  const now = readFileSync(join(srv.dataDir, "backups", "audit", list[0]), "utf8");
  assert.ok(now.startsWith(before) && now.length > before.length, "new entries are appended, nothing is rewritten");
  const ids = now.trim().split("\n").map((l) => JSON.parse(l).id);
  assert.equal(new Set(ids).size, ids.length, "each entry once");
  assert.equal((await dev.post("/api/admin/audit-archive", {})).json.archived, 1, "only the record of the last 보관 is new");
  assert.equal((await dev.get("/api/admin/audit-archives/..%2Ffsk.db")).status, 404);
  assert.equal((await a.get("/api/admin/audit-archives/" + list[0])).status, 403, "developers only");
});

test("audit archive files go to the off-site copy and into full backups, and the CLI brings them back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsk-mirror-")), target = mkdtempSync(join(tmpdir(), "fsk-cli-"));
  try {
    assert.equal((await dev.post("/api/admin/settings", { mirrorDir: dir })).status, 200);
    assert.equal((await dev.post("/api/admin/mirror", {})).json.ok, true);
    assert.ok(readdirSync(join(dir, "audit")).includes("fsk-audit-2024-10.jsonl"));
    await dev.post("/api/admin/settings", { mirrorDir: "" });

    const full = await dev.get("/api/admin/backups-full");
    const names = [];
    const out = await readTarGz(Readable.from(full.buf), (n) => { names.push(n); return n === "backup.json" ? "json" : null; });
    assert.ok(names.some((n) => /^audit\/fsk-audit-\d{4}-\d{2}\.jsonl$/.test(n)), names.join());
    const json = JSON.parse(out.json.toString());
    writeFileSync(join(target, "..", `fsk-ops-${process.pid}.tar.gz`), full.buf);

    const run = (...args) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "server/cli.js"), ...args], { env: { ...process.env, DATA_DIR: target }, encoding: "utf8" });
    assert.equal(run("create-user", "first", "developer", "먼저").status, 0, "an account made here before restoring");
    const r = run("restore", join(target, "..", `fsk-ops-${process.pid}.tar.gz`), "--force");
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /감사 로그 보관 파일 \d+개/);
    assert.ok(existsSync(join(target, "backups", "audit", "fsk-audit-2024-10.jsonl")));
    const db = new DatabaseSync(join(target, "fsk.db"));
    const rows = db.prepare("SELECT * FROM audit ORDER BY id").all();
    const archived = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'auditArchivedId'").get().value);
    db.close();
    assert.ok(json.audit.every((e) => rows.some((x) => x.id === e.id && x.action === e.action && x.at === e.at)), "the backup's entries keep their ids");
    assert.ok(rows.some((x) => x.action === "user.create" && x.target === "first"), "this server's own entries stay");
    assert.equal(rows.at(-1).action, "backup.restore");
    const inFiles = readdirSync(join(target, "backups", "audit")).flatMap((f) => readFileSync(join(target, "backups", "audit", f), "utf8").trim().split("\n").map((l) => JSON.parse(l).id));
    assert.equal(archived, Math.max(...inFiles), "archived up to what the archive files hold, so nothing else is pruned");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); rmSync(join(target, "..", `fsk-ops-${process.pid}.tar.gz`), { force: true }); }
});

test("health check-ins go to HEALTH_PING_URL", async () => {
  const r = await dev.post("/api/admin/health-ping", {});
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
  assert.equal(pings.at(-1).url, "/check-uuid");
  const st = (await dev.get("/api/admin/status")).json;
  assert.equal(st.healthPing.configured, true); assert.equal(st.healthPing.last.ok, true);
  assert.ok(st.audit.entries > 0 && st.audit.archives > 0);
  assert.equal((await a.post("/api/admin/health-ping", {})).status, 403);
  const h = await fetch(srv.base + "/healthz");
  assert.equal(h.status, 200); assert.equal((await h.json()).ok, true);
});

test("a check-in address with a query string gets a plain GET", async () => {
  const s = await startServer({ HEALTH_PING_URL: `http://127.0.0.1:${ping.address().port}/api/push/abc?status=up` });
  try {
    const d = new Client(s.base);
    await d.post("/api/auth/signup", { username: "dev", password: "password1", name: "개발자" });
    const before = pings.length;
    assert.equal((await d.post("/api/admin/health-ping", {})).json.ok, true);
    assert.equal(pings.length, before + 1); assert.equal(pings.at(-1).url, "/api/push/abc?status=up"); assert.equal(pings.at(-1).body, "");
  } finally { s.stop(); }
});

test("pages, scripts and large JSON go out gzipped when asked", async () => {
  const page = await fetch(srv.base + "/", { headers: { cookie: a.cookie, "accept-encoding": "gzip" } });
  assert.equal(page.headers.get("content-encoding"), "gzip");
  assert.match(await page.text(), /<script nonce=/, "and still arrive whole");
  const js = await fetch(srv.base + "/vendor/jszip.min.js", { headers: { "accept-encoding": "gzip" } });
  assert.equal(js.headers.get("content-encoding"), "gzip");
  const plain = await new Promise((resolve) => http.get(srv.base + "/vendor/jszip.min.js", (res) => { res.resume(); resolve(res.headers["content-encoding"]); }));
  assert.equal(plain, undefined, "no gzip unless the client says it takes it");
  const small = await fetch(srv.base + "/healthz", { headers: { "accept-encoding": "gzip" } });
  assert.equal(small.headers.get("content-encoding"), null, "tiny responses are sent as they are");
});

test("one person keeps at most ten live streams", async () => {
  const open = () => new Promise((resolve) => {
    const req = http.get(srv.base + "/api/stream", { headers: { cookie: b.cookie } }, (res) => { const s = { res, ended: false }; res.on("data", () => {}); res.on("end", () => { s.ended = true; }); res.on("close", () => { s.ended = true; }); resolve(s); });
    req.on("error", () => resolve({ ended: true }));
  });
  const streams = [];
  for (let i = 0; i < 11; i++) streams.push(await open());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(streams[0].ended, true, "the oldest is closed");
  assert.equal(streams.slice(1).filter((s) => !s.ended).length, 10);
  for (const s of streams) s.res?.destroy();
});
