// 개인정보: consent at sign-up, the /privacy page, confirming the policy, deletion requests, 개인정보 정리 when an
// account is deleted, retention of the audit log and of 사비 originals, and fonts served from this server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer, Client, member } from "./helpers/server.js";
import { statementXlsx } from "./helpers/xlsx.js";

let srv, dev, a, b;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const ITEM = { team: "에어로", date: 46300, cat: "프레임&바디", purpose: "리어 윙 제작", product: "카본 프리프레그", vendor: "https://smartstore.naver.com/carbon", price: 50000, qty: 2 };
const FILE_NAME = "개인사비사용내역서_에이_20261015.xlsx";
const uploadStatement = async (c) => (await c.post("/api/assets", Buffer.from(statementXlsx({ items: [ITEM] }).buffer.toString("base64")), { "content-type": "text/plain" })).json.id;
const blob = (c, id) => fetch(srv.base + "/_blob/" + id, { headers: { cookie: c.cookie } }).then((r) => r.status);

before(async () => {
  srv = await startServer();
  dev = new Client(srv.base);
  await dev.post("/api/auth/signup", { username: "dev", password: "password1", name: "개발자", agree: true });
  dev.id = (await dev.get("/api/me")).json.id;
  a = await member(srv.base, dev, "aaa", "에이", { dept: "chassis" });
  b = await member(srv.base, dev, "bbb", "비", { dept: "aero" });
});
after(() => srv.stop());

test("sign-up needs consent and records which policy was confirmed", async () => {
  const c = new Client(srv.base);
  const no = await c.post("/api/auth/signup", { username: "noagree", password: "password-x", name: "동의안함", dept: "aero" });
  assert.equal(no.status, 400); assert.match(no.json.message, /개인정보/);
  const me = (await a.get("/api/me")).json;
  assert.match(me.privacyAck, /^\d{4}-\d{2}-\d{2}$/);
  const page = await a.get("/");
  assert.ok(page.text.includes(`window.__FSK_PRIVACY="${me.privacyAck}"`), "the page knows the current version");
  const audit = (await dev.get("/api/admin/audit?action=signup")).json.entries;
  assert.ok(audit.some((e) => e.target === "aaa" && e.detail.includes("동의")));
});

test("accounts a developer made confirm the policy once from the page", async () => {
  const made = await dev.post("/api/admin/users", { username: "made", name: "만듦", dept: "aero" });
  const c = new Client(srv.base);
  await c.post("/api/auth/login", { username: "made", password: made.json.tempPassword });
  await c.post("/api/auth/password", { current: made.json.tempPassword, next: "password-made" });
  assert.equal((await c.get("/api/me")).json.privacyAck, "");
  const users = (await dev.get("/api/admin/users")).json;
  assert.equal(users.users.find((u) => u.username === "made").privacyAck, "", "the admin sees who has not confirmed");
  const r = await c.post("/api/me/privacy-ack", {});
  assert.equal(r.status, 200);
  assert.equal((await c.get("/api/me")).json.privacyAck, users.privacyVersion);
});

test("/privacy is public and shows this server's own retention settings", async () => {
  await dev.post("/api/admin/settings", { privacyContact: "개발자 <홍길동>", auditKeepDays: 200, expenseKeepYears: 4 });
  const r = await new Client(srv.base).get("/privacy");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /\{\{\w+\}\}/, "every placeholder is filled");
  assert.ok(r.text.includes("개발자 &lt;홍길동&gt;"), "the contact is escaped");
  assert.ok(r.text.includes("200일") && r.text.includes("제출일로부터 4년"));
  const nonce = r.headers.get("content-security-policy").match(/'nonce-([^']+)'/)[1];
  assert.ok(r.text.match(/<script\b[^>]*>/g).every((t) => t.includes(`nonce="${nonce}"`)));
  const bad = await dev.post("/api/admin/settings", { auditKeepDays: 5 });
  assert.equal(bad.status, 400);
  const login = await new Client(srv.base).get("/login");
  assert.ok(login.text.includes('id="sAgree"') && login.text.includes('href="/privacy"'));
});

test("fonts come from this server, not Google", async () => {
  for (const [c, path] of [[a, "/"], [new Client(srv.base), "/login"], [dev, "/admin"], [new Client(srv.base), "/privacy"]]) {
    const r = await c.get(path);
    assert.equal(r.status, 200, path);
    assert.doesNotMatch(r.text, /fonts\.(googleapis|gstatic)\.com/, path);
    assert.ok(r.text.includes('href="/fonts/fonts.css"'), path);
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /font-src 'self'/); assert.doesNotMatch(csp, /google/);
  }
  const css = await fetch(srv.base + "/fonts/fonts.css");
  assert.equal(css.status, 200); assert.match(css.headers.get("content-type"), /text\/css/);
  const files = [...(await css.text()).matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(files.length > 100, "Korean comes in unicode-range pieces");
  for (const f of [files[0], files.at(-1)]) {
    const r = await fetch(srv.base + f);
    assert.equal(r.status, 200, f); assert.equal(r.headers.get("content-type"), "font/woff2");
  }
  assert.equal((await fetch(srv.base + "/fonts/OFL.txt")).status, 200, "the font license is served with the fonts");
  assert.equal((await fetch(srv.base + "/fonts/..%2Fserver.js")).status, 404);
  assert.equal((await fetch(srv.base + "/fonts/nope.woff2")).status, 404);
});

test("a member asks for deletion; developers are told and can see it", async () => {
  const r = await b.post("/api/me/delete-request", { note: "졸업해요" });
  assert.equal(r.status, 200); assert.ok(r.json.requestedAt);
  assert.equal((await b.post("/api/me/delete-request", {})).json.requestedAt, r.json.requestedAt, "asking twice keeps the first time");
  const notes = (await dev.get("/api/notifications")).json.items.filter((n) => n.kind === "privacy");
  assert.equal(notes.length, 1); assert.match(notes[0].body, /비 \(bbb\) · 졸업해요/);
  assert.ok((await dev.get("/api/admin/users")).json.users.find((u) => u.id === b.id).deleteRequestedAt);
  assert.deepEqual((await dev.get("/api/admin/status")).json.privacy.deleteRequests.map((x) => x.name), ["비"]);
  assert.equal((await b.post("/api/me/delete-request", { cancel: true })).json.requestedAt, null);
  assert.equal((await b.get("/api/me/delete-request")).json.requestedAt, null);
  assert.equal((await new Client(srv.base).get("/api/me/delete-request")).status, 401, "only for a signed-in account");
});

test("deleting an account with 개인정보 정리 removes files, names and IP addresses", async () => {
  const fileAsset = await uploadStatement(a);
  const receipt = (await a.post("/api/assets", PNG, { "content-type": "image/png" })).json.id;
  const sub = { id: "s1", applicant: "에이", by: "에이", fileName: FILE_NAME, fileAsset, receipts: [{ asset: receipt, slot: 1, type: "image/png" }], submittedAt: new Date().toISOString() };
  assert.equal((await a.post("/api/db/set", { path: `expenses/${a.id}`, data: { subs: { s1: sub } } })).status, 200);
  await a.post("/api/db/set", { path: "comments/c1", data: { log: "l1", by: "에이", text: "좋아요" } });
  await a.post("/api/db/set", { path: "parts/p1", data: { name: "업라이트", owner: "에이", ownerUid: a.id } });
  await b.post("/api/db/set", { path: "comments/c2", data: { log: "l1", by: "비", text: "확인" } });
  await a.post("/api/db/set", { path: "history/h1", data: { at: new Date().toISOString(), kind: "part", text: "부품 추가" } });
  assert.equal(await blob(dev, fileAsset), 200);

  const r = await dev.req("DELETE", `/api/admin/users/${a.id}?purge=1`);
  assert.equal(r.status, 200); assert.equal(r.json.purged.files, 2);
  assert.equal(await blob(dev, fileAsset), 404, "the original with the bank account is gone");
  assert.equal(await blob(dev, receipt), 404, "so is the receipt photo");
  const s1 = (await dev.get(`/api/admin/doc?path=expenses/${a.id}`)).json.data.subs.s1;
  assert.equal(s1.fileAsset, ""); assert.deepEqual(s1.receipts, []); assert.equal(s1.accountMasked, ""); assert.equal(s1.fileName, "");
  assert.equal(s1.applicant, "탈퇴한 팀원"); assert.equal(s1.by, "탈퇴한 팀원");
  assert.equal(s1.total, 100000, "amounts stay for the team's ledger"); assert.ok(s1.filesPurgedAt);
  assert.equal((await dev.get("/api/admin/doc?path=comments/c1")).json.data.by, "탈퇴한 팀원");
  assert.equal((await dev.get("/api/admin/doc?path=comments/c2")).json.data.by, "비", "other people's names stay");
  const part = (await dev.get("/api/admin/doc?path=parts/p1")).json.data;
  assert.equal(part.owner, "탈퇴한 팀원"); assert.equal(part.name, "업라이트");
  assert.equal((await dev.get("/api/admin/doc?path=history/h1")).json.data.by, "탈퇴한 팀원");
  assert.equal((await dev.get(`/api/admin/doc?path=people/${a.id}`)).status, 404);
  const rows = (await dev.get(`/api/admin/audit?actor=${a.id}`)).json.entries;
  assert.ok(rows.length && rows.every((e) => e.ip === null && e.actor_name === "탈퇴한 팀원"));
  assert.match((await dev.get("/api/admin/audit?action=user.delete")).json.entries[0].detail, /개인정보 정리/);
});

test("사비 originals past the retention period are cleaned up, amounts stay", async () => {
  await dev.post("/api/admin/settings", { expenseKeepYears: 1 });
  const fileAsset = await uploadStatement(b);
  const old = { id: "old1", applicant: "비", by: "비", fileName: FILE_NAME, fileAsset, receipts: [], submittedAt: "2020-03-01T00:00:00.000Z" };
  const fresh = { id: "new1", applicant: "비", by: "비", fileName: FILE_NAME, fileAsset: await uploadStatement(b), receipts: [], submittedAt: new Date().toISOString() };
  assert.equal((await b.post("/api/db/set", { path: `expenses/${b.id}`, data: { subs: { old1: old, new1: fresh } } })).status, 200);
  assert.equal((await dev.get("/api/admin/status")).json.privacy.expiredExpenses, 1);
  const r = await dev.post("/api/admin/expenses/purge-expired", {});
  assert.deepEqual(r.json, { entries: 1, files: 1 });
  const subs = (await dev.get(`/api/admin/doc?path=expenses/${b.id}`)).json.data.subs;
  assert.equal(subs.old1.fileAsset, ""); assert.equal(subs.old1.total, 100000); assert.equal(subs.old1.applicant, "비");
  assert.equal(subs.new1.fileAsset, fresh.fileAsset, "newer entries are kept");
  assert.equal((await dev.get("/api/admin/status")).json.privacy.expiredExpenses, 0);
  assert.equal(await blob(b, fileAsset), 404);
});

test("audit log entries older than the retention period are removed", async () => {
  const db = new DatabaseSync(join(srv.dataDir, "fsk.db"));
  db.prepare("INSERT INTO audit (at, actor, action, ip) VALUES (?, ?, ?, ?)").run("2020-01-01T00:00:00.000Z", null, "login.fail", "10.0.0.1");
  db.close();
  const has = async () => (await dev.get("/api/admin/audit?action=login.fail&limit=1000")).json.entries.some((e) => e.ip === "10.0.0.1");
  assert.ok(await has());
  await dev.post("/api/admin/settings", { auditKeepDays: 365 });
  assert.ok(!(await has()), "saving the setting applies it right away; the server also prunes every 10 minutes");
});
