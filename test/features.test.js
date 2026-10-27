// End-to-end API tests for 사비 정산 locking and file privacy, notifications (in-app and team webhook),
// full backups, off-site copy, claude.ai migration, and security hardening. Starts its own server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { startServer, Client, member, dayOffset, ROOT } from "./helpers/server.js";
import { readTarGz } from "../server/archive.js";
import { statementXlsx } from "./helpers/xlsx.js";

let srv, hook, hookPort, dev, vice, a, b;
const hooks = [];
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); } };
const notes = async (c) => (await c.get("/api/notifications")).json;

before(async () => {
  hook = http.createServer((req, res) => { let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => { hooks.push({ url: req.url, body: JSON.parse(body || "{}") }); res.end("ok"); }); });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  hookPort = hook.address().port;
  srv = await startServer({ WEBHOOK_HOSTS: "127.0.0.1" });
  dev = new Client(srv.base);
  await dev.post("/api/auth/signup", { username: "dev", password: "password1", name: "개발자" });
  dev.id = (await dev.get("/api/me")).json.id;
  vice = await member(srv.base, dev, "vice", "총무", { position: "vice_lead", dept: "battery" });
  a = await member(srv.base, dev, "aaa", "에이", { dept: "chassis" });
  b = await member(srv.base, dev, "bbb", "비", { position: "part_lead", dept: "aero" });
});
after(() => { srv.stop(); hook.close(); });

let fileAsset, receiptAsset, partAsset;
const ITEM = { team: "에어로", date: 46300, cat: "프레임&바디", purpose: "리어 윙 제작", product: "카본 프리프레그", vendor: "https://smartstore.naver.com/carbon", price: 50000, qty: 2 };
const FILE_NAME = "개인사비사용내역서_에이_20261015.xlsx";
// The page stores the original base64-wrapped as text/plain.
const uploadStatement = async (c, opts = { items: [ITEM] }) => (await c.post("/api/assets", Buffer.from(statementXlsx(opts).buffer.toString("base64")), { "content-type": "text/plain" })).json.id;
test("submitted 사비 entries are locked for the submitter", async () => {
  fileAsset = await uploadStatement(a);
  receiptAsset = (await a.post("/api/assets", PNG, { "content-type": "image/png" })).json.id;
  const s1 = { id: "s1", applicant: "에이", by: "에이", fileName: FILE_NAME, total: 100000, fileAsset, receipts: [{ asset: receiptAsset, slot: 1, type: "image/png" }], check: { level: "ok" }, items: [] };
  assert.equal((await a.post("/api/db/set", { path: `expenses/${a.id}`, data: { subs: { s1 } } })).status, 200);
  const changed = await a.post("/api/db/update", { path: `expenses/${a.id}`, data: { subs: { s1: { total: 900000 } } } });
  assert.equal(changed.status, 403); assert.equal(changed.json.code, "locked");
  assert.equal((await a.post("/api/db/set", { path: `expenses/${a.id}`, data: { subs: {} } })).status, 403, "cannot drop a submitted entry");
  assert.equal((await a.post("/api/db/delete", { path: `expenses/${a.id}` })).status, 403, "cannot delete the whole document");
  const s2 = { id: "s2", applicant: "에이", fileName: FILE_NAME, total: 5000, fileAsset: await uploadStatement(a, { items: [{ ...ITEM, price: 2500 }] }), receipts: [], check: { level: "warn" } };
  assert.equal((await a.post("/api/db/update", { path: `expenses/${a.id}`, data: { subs: { s2 }, updatedAt: "x" } })).status, 200, "adding a new entry is fine");
  assert.equal((await dev.post("/api/db/update", { path: `expenses/${a.id}`, data: { subs: { s2: { note: "개발자 수정" } } } })).status, 200, "developers keep full control");
});

test("the server checks each submitted 사비 file again and stores its own result", async () => {
  const subs = (await a.get(`/api/db/doc?path=expenses/${a.id}`)).json.data.subs;
  assert.equal(subs.s1.total, 100000); assert.equal(subs.s1.items.length, 1, "items come from the file, not the request");
  assert.equal(subs.s1.items[0].product, "카본 프리프레그"); assert.deepEqual(subs.s1.teams, ["에어로"]);
  assert.equal(subs.s1.check.level, "ok"); assert.equal(subs.s1.accountMasked, "신한 ••••••••6789");
  assert.match(subs.s1.hash, /^[0-9a-f]{64}$/); assert.equal(subs.s1.applicant, "에이", "what the submitter typed is kept");
  assert.equal(subs.s2.check.level, "ok", "a client-side 'warn' is replaced by the server's reading");

  // a forged request cannot pass off a 양식 불일치 file or a made-up total
  const bad = { id: "s3", applicant: "에이", fileName: FILE_NAME, total: 1000, fileAsset: await uploadStatement(a, { items: [{ ...ITEM, team: "없는팀" }] }), receipts: [], check: { level: "ok" }, items: [] };
  const refused = await a.post("/api/db/update", { path: `expenses/${a.id}`, data: { subs: { s3: bad } } });
  assert.equal(refused.status, 422); assert.equal(refused.json.code, "forbidden"); assert.match(refused.json.message, /양식에 맞지 않아요.*없는팀/);
  const junk = { ...bad, id: "s4", fileAsset: (await a.post("/api/assets", Buffer.from("UEsDBA=="), { "content-type": "text/plain" })).json.id };
  assert.match((await a.post("/api/db/update", { path: `expenses/${a.id}`, data: { subs: { s4: junk } } })).json.message, /xlsx 파일을 열 수 없어요/);
  assert.equal((await a.post("/api/db/update", { path: `expenses/${a.id}`, data: { subs: { s5: { ...bad, id: "s5", fileAsset: undefined } } } })).status, 403, "a submission needs its original");
  assert.equal((await a.get(`/api/db/doc?path=expenses/${a.id}`)).json.data.subs.s3, undefined);

  // 총무 may still register a 양식 불일치 file; it is stored with the server's findings
  const forVice = { ...bad, id: "v1", fileAsset: await uploadStatement(vice, { items: [{ ...ITEM, team: "없는팀" }] }) };
  assert.equal((await vice.post("/api/db/set", { path: `expenses/${vice.id}`, data: { subs: { v1: forVice } } })).status, 200);
  const v1 = (await vice.get(`/api/db/doc?path=expenses/${vice.id}`)).json.data.subs.v1;
  assert.equal(v1.check.level, "bad"); assert.ok(v1.check.errors.some((e) => /없는팀/.test(e)));

  // a 수정본 in a review is checked too, but only when it changes (the page resends it with every review)
  const replacement = await uploadStatement(vice, { items: [ITEM, { ...ITEM, product: "에폭시", price: 30000, qty: 1 }] });
  const override = { fileName: FILE_NAME, fileAsset: replacement, receipts: [], items: [], total: 1, check: { level: "ok" }, replacedBy: "총무" };
  assert.equal((await vice.post("/api/db/set", { path: `reviews/${vice.id}`, data: { items: { [`${vice.id}:v1`]: { status: "pending", override } } } })).status, 200);
  const stored = (await vice.get(`/api/db/doc?path=reviews/${vice.id}`)).json.data.items[`${vice.id}:v1`].override;
  assert.equal(stored.total, 130000); assert.equal(stored.items.length, 2); assert.equal(stored.replacedBy, "총무");
  assert.equal((await vice.post("/api/db/update", { path: `reviews/${vice.id}`, data: { items: { [`${vice.id}:v1`]: { status: "approved", override: stored } } } })).status, 200);
  const stolen = await b.post("/api/db/set", { path: `reviews/${b.id}`, data: { items: { x: { override: { ...override, fileAsset } } } } });
  assert.equal(stolen.status, 403, "a 수정본 must be the reviewer's own upload");
});

test("a submission id named like an Object property cannot skip the lock or the file check", async () => {
  // b already has an expenses document, so "constructor" would have looked like an existing entry
  assert.equal((await b.post("/api/db/set", { path: `expenses/${b.id}`, data: { subs: {} } })).status, 200);
  for (const id of ["constructor", "toString", "__proto__", "a b", "x".repeat(65)]) {
    const r = await b.post("/api/db/update", { path: `expenses/${b.id}`, data: { subs: { [id]: { id, fileAsset, total: 99999999, check: { level: "ok" }, receipts: [] } } } });
    assert.notEqual(r.status, 200, `id ${JSON.stringify(id)} is refused`);
  }
  const blob = await fetch(srv.base + "/_blob/" + fileAsset, { headers: { cookie: b.cookie } });
  assert.equal(blob.status, 403, "b still cannot open a's original");
});

test("사비 files are private to the submitter, 총무 and developers", async () => {
  const blob = (c, id) => fetch(srv.base + "/_blob/" + id, { headers: { cookie: c.cookie } }).then((r) => r.status);
  assert.equal(await blob(b, fileAsset), 403, "another member cannot open the original");
  assert.equal(await blob(b, receiptAsset), 403, "another member cannot open the receipt photo");
  assert.equal(await blob(a, fileAsset), 200);
  assert.equal(await blob(vice, receiptAsset), 200, "총무 can");
  assert.equal(await blob(dev, fileAsset), 200, "developer can");
  partAsset = (await b.post("/api/assets", PNG, { "content-type": "image/png" })).json.id;
  await b.post("/api/db/set", { path: "parts/p0", data: { name: "업라이트", attachments: [{ id: partAsset }] } });
  assert.equal(await blob(a, partAsset), 200, "ordinary attachments stay open to the team");
  const steal = await b.post("/api/db/set", { path: `expenses/${b.id}`, data: { subs: { x: { id: "x", total: 1, fileAsset, receipts: [] } } } });
  assert.equal(steal.status, 403, "cannot list someone else's file in my own submission to get at it");
});

test("총무 decisions notify the submitter, live, and are audited", async () => {
  assert.ok((await notes(vice)).items.some((n) => n.title === "새 사비 내역서" && n.link.exp === `${a.id}:s1`), "총무 hears about new submissions");
  const ctrl = new AbortController(), res = await fetch(srv.base + "/api/stream", { headers: { cookie: a.cookie }, signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = "";
  const got = (async () => { while (!buf.includes("event: notify")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); } return buf; })();
  await new Promise((r) => setTimeout(r, 100));
  const entry = { status: "approved", note: "", paidAt: "", paidAmount: null, fp: "", by: "총무", at: new Date().toISOString(), log: [] };
  assert.equal((await vice.post("/api/db/set", { path: `reviews/${vice.id}`, data: { items: { [`${a.id}:s1`]: entry } } })).status, 200);
  const text = await Promise.race([got, new Promise((r) => setTimeout(() => r("timeout"), 3000))]);
  ctrl.abort();
  assert.match(text, /사비 정산 승인/);
  await vice.post("/api/db/update", { path: `reviews/${vice.id}`, data: { items: { [`${a.id}:s1`]: { status: "paid", paidAmount: 100000, paidAt: "2026-10-10" } } } });
  const mine = await notes(a);
  assert.equal(mine.items[0].title, "사비 정산 지급 완료"); assert.match(mine.items[0].body, /지급액 100,000원/);
  assert.equal(mine.unread, 2);
  // a member writing a "review" in their own reviews doc is ignored
  await b.post("/api/db/set", { path: `reviews/${b.id}`, data: { items: { [`${a.id}:s1`]: { ...entry, status: "rejected" } } } });
  assert.equal((await notes(a)).unread, 2);
  assert.equal((await a.post("/api/notifications/read", { all: true })).json.unread, 0);
  const audit = (await dev.get("/api/admin/audit?action=expense.")).json.entries;
  assert.ok(audit.some((e) => e.action === "expense.review" && /승인 · 지급 대기 → 지급 완료/.test(e.detail)));
  assert.ok(!audit.some((e) => /반려/.test(e.detail)), "untrusted reviews are not audited as decisions");
});

test("comments notify the log's author and earlier commenters", async () => {
  await a.post("/api/db/set", { path: "sessions/s1", data: { date: "2026-10-01", event: "오토크로스" } });
  await a.post("/api/db/set", { path: "logs/l1", data: { sessionId: "s1", dept: "chassis", status: "ok", author: "에이" } });
  await b.post("/api/db/set", { path: "comments/c1", data: { logId: "l1", sessionId: "s1", author: "비", text: "리어 캠버 확인 부탁" } });
  const n = (await notes(a)).items[0];
  assert.equal(n.title, "프레임·현가 기록에 새 의견"); assert.match(n.body, /리어 캠버/); assert.deepEqual(n.link, { tab: "sessions", sid: "s1" });
  assert.equal((await notes(b)).items.filter((x) => x.kind === "comment").length, 0, "no notification for your own comment");
  await a.post("/api/db/set", { path: "comments/c2", data: { logId: "l1", sessionId: "s1", author: "에이", text: "확인했어요" } });
  assert.equal((await notes(b)).items.filter((x) => x.kind === "comment").length, 1, "earlier commenters hear replies");
});

test("a status or department named like an Object property is not read as a real one", async () => {
  await a.post("/api/db/set", { path: "logs/l2", data: { sessionId: "s1", dept: "constructor", status: "ok", author: "에이" } });
  await b.post("/api/db/set", { path: "comments/c3", data: { logId: "l2", sessionId: "s1", author: "비", text: "확인" } });
  assert.equal((await notes(a)).items[0].title, "기록에 새 의견", "no built-in function text in the title");
  await vice.post("/api/db/update", { path: `reviews/${vice.id}`, data: { items: { [`${vice.id}:v1`]: { status: "approved" } } } });
  await vice.post("/api/db/update", { path: `reviews/${vice.id}`, data: { items: { [`${vice.id}:v1`]: { status: "constructor" } } } });
  const audit = (await dev.get("/api/admin/audit?action=expense.")).json.entries;
  assert.ok(audit.some((e) => e.action === "expense.review" && /승인 · 지급 대기 → 검토 대기/.test(e.detail)), "an unknown status counts as 검토 대기");
  assert.ok(!audit.some((e) => /native code|function/.test(e.detail)));
});

test("webhook addresses are checked", async () => {
  for (const url of ["http://discord.com/api/webhooks/1/x", "https://evil.example/hook", "https://user:pw@discord.com/api/webhooks/1/x", "not a url"])
    assert.equal((await dev.post("/api/admin/settings", { webhookUrl: url })).status, 400, url);
  assert.equal((await dev.post("/api/admin/settings", { webhookUrl: "https://discord.com/api/webhooks/1/abc" })).status, 200);
  assert.equal((await dev.get("/api/admin/status")).json.settings.webhookUrl, undefined, "the webhook secret is not in the status payload");
  assert.equal((await a.post("/api/admin/settings", { webhookUrl: "" })).status, 403);
  assert.equal((await dev.post("/api/admin/settings", { webhookUrl: `http://127.0.0.1:${hookPort}/hook`, webhookKinds: ["schedule", "parts", "issues"] })).status, 200, "hosts listed in WEBHOOK_HOSTS are allowed");
  const t = await dev.post("/api/admin/webhook-test", {});
  assert.equal(t.json.ok, true);
  assert.match(hooks.at(-1).body.content, /알림 테스트/);
});

test("deadlines and milestones remind the right people once", async () => {
  await dev.post("/api/db/set", { path: "parts/p1", data: { name: "프론트 업라이트", owner: "에이", dept: "chassis", stage: "machining", due: dayOffset(2) } });
  await dev.post("/api/db/set", { path: "parts/p2", data: { name: "리어 윙", owner: "외부 업체", dept: "aero", stage: "design", due: dayOffset(-1) } });
  await dev.post("/api/db/set", { path: "parts/p3", data: { name: "완료된 부품", owner: "에이", dept: "chassis", stage: "done", due: dayOffset(0) } });
  await dev.post("/api/db/set", { path: "parts/p4", data: { name: "BMS 하우징", owner: "예전 이름", ownerUid: vice.id, dept: "battery", stage: "design", due: dayOffset(1) } });
  await dev.post("/api/db/set", { path: "milestones/m1", data: { title: "설계 보고서 제출", date: dayOffset(7), kind: "서류 제출", dept: "" } });
  const first = (await dev.post("/api/admin/notify-run", {})).json;
  assert.ok(first.sent >= 6, `sent ${first.sent}`);
  const an = (await notes(a)).items;
  assert.ok(an.some((n) => n.title === "부품 마감 D-2" && n.link.part === "p1"), "the 담당 matched by name");
  assert.ok(!an.some((n) => /완료된 부품/.test(n.body)), "finished parts are skipped");
  assert.ok((await notes(vice)).items.some((n) => n.title === "부품 마감 D-1" && n.link.part === "p4"), "the 담당 picked by account, whatever name the part shows");
  assert.ok((await notes(b)).items.some((n) => n.title === "마감 지난 부품" && /리어 윙/.test(n.body)), "no account by that name: the department's 파트장");
  for (const c of [dev, vice, a, b]) assert.ok((await notes(c)).items.some((n) => n.title === "D-7 · 설계 보고서 제출"), "team-wide milestone");
  assert.equal((await dev.post("/api/admin/notify-run", {})).json.sent, 0, "each reminder fires once");
  const bodies = hooks.map((h) => h.body.content);
  assert.ok(bodies.some((t) => /D-7 · 설계 보고서 제출/.test(t)));
  assert.ok(bodies.some((t) => /마감 지난 부품 1개: 리어 윙/.test(t)));
  assert.ok(!bodies.some((t) => /사비|지급/.test(t)), "money matters never go to the team channel");
  await a.post("/api/db/set", { path: "logs/l2", data: { sessionId: "s1", dept: "aero", status: "bad", analysis: "윙 마운트 균열 @everyone" } });
  await waitFor(() => hooks.some((h) => /🔴 문제/.test(h.body.content)));
  const issue = hooks.find((h) => /🔴 문제/.test(h.body.content)).body.content;
  assert.match(issue, /윙 마운트 균열/); assert.doesNotMatch(issue, /@everyone/, "mentions in team text are defused");
});

test("locked parts are changed only by their department's 파트장, 팀장·부팀장 and developers", async () => {
  const part = { name: "리어 윙 엔드플레이트", dept: "aero", stage: "design" };
  assert.equal((await a.post("/api/db/set", { path: "parts/lk1", data: { ...part, locked: { uid: b.id, by: "비" } } })).status, 403, "a 팀원 cannot lock");
  assert.equal((await a.post("/api/db/set", { path: "parts/lk1", data: part })).status, 200);
  assert.equal((await b.post("/api/db/update", { path: "parts/lk1", data: { locked: { uid: "someone", by: "가짜", at: "2000-01-01T00:00:00Z" } } })).status, 200, "the aero 파트장 locks it");
  const locked = (await a.get("/api/db/doc?path=parts/lk1")).json.data.locked;
  assert.equal(locked.uid, b.id); assert.equal(locked.by, "비"); assert.notEqual(locked.at, "2000-01-01T00:00:00Z");
  for (const r of [await a.post("/api/db/update", { path: "parts/lk1", data: { stage: "order" } }), await a.post("/api/db/set", { path: "parts/lk1", data: part }), await a.post("/api/db/delete", { path: "parts/lk1" })]) {
    assert.equal(r.status, 403); assert.equal(r.json.code, "locked");
  }
  assert.equal((await b.post("/api/db/update", { path: "parts/lk1", data: { stage: "order", locked: { uid: a.id, by: "에이" } } })).status, 200);
  assert.equal((await a.get("/api/db/doc?path=parts/lk1")).json.data.locked.by, "비", "who locked it cannot be rewritten");
  assert.equal((await b.post("/api/db/update", { path: "parts/lk1", data: { dept: "chassis" } })).status, 403, "the aero 파트장 cannot move it to a department they don't manage");
  assert.equal((await vice.post("/api/db/update", { path: "parts/lk1", data: { dept: "chassis" } })).status, 200, "부팀장 manages every department");
  assert.equal((await b.post("/api/db/update", { path: "parts/lk1", data: { stage: "machining" } })).status, 403, "now it is chassis's");
  assert.equal((await vice.post("/api/db/update", { path: "parts/lk1", data: { locked: null } })).status, 200, "unlocked");
  assert.equal((await a.post("/api/db/update", { path: "parts/lk1", data: { stage: "machining" } })).status, 200, "anyone can change it again");
});

test("the page's people list follows the accounts", async () => {
  const people = (await a.post("/api/db/query", { collection: "people" })).json.docs;
  assert.ok(people.some((p) => p.id === dev.id && p.data.name === "개발자"), "the first account is listed");
  for (const c of [vice, a, b]) assert.ok(people.some((p) => p.id === c.id && p.data.name === c.name), `${c.name} is listed`);
  const tmp = await member(srv.base, dev, "ccc", "씨", { dept: "circuit" });
  assert.equal((await a.get(`/api/db/doc?path=people/${tmp.id}`)).json.data.dept, "circuit", "approved accounts are added");
  await dev.post(`/api/admin/users/${tmp.id}`, { status: "disabled" });
  assert.equal((await a.get(`/api/db/doc?path=people/${tmp.id}`)).json.data.active, false, "disabled accounts are marked, not listed as 담당 choices");
  await dev.req("DELETE", `/api/admin/users/${tmp.id}`);
});

test("full backup carries the attachment files and restores them", async () => {
  const r = await dev.get("/api/admin/backups-full");
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/gzip");
  const out = await readTarGz(Readable.from(r.buf), (name) => name === "backup.json" ? "json" : null);
  const json = JSON.parse(out.json.toString());
  assert.equal(json.format, "fsk-backup"); assert.ok(json.docs.some((d) => d.path === "parts/p0"));
  await dev.req("DELETE", `/api/admin/assets/${partAsset}`);
  assert.equal((await fetch(srv.base + "/_blob/" + partAsset, { headers: { cookie: dev.cookie } })).status, 404);
  const back = await dev.post("/api/admin/restore-full?mode=merge", r.buf, { "content-type": "application/gzip" });
  assert.equal(back.status, 200, back.text); assert.ok(back.json.files >= 1);
  assert.equal((await fetch(srv.base + "/_blob/" + partAsset, { headers: { cookie: a.cookie } })).status, 200);
  assert.equal((await dev.post("/api/admin/restore-full", Buffer.from("not a tarball"), { "content-type": "application/gzip" })).status, 400);
  writeFileSync(join(srv.dataDir, "full.tar.gz"), r.buf);
});

test("off-site copy only adds files and rejects unsafe folders", async () => {
  assert.equal((await dev.post("/api/admin/settings", { mirrorDir: "relative/path" })).status, 400);
  assert.equal((await dev.post("/api/admin/settings", { mirrorDir: join(srv.dataDir, "assets") })).status, 400, "inside the data folder");
  assert.equal((await dev.post("/api/admin/settings", { mirrorDir: "/definitely/not/here" })).status, 400);
  const dir = mkdtempSync(join(tmpdir(), "fsk-mirror-"));
  try {
    await dev.post("/api/admin/backups", { note: "mirror" });
    assert.equal((await dev.post("/api/admin/settings", { mirrorDir: dir })).status, 200);
    const r = (await dev.post("/api/admin/mirror", {})).json;
    assert.equal(r.ok, true, r.message); assert.ok(r.files >= 2);
    assert.ok(readdirSync(join(dir, "backups")).some((f) => f.endsWith(".json")));
    assert.ok(existsSync(join(dir, "assets", partAsset)));
    assert.match(readFileSync(join(dir, "LAST_COPY.txt"), "utf8"), /마지막 복사/);
    assert.equal((await dev.post("/api/admin/mirror", {})).json.files, 0, "nothing new the second time");
    assert.equal((await dev.get("/api/admin/status")).json.settings.mirrorLast.ok, true);
  } finally { await dev.post("/api/admin/settings", { mirrorDir: "" }); rmSync(dir, { recursive: true, force: true }); }
});

test("claude.ai export: find the accounts and move their records to server accounts", async () => {
  const exp = { docs: [
    { path: "people/user_old1", data: { name: "비", dept: "aero" } },
    { path: "expenses/user_old1", data: { subs: { x1: { id: "x1", by: "비", applicant: "비", total: 3000 } } } },
    { path: "reviews/user_old2", data: { items: { "user_old1:x1": { status: "paid", by: "옛총무" } } } },
    { path: "history/h9", data: { uid: "user_old1", by: "비", targetId: "user_old1:x1", type: "expense" } },
    { path: "config/roles", data: { ownerUid: "user_old2", treasurers: ["user_old2"] } }
  ] };
  const an = (await dev.post("/api/admin/import/analyze", exp)).json;
  const old1 = an.ids.find((x) => x.id === "user_old1"), old2 = an.ids.find((x) => x.id === "user_old2");
  assert.equal(old1.name, "비"); assert.equal(old1.suggestion, b.id, "matched by name"); assert.equal(old1.subs, 1);
  assert.equal(old2.suggestion, "", "no account named 옛총무");
  assert.equal((await dev.post("/api/admin/import?mode=merge", { ...exp, idMap: { user_old1: "u_nobody" } })).status, 400, "unknown target account");
  const r = await dev.post("/api/admin/import?mode=merge", { ...exp, idMap: { user_old1: b.id } });
  assert.equal(r.status, 200); assert.equal(r.json.mapped, 1);
  assert.equal((await b.get(`/api/db/doc?path=expenses/${b.id}`)).json.data.subs.x1.total, 3000);
  const h = (await dev.get("/api/db/doc?path=history/h9")).json.data;
  assert.equal(h.uid, b.id); assert.equal(h.targetId, `${b.id}:x1`);
  assert.ok((await dev.get("/api/db/doc?path=reviews/user_old2")).json.data.items[`${b.id}:x1`]);
  assert.equal((await dev.get("/api/db/doc?path=people/user_old1")).json.exists, false);
  assert.equal((await dev.get("/api/db/doc?path=config/roles")).json.data.treasurers.includes(vice.id), true, "roles stay in step with the organization");
});

test("pages run scripts only by nonce; app files are served", async () => {
  const page = await a.get("/");
  const csp = page.headers.get("content-security-policy"), nonce = csp.match(/'nonce-([^']+)'/)[1];
  const scriptSrc = csp.split(";").find((p) => p.trim().startsWith("script-src"));
  assert.doesNotMatch(scriptSrc, /unsafe-inline|cdnjs/);
  const tags = page.text.match(/<script\b[^>]*>/g);
  assert.ok(tags.length >= 4 && tags.every((t) => t.includes(`nonce="${nonce}"`)), tags.join("\n"));
  assert.match(page.text, /src="\/vendor\/jszip\.min\.js" integrity="sha512-/);
  assert.match(page.text, /rel="manifest"/);
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
  const login = await new Client(srv.base).get("/login");
  assert.match(login.headers.get("content-security-policy"), /'nonce-/);
  assert.ok(login.text.includes('const DEPT = {"battery":"배터리"') && !login.text.includes("/*DEPARTMENTS*/"), "the server fills in the department list");
  const sw = await fetch(srv.base + "/sw.js");
  assert.equal(sw.status, 200); assert.equal(sw.headers.get("service-worker-allowed"), "/");
  assert.equal((await (await fetch(srv.base + "/manifest.webmanifest")).json()).start_url, "/");
  assert.equal((await fetch(srv.base + "/icons/icon-192.png")).headers.get("content-type"), "image/png");
  assert.equal((await fetch(srv.base + "/icons/..%2Fsw.js")).status, 404);
  const jszip = await fetch(srv.base + "/vendor/jszip.min.js");
  assert.equal(jszip.status, 200); assert.match(await jszip.text(), /JSZip v3\.10\.1/);
});

test("bad query input is a 400, not a server error", async () => {
  assert.equal((await a.post("/api/db/query", { collection: "parts", where: "x" })).status, 400);
  assert.equal((await a.post("/api/db/query", { collection: "parts", where: [["a", "=="]] })).status, 400);
  assert.equal((await a.post("/api/db/set", { path: "parts/z", data: [1, 2] })).status, 400);
  const odd = await a.post("/api/assets", PNG, { "content-type": "image/png", "x-file-name": "%E0%A4%A" });
  assert.equal(odd.status, 200, "a malformed file name header is kept as typed");
});

test("uploads must contain what their type says", async () => {
  const up = (type, body, name = "") => a.post("/api/assets", Buffer.from(body), { "content-type": type, "x-file-name": encodeURIComponent(name) });
  const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), Buffer.alloc(64)]);
  for (const [type, body, why] of [
    ["application/pdf", exe, "an .exe renamed to .pdf"], ["image/png", "<html><script>alert(1)</script>", "HTML posing as a PNG"],
    ["image/jpeg", "GIF89a....", "a GIF labelled JPEG"], ["text/plain", exe, "an .exe renamed to .txt"],
    ["text/csv", Buffer.from("504b0304140000", "hex"), "a zip renamed to .csv"], ["image/svg+xml", "<html><body>no svg</body></html>", "not an SVG"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK", "a truncated xlsx"]
  ]) {
    const r = await up(type, body);
    assert.equal(r.status, 415, why); assert.match(r.json.message, /파일 내용이 확장자와 맞지 않아요/);
  }
  for (const [type, body] of [["application/pdf", "%PDF-1.7\n..."], ["text/csv", "이름,금액\nMZ세대,1000\n"], ["text/plain", Buffer.from([0xff, 0xfe, 0x41, 0x00])], ["image/svg+xml", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'], ["image/gif", "GIF89a\x01\x00"]])
    assert.equal((await up(type, body)).status, 200, type);
  const named = await up("image/png", PNG, "invoice\u202Egnp.exe");
  const row = (await dev.get("/api/admin/assets")).json.assets.find((x) => x.id === named.json.id);
  assert.equal(row.name, "invoicegnp.exe", "right-to-left override characters are stripped from stored names");
});

test("CLI restore keeps 직책 and brings back attachment files", () => {
  const target = mkdtempSync(join(tmpdir(), "fsk-cli-"));
  try {
    const run = (...args) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "server/cli.js"), ...args], { env: { ...process.env, DATA_DIR: target }, encoding: "utf8" });
    const r = run("restore", join(srv.dataDir, "full.tar.gz"));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /첨부 파일 \d+개/);
    const db = new DatabaseSync(join(target, "fsk.db"));
    assert.equal(db.prepare("SELECT position FROM users WHERE username = 'vice'").get().position, "vice_lead");
    assert.equal(db.prepare("SELECT position, dept FROM users WHERE username = 'bbb'").get().dept, "aero");
    db.close();
    assert.ok(existsSync(join(target, "assets", partAsset)));
    assert.notEqual(run("restore", join(srv.dataDir, "full.tar.gz")).status, 0, "refuses to overwrite without --force");
    const nodept = run("create-user", "clinew", "member", "새팀원");
    assert.notEqual(nodept.status, 0); assert.match(nodept.stderr, /부서/, "a 팀원 needs a department here too");
    assert.equal(run("create-user", "clinew", "member", "새팀원", "aero").status, 0);
    assert.equal(run("create-user", "clidev", "developer", "새개발자").status, 0, "developers may skip it");
  } finally { rmSync(target, { recursive: true, force: true }); }
});

test("login and sign-up are rate limited", async () => {
  const x = new Client(srv.base);
  for (let i = 0; i < 10; i++) assert.equal((await x.post("/api/auth/login", { username: "nobody", password: "wrong-password" })).status, 401);
  const blocked = await x.post("/api/auth/login", { username: "dev", password: "password1" });
  assert.equal(blocked.status, 429, "even the right password waits once the address is blocked");
  let last;
  for (let i = 0; i < 12; i++) { last = await x.post("/api/auth/signup", { username: `flood${i}`, password: "password-x", name: "flood", dept: "aero" }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
});

test("behind a tunnel the address comes from the tunnel's own X-Forwarded-For entry", async () => {
  const s = await startServer({ TRUST_PROXY: "1" });
  try {
    const x = new Client(s.base);
    // the visitor forges CF-Connecting-IP and an earlier X-Forwarded-For entry; the tunnel adds 203.0.113.7 last
    for (let i = 0; i < 10; i++) {
      const r = await x.post("/api/auth/login", { username: "nobody", password: "wrong-password" }, { "cf-connecting-ip": `198.51.100.${i}`, "x-forwarded-for": `192.0.2.${i}, 203.0.113.7` });
      assert.equal(r.status, 401);
    }
    const blocked = await x.post("/api/auth/login", { username: "nobody", password: "wrong-password" }, { "cf-connecting-ip": "198.51.100.99", "x-forwarded-for": "192.0.2.99, 203.0.113.7" });
    assert.equal(blocked.status, 429, "changing the forgeable headers does not reset the limit");
    const other = await x.post("/api/auth/login", { username: "nobody", password: "wrong-password" }, { "x-forwarded-for": "203.0.113.8" });
    assert.equal(other.status, 401, "another visitor is not blocked");
  } finally { s.stop(); }
});
