// End-to-end API tests: starts the real server on a temp data dir and drives it over HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dataDir;

class Client {
  constructor() { this.cookie = ""; }
  async req(method, path, body, headers = {}) {
    const h = { "x-fsk": "1", ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload;
    if (body instanceof Buffer) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
    const r = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    const set = r.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  }
}
const dev = new Client(), mem = new Client(), view = new Client();
let devId, memId;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "fsk-test-"));
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "server/server.js")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: "pipe" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
});
after(() => { proc.kill(); rmSync(dataDir, { recursive: true, force: true }); });

test("first signup becomes the developer", async () => {
  const r = await dev.req("POST", "/api/auth/signup", { username: "dev", password: "password1", name: "개발자" });
  assert.equal(r.status, 200); assert.equal(r.json.role, "developer"); assert.equal(r.json.status, "active");
  devId = (await dev.req("GET", "/api/me")).json.id;
  const roles = (await dev.req("GET", "/api/db/doc?path=config/roles")).json;
  assert.equal(roles.data.ownerUid, devId);
});

test("later signups wait for approval", async () => {
  const r = await mem.req("POST", "/api/auth/signup", { username: "mem", password: "password2", name: "팀원", dept: "aero" });
  assert.equal(r.json.status, "pending");
  const l = await mem.req("POST", "/api/auth/login", { username: "mem", password: "password2" });
  assert.equal(l.status, 403); assert.equal(l.json.code, "pending");
});

test("developer approves; member can log in", async () => {
  const users = (await dev.req("GET", "/api/admin/users")).json.users;
  memId = users.find((u) => u.username === "mem").id;
  assert.equal((await dev.req("POST", `/api/admin/users/${memId}`, { status: "active", role: "member" })).status, 200);
  assert.equal((await mem.req("POST", "/api/auth/login", { username: "mem", password: "password2" })).status, 200);
  assert.equal((await mem.req("POST", "/api/auth/login", { username: "mem", password: "wrong" })).status, 401);
});

test("mutations need the x-fsk header (CSRF guard)", async () => {
  const r = await mem.req("POST", "/api/db/set", { path: "parts/a", data: {} }, { "x-fsk": "0" });
  assert.equal(r.status, 403);
});

test("access rules match the Artifact rules", async () => {
  assert.equal((await mem.req("POST", "/api/db/set", { path: "parts/p1", data: { name: "업라이트" } })).status, 200);
  assert.equal((await mem.req("POST", "/api/db/set", { path: "config/roles", data: { ownerUid: memId, treasurers: [memId] } })).status, 403, "only the owner writes config/roles");
  assert.equal((await mem.req("POST", "/api/db/set", { path: `expenses/${devId}`, data: { subs: {} } })).status, 403, "no writing someone else's expenses");
  assert.equal((await mem.req("POST", "/api/db/set", { path: `reviews/${devId}`, data: { items: {} } })).status, 403, "no writing someone else's reviews");
  assert.equal((await mem.req("POST", "/api/db/set", { path: `expenses/${memId}`, data: { subs: {} } })).status, 200, "own expenses doc is writable");
  assert.equal((await dev.req("POST", "/api/db/set", { path: `expenses/${memId}`, data: { subs: {} } })).status, 200, "developer (owner level) can write anyone's");
  const q = await mem.req("POST", "/api/db/query", { collection: "parts" });
  assert.equal(q.json.docs.length, 1);
});

test("update merges nested objects and needs an existing doc", async () => {
  await mem.req("POST", "/api/db/set", { path: "parts/p2", data: { a: { x: 1, y: 2 }, list: [1, 2] } });
  await mem.req("POST", "/api/db/update", { path: "parts/p2", data: { a: { y: 3 }, list: [9] } });
  const d = (await mem.req("GET", "/api/db/doc?path=parts/p2")).json.data;
  assert.deepEqual(d, { a: { x: 1, y: 3 }, list: [9] });
  assert.equal((await mem.req("POST", "/api/db/update", { path: "parts/nope", data: { a: 1 } })).status, 400);
});

test("query supports where / orderBy / limit", async () => {
  for (const [id, at] of [["h1", "2026-01-01"], ["h2", "2026-03-01"], ["h3", "2026-02-01"]]) await mem.req("POST", "/api/db/set", { path: `history/${id}`, data: { at } });
  const r = await mem.req("POST", "/api/db/query", { collection: "history", orderBy: { field: "at", dir: "desc" }, limit: 2 });
  assert.deepEqual(r.json.docs.map((d) => d.id), ["h2", "h3"]);
  const w = await mem.req("POST", "/api/db/query", { collection: "history", where: [["at", "<", "2026-02-15"]] });
  assert.deepEqual(w.json.docs.map((d) => d.id).sort(), ["h1", "h3"]);
});

test("members cannot reach the admin console", async () => {
  assert.equal((await mem.req("GET", "/api/admin/status")).status, 403);
  const page = await mem.req("GET", "/admin");
  assert.equal(page.status, 302); assert.equal(page.headers.get("location"), "/");
  assert.equal((await dev.req("GET", "/admin")).status, 200);
});

test("부팀장 is the treasurer; positions are unique and hand over", async () => {
  await dev.req("POST", `/api/admin/users/${memId}`, { position: "vice_lead" });
  let roles = (await dev.req("GET", "/api/db/doc?path=config/roles")).json.data;
  assert.deepEqual(roles.treasurers, [memId]);
  assert.equal((await mem.req("GET", "/api/me")).json.title, "부팀장 (총무)");
  assert.equal((await mem.req("POST", "/api/db/set", { path: "config/roles", data: { ownerUid: memId } })).status, 403, "부팀장 still cannot edit roles");
  // a new 부팀장 takes over; the previous one goes back to 팀원
  const c = await dev.req("POST", "/api/admin/users", { username: "vice2", name: "새부팀장", role: "member", position: "vice_lead" });
  assert.equal(c.json.handedOver[0].name, "팀원");
  roles = (await dev.req("GET", "/api/db/doc?path=config/roles")).json.data;
  assert.deepEqual(roles.treasurers, [c.json.user.id]);
  const users = (await dev.req("GET", "/api/admin/users")).json.users;
  assert.equal(users.find((u) => u.id === memId).position, "");
  // the page's 권한 관리 dialog cannot make a non-부팀장 the treasurer on this server
  await dev.req("POST", "/api/db/set", { path: "config/roles", data: { ownerUid: devId, treasurers: [memId], allowMemberSubmit: false } });
  roles = (await dev.req("GET", "/api/db/doc?path=config/roles")).json.data;
  assert.deepEqual(roles.treasurers, [c.json.user.id]);
  assert.equal(roles.allowMemberSubmit, false);
  await dev.req("POST", "/api/admin/settings", { allowMemberSubmit: true });
  assert.equal((await dev.req("GET", "/api/db/doc?path=config/roles")).json.data.allowMemberSubmit, true);
});

test("파트장 needs a department and is unique per department", async () => {
  assert.equal((await dev.req("POST", "/api/admin/users", { username: "pl0", name: "부서없음", position: "part_lead" })).status, 400);
  const a = await dev.req("POST", "/api/admin/users", { username: "pl1", name: "에어로파트장", position: "part_lead", dept: "aero" });
  const b = await dev.req("POST", "/api/admin/users", { username: "pl2", name: "배터리파트장", position: "part_lead", dept: "battery" });
  assert.equal(b.json.handedOver.length, 0, "different departments do not clash");
  const c = await dev.req("POST", "/api/admin/users", { username: "pl3", name: "새에어로", position: "part_lead", dept: "aero" });
  assert.deepEqual(c.json.handedOver.map((h) => h.name), ["에어로파트장"]);
  assert.equal(a.json.user.tier, "executive");
});

test("only executives change team settings", async () => {
  await dev.req("POST", `/api/admin/users/${memId}`, { position: "" });
  assert.equal((await mem.req("POST", "/api/db/set", { path: "config/car", data: { carName: "x" } })).status, 403);
  assert.equal((await mem.req("POST", "/api/db/set", { path: "milestones/m9", data: { title: "x" } })).status, 403);
  assert.equal((await mem.req("POST", "/api/db/set", { path: "sessions/s9", data: { date: "2026-10-01" } })).status, 200, "members still log test sessions");
  await dev.req("POST", `/api/admin/users/${memId}`, { position: "team_lead" });
  assert.equal((await mem.req("POST", "/api/db/set", { path: "config/car", data: { carName: "KR-27" } })).status, 200);
  assert.equal((await mem.req("GET", "/api/me")).json.level, 3);
  await dev.req("POST", `/api/admin/users/${memId}`, { position: "" });
});

test("the last developer cannot demote or disable themselves", async () => {
  const r = await dev.req("POST", `/api/admin/users/${devId}`, { role: "member" });
  assert.match(r.json.message, /마지막 개발자/);
  assert.equal(r.status, 400);
});

test("assets: upload, serve, permissions", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const up = await mem.req("POST", "/api/assets", png, { "content-type": "image/png", "x-file-name": "r.png" });
  assert.equal(up.status, 200); assert.match(up.json.id, /^[a-f0-9]{32}$/);
  const blob = await fetch(BASE + up.json.url, { headers: { cookie: mem.cookie } });
  assert.equal(blob.status, 200); assert.equal(blob.headers.get("content-type"), "image/png");
  assert.equal((await fetch(BASE + up.json.url)).status, 401, "blobs need a session");
  assert.equal((await mem.req("POST", "/api/assets", Buffer.from("x"), { "content-type": "application/x-msdownload" })).status, 415);
  const xlsx = await mem.req("POST", "/api/assets", Buffer.from("504b030414000000", "hex"), { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  assert.equal(xlsx.status, 200, "xlsx is accepted on the self-hosted server");
});

test("accounts created by the developer must change the temp password", async () => {
  const c = await dev.req("POST", "/api/admin/users", { username: "view", name: "새팀원" });
  assert.equal(c.status, 200); assert.equal(c.json.user.tier, "member");
  const l = await view.req("POST", "/api/auth/login", { username: "view", password: c.json.tempPassword });
  assert.equal(l.json.user.mustChangePassword, true);
  assert.equal((await view.req("GET", "/api/db/doc?path=parts/p1")).status, 401, "must change the temp password first");
  assert.equal((await view.req("POST", "/api/auth/password", { current: c.json.tempPassword, next: "member-pass" })).status, 200);
  assert.equal((await view.req("GET", "/api/db/doc?path=parts/p1")).json.exists, true);
});

test("live updates reach other signed-in users", async () => {
  const ctrl = new AbortController();
  const res = await fetch(BASE + "/api/stream", { headers: { cookie: mem.cookie }, signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = "";
  const got = (async () => {
    while (!buf.includes("parts/live")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
    return buf;
  })();
  await new Promise((r) => setTimeout(r, 100));
  await dev.req("POST", "/api/db/set", { path: "parts/live", data: { name: "실시간" } });
  const text = await Promise.race([got, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
  ctrl.abort();
  assert.match(text, /event: change/); assert.match(text, /실시간/);
});

test("backup, replace, restore", async () => {
  const b = await dev.req("POST", "/api/admin/backups", { note: "test" });
  assert.equal(b.status, 200);
  await dev.req("DELETE", "/api/admin/doc?path=parts/p1");
  assert.equal((await dev.req("GET", "/api/db/doc?path=parts/p1")).json.exists, false);
  const r = await dev.req("POST", `/api/admin/backups/${b.json.name}/restore`, { mode: "replace" });
  assert.equal(r.status, 200);
  assert.equal((await dev.req("GET", "/api/db/doc?path=parts/p1")).json.data.name, "업라이트");
  const list = (await dev.req("GET", "/api/admin/backups")).json.backups;
  assert.ok(list.some((x) => x.name.endsWith("-pre-restore.json")), "a safety backup is taken before restoring");
});

test("import merges claude.ai-style exports", async () => {
  const body = Buffer.from(JSON.stringify({ docs: [{ path: "milestones/m1", data: { title: "설계 보고서", date: "2026-11-01" } }, { collection: "parts", id: "imp", data: { name: "가져온 부품" } }] }));
  const r = await dev.req("POST", "/api/admin/import?mode=merge", body, { "content-type": "application/json" });
  assert.equal(r.json.imported, 2);
  assert.equal((await dev.req("GET", "/api/db/doc?path=parts/imp")).json.data.name, "가져온 부품");
  assert.equal((await dev.req("GET", "/api/db/doc?path=parts/p1")).json.exists, true, "merge keeps existing docs");
});

test("audit log records security events", async () => {
  const rows = (await dev.req("GET", "/api/admin/audit?limit=500")).json.entries.map((e) => e.action);
  for (const a of ["signup", "login", "login.fail", "user.approve", "user.create", "backup.restore", "data.import"]) assert.ok(rows.includes(a), `missing ${a}`);
});

test("disabling a user ends their session", async () => {
  await dev.req("POST", `/api/admin/users/${memId}`, { status: "disabled" });
  assert.equal((await mem.req("GET", "/api/me")).status, 401);
  assert.equal((await mem.req("POST", "/api/auth/login", { username: "mem", password: "password2" })).status, 403);
});
