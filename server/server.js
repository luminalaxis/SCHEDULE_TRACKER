// FSK 피트보드 self-hosted server: one Node process, no npm dependencies (Node 22.13+).
// Serves the same index.html as the claude.ai Artifact, plus a runtime shim (public/fsk-runtime.js)
// that implements window.claude.use("db" | "user" | "assets" | "downloads") against this server.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, statfsSync, createReadStream, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { openStore, createDocs, createRules, runQuery, splitPath, StoreError, ROLE_LEVEL } from "./store.js";
import { createAuth, checkPasswordRule, checkUsername, verifyPassword, tempPassword, ROLES, STATUSES, newId } from "./auth.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VERSION = "1.0.0";
const CONFIG = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "127.0.0.1",
  dataDir: process.env.DATA_DIR || join(ROOT, "data"),
  trustProxy: process.env.TRUST_PROXY === "1",
  cookieSecure: process.env.COOKIE_SECURE === "1"
};
const DEPTS = ["battery", "circuit", "chassis", "aero", "powertrain"];
const ASSET_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "video/mp4", "video/webm", "application/pdf",
  "text/csv", "text/markdown", "application/json", "text/plain", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
const MAX_ASSET = 20 * 1024 * 1024;

const db = openStore(CONFIG.dataDir);
const docs = createDocs(db);
const auth = createAuth(db);
const rules = createRules(JSON.parse(readFileSync(join(ROOT, "artifact.config.json"), "utf8")).capabilities.db.rules);
const startedAt = new Date();

// ---------- settings & audit ----------
const sGet = db.prepare("SELECT value FROM settings WHERE key = ?"), sSet = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
const DEFAULT_SETTINGS = { signupMode: "approval", inviteCode: "", autoBackup: true, backupHour: 4, backupKeep: 14 };
const setting = (k) => { const r = sGet.get(k); return r ? JSON.parse(r.value) : DEFAULT_SETTINGS[k]; };
const setSetting = (k, v) => sSet.run(k, JSON.stringify(v));
const allSettings = () => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, setting(k)]));
if (!setting("inviteCode")) setSetting("inviteCode", crypto.randomBytes(4).toString("hex"));

const auditIns = db.prepare("INSERT INTO audit (at, actor, actor_name, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)");
function audit(ctx, action, target = "", detail = "") {
  const u = ctx && ctx.user;
  auditIns.run(new Date().toISOString(), u ? u.id : null, u ? u.name : null, action, String(target || ""), typeof detail === "string" ? detail : JSON.stringify(detail), ctx ? ctx.ip : null);
}

// ---------- live updates (SSE) ----------
const clients = new Set();
function broadcast(path, doc) {
  const payload = `event: change\ndata: ${JSON.stringify({ path, collection: docs.collectionOf(path), op: doc ? "set" : "delete", doc: doc || null })}\n\n`;
  for (const c of clients) if (rules.canRead(c.user, path)) c.res.write(payload);
}
function dropStreams(userId) { for (const c of clients) if (c.user.id === userId) c.res.end(); }

// config/roles mirrors account roles so the page's treasurer logic keeps working unchanged.
function syncRoles() {
  const cur = docs.get("config/roles")?.data || {};
  const devs = auth.activeDevelopers();
  const treasurers = auth.list().filter((u) => u.status === "active" && u.role === "treasurer").map((u) => u.id);
  const data = { ownerUid: devs[0] || cur.ownerUid || "", treasurers: [...devs.slice(1), ...treasurers], allowMemberSubmit: cur.allowMemberSubmit !== false, updatedAt: new Date().toISOString() };
  broadcast("config/roles", docs.set("config/roles", data, "system"));
}
function applyRolesWrite(ctx, data) {
  const want = new Set(Array.isArray(data.treasurers) ? data.treasurers : []);
  for (const u of auth.list()) {
    if (u.role === "developer") continue;
    if (want.has(u.id) && u.role !== "treasurer" && u.status === "active") { auth.update(u.id, { role: "treasurer" }); dropStreams(u.id); audit(ctx, "role.change", u.username, "treasurer (사비 정산 권한 관리)"); }
    if (!want.has(u.id) && u.role === "treasurer") { auth.update(u.id, { role: "member" }); dropStreams(u.id); audit(ctx, "role.change", u.username, "member (사비 정산 권한 관리)"); }
  }
  syncRoles();
}

// ---------- backups ----------
const BACKUP_DIR = join(CONFIG.dataDir, "backups");
const backupName = (kind) => `fsk-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${kind}.json`;
function createBackup(kind, ctx, note = "") {
  const data = {
    format: "fsk-backup", version: 1, createdAt: new Date().toISOString(), createdBy: ctx?.user?.name || "system", note,
    docs: docs.all().map(({ path, data, version, updatedAt, updatedBy }) => ({ path, data, version, updatedAt, updatedBy })),
    users: db.prepare("SELECT * FROM users").all(),
    settings: allSettings(),
    assets: db.prepare("SELECT * FROM assets").all()
  };
  const name = backupName(kind), tmp = join(BACKUP_DIR, name + ".tmp");
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, join(BACKUP_DIR, name));
  audit(ctx, "backup.create", name, `${data.docs.length} docs`);
  return name;
}
function listBackups() {
  return readdirSync(BACKUP_DIR).filter((f) => /^fsk-[\w.-]+\.json$/.test(f)).map((f) => { const st = statSync(join(BACKUP_DIR, f)); return { name: f, bytes: st.size, createdAt: st.mtime.toISOString(), auto: f.endsWith("-auto.json") }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}
function pruneAutoBackups() {
  const keep = Math.max(1, Number(setting("backupKeep")) || 14);
  listBackups().filter((b) => b.auto).slice(keep).forEach((b) => unlinkSync(join(BACKUP_DIR, b.name)));
}
function autoBackupTick() {
  try {
    if (!setting("autoBackup")) return;
    const now = new Date(), today = now.toISOString().slice(0, 10).replace(/-/g, "");
    if (now.getHours() < Number(setting("backupHour"))) return;
    if (listBackups().some((b) => b.auto && b.name.startsWith(`fsk-${today}`))) return;
    createBackup("auto", null, "자동 백업");
    pruneAutoBackups();
  } catch (e) { console.error("auto backup failed", e); }
}
function parseImport(json) {
  const raw = Array.isArray(json) ? json : Array.isArray(json.docs) ? json.docs : null;
  if (!raw) throw new StoreError("invalid_argument", "docs 배열이 있는 백업 파일이 아니에요.");
  return raw.map((d) => ({ path: d.path || (d.collection && d.id ? `${d.collection}/${d.id}` : ""), data: d.data, version: d.version, updatedAt: d.updatedAt, updatedBy: d.updatedBy }));
}
function restoreDocs(ctx, rows, mode) {
  const safety = createBackup("pre-restore", ctx, `${mode} 전 자동 보관`);
  if (mode === "replace") docs.replaceAll(rows); else docs.mergeAll(rows);
  syncRoles();
  for (const c of clients) c.res.write("event: reload\ndata: {}\n\n");
  return safety;
}

// ---------- http helpers ----------
const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" };
const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json);
}
function sendHtml(res, html, status = 200) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PAGE_CSP });
  res.end(html);
}
const redirect = (res, to) => { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); };
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new StoreError("too_large", "요청이 너무 커요.", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  try { return buf.length ? JSON.parse(buf.toString("utf8")) : {}; } catch { throw new StoreError("invalid_argument", "JSON 형식이 아니에요."); }
}
const cookies = (req) => Object.fromEntries(String(req.headers.cookie || "").split(";").map((p) => p.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
const isHttps = (req) => CONFIG.cookieSecure || (CONFIG.trustProxy && req.headers["x-forwarded-proto"] === "https");
const clientIp = (req) => (CONFIG.trustProxy && (req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim())) || req.socket.remoteAddress;
function setSessionCookie(req, res, token, maxAge) {
  res.setHeader("Set-Cookie", `fsk_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`);
}
const clearSessionCookie = (req, res) => res.setHeader("Set-Cookie", `fsk_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${isHttps(req) ? "; Secure" : ""}`);

const fails = new Map();
function loginBlocked(ip) { const f = fails.get(ip); return f && f.count >= 10 && Date.now() - f.first < 15 * 60000; }
function loginFailed(ip) { const f = fails.get(ip); if (!f || Date.now() - f.first > 15 * 60000) fails.set(ip, { count: 1, first: Date.now() }); else f.count++; }

// ---------- page ----------
let pageCache = { mtime: 0, html: "" };
function pageSource() {
  const p = join(ROOT, "index.html"), m = statSync(p).mtimeMs;
  if (m !== pageCache.mtime) pageCache = { mtime: m, html: readFileSync(p, "utf8") };
  return pageCache.html;
}
const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
function renderPage(user) {
  const me = { ...auth.publicUser(user), level: ROLE_LEVEL[user.role] || 0 };
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
    + `<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font-size:14px;font-family:system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>`
    + `<script>window.__FSK_ME=${safeJson(me)};</script><script src="/fsk-runtime.js"></script></head><body>\n${pageSource()}\n</body></html>`;
}
const staticFile = (name) => readFileSync(join(HERE, "public", name));

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler, auth: opts.auth || "user" });
const assertWrite = (ctx, path) => { if (!rules.canWrite(ctx.user, path)) throw new StoreError("invalid_argument", "이 경로에 쓸 권한이 없어요.", 403); };
const level = (u) => ROLE_LEVEL[u.role] || 0;

// pages
route("GET", "/", (ctx) => {
  if (!ctx.user) return redirect(ctx.res, "/login");
  if (ctx.user.must_change_pw) return redirect(ctx.res, "/login?change=1");
  sendHtml(ctx.res, renderPage(ctx.user));
}, { auth: "none" });
route("GET", "/login", (ctx) => sendHtml(ctx.res, staticFile("login.html").toString()), { auth: "none" });
route("GET", "/admin", (ctx) => {
  if (!ctx.user) return redirect(ctx.res, "/login?next=/admin");
  if (ctx.user.role !== "developer") return redirect(ctx.res, "/");
  sendHtml(ctx.res, staticFile("admin.html").toString());
}, { auth: "none" });
route("GET", "/fsk-runtime.js", (ctx) => {
  ctx.res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
  ctx.res.end(staticFile("fsk-runtime.js"));
}, { auth: "none" });
route("GET", "/healthz", (ctx) => send(ctx.res, 200, { ok: true, version: VERSION }), { auth: "none" });

// auth
route("GET", "/api/auth/config", (ctx) => send(ctx.res, 200, { signupMode: setting("signupMode"), firstUser: auth.count() === 0, signedIn: !!ctx.user }), { auth: "none" });
route("POST", "/api/auth/login", async (ctx) => {
  if (loginBlocked(ctx.ip)) return send(ctx.res, 429, { code: "rate_limited", message: "로그인 시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요." });
  const { username, password } = await readJson(ctx.req);
  const u = auth.byUsername(String(username || "").trim().toLowerCase());
  if (!u || !verifyPassword(String(password || ""), u.pw_hash)) {
    loginFailed(ctx.ip); audit({ ip: ctx.ip }, "login.fail", String(username || "").slice(0, 40));
    return send(ctx.res, 401, { code: "bad_credentials", message: "아이디 또는 비밀번호가 맞지 않아요." });
  }
  if (u.status === "pending") return send(ctx.res, 403, { code: "pending", message: "가입 승인을 기다리고 있어요. 개발자에게 승인을 요청하세요." });
  if (u.status !== "active") return send(ctx.res, 403, { code: "disabled", message: "비활성화된 계정이에요. 개발자에게 문의하세요." });
  fails.delete(ctx.ip);
  const s = auth.startSession(u.id, ctx.ip, ctx.req.headers["user-agent"]);
  setSessionCookie(ctx.req, ctx.res, s.token, s.maxAge);
  audit({ user: u, ip: ctx.ip }, "login", u.username);
  send(ctx.res, 200, { user: auth.publicUser(u) });
}, { auth: "none" });
route("POST", "/api/auth/signup", async (ctx) => {
  const b = await readJson(ctx.req);
  const username = String(b.username || "").trim().toLowerCase(), name = String(b.name || "").trim(), dept = DEPTS.includes(b.dept) ? b.dept : "";
  const err = checkUsername(username) || checkPasswordRule(b.password) || (!name || name.length > 20 ? "이름을 1~20자로 적어 주세요." : null);
  if (err) return send(ctx.res, 400, { code: "invalid_argument", message: err });
  if (auth.byUsername(username)) return send(ctx.res, 409, { code: "taken", message: "이미 쓰고 있는 아이디예요." });
  const first = auth.count() === 0, mode = setting("signupMode");
  let role = "member", status = "pending";
  if (first) { role = "developer"; status = "active"; }
  else if (mode === "closed") return send(ctx.res, 403, { code: "closed", message: "지금은 가입을 받지 않아요. 개발자에게 계정을 만들어 달라고 요청하세요." });
  else if (mode === "invite") {
    if (String(b.invite || "").trim() !== setting("inviteCode")) return send(ctx.res, 403, { code: "bad_invite", message: "초대 코드가 맞지 않아요." });
    status = "active";
  }
  const u = auth.create({ username, name, dept, role, status, password: b.password });
  audit({ user: u, ip: ctx.ip }, "signup", username, `${role} · ${status}`);
  if (first) syncRoles();
  if (status === "active") { const s = auth.startSession(u.id, ctx.ip, ctx.req.headers["user-agent"]); setSessionCookie(ctx.req, ctx.res, s.token, s.maxAge); }
  send(ctx.res, 200, { status, role });
}, { auth: "none" });
route("POST", "/api/auth/logout", (ctx) => {
  auth.endSession(cookies(ctx.req).fsk_session); clearSessionCookie(ctx.req, ctx.res);
  if (ctx.user) audit(ctx, "logout", ctx.user.username);
  send(ctx.res, 200, { ok: true });
}, { auth: "none" });
route("POST", "/api/auth/password", async (ctx) => {
  const b = await readJson(ctx.req);
  if (!verifyPassword(String(b.current || ""), ctx.user.pw_hash)) return send(ctx.res, 400, { code: "bad_credentials", message: "현재 비밀번호가 맞지 않아요." });
  const err = checkPasswordRule(b.next); if (err) return send(ctx.res, 400, { code: "invalid_argument", message: err });
  auth.setPassword(ctx.user.id, b.next, false);
  auth.endOtherSessions(ctx.user.id, ctx.user.tokenHash);
  audit(ctx, "password.change", ctx.user.username);
  send(ctx.res, 200, { ok: true });
}, { auth: "session" });

// me & people
route("GET", "/api/me", (ctx) => send(ctx.res, 200, { ...auth.publicUser(ctx.user), level: level(ctx.user) }));
route("POST", "/api/me/profile", async (ctx) => {
  const b = await readJson(ctx.req);
  const name = b.name === undefined ? ctx.user.name : String(b.name).trim(), dept = b.dept === undefined ? ctx.user.dept : (DEPTS.includes(b.dept) ? b.dept : "");
  if (!name || name.length > 20) return send(ctx.res, 400, { code: "invalid_argument", message: "이름을 1~20자로 적어 주세요." });
  auth.update(ctx.user.id, { name, dept });
  if (name !== ctx.user.name) audit(ctx, "profile.name", ctx.user.username, `${ctx.user.name} → ${name}`);
  send(ctx.res, 200, { ok: true });
});
route("GET", "/api/users/public", (ctx) => send(ctx.res, 200, { users: auth.list().filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, dept: u.dept, role: u.role })) }));

// db
route("GET", "/api/db/doc", (ctx) => {
  const path = ctx.url.searchParams.get("path"); splitPath(path, "doc");
  const d = rules.canRead(ctx.user, path) ? docs.get(path) : null;
  send(ctx.res, 200, d ? { exists: true, id: d.id, data: d.data, version: d.version } : { exists: false, id: path.split("/").pop() });
});
route("POST", "/api/db/query", async (ctx) => {
  const b = await readJson(ctx.req);
  const list = docs.list(b.collection).filter((d) => rules.canRead(ctx.user, d.path));
  send(ctx.res, 200, { docs: runQuery(list, b).map((d) => ({ id: d.id, path: d.path, data: d.data, version: d.version })) });
});
route("POST", "/api/db/set", async (ctx) => {
  const { path, data } = await readJson(ctx.req, 400 * 1024);
  splitPath(path, "doc"); assertWrite(ctx, path);
  const d = docs.set(path, data, ctx.user.id);
  broadcast(path, d);
  if (path === "config/roles") applyRolesWrite(ctx, data);
  send(ctx.res, 200, { ok: true, version: d.version });
});
route("POST", "/api/db/update", async (ctx) => {
  const { path, data } = await readJson(ctx.req, 400 * 1024);
  splitPath(path, "doc"); assertWrite(ctx, path);
  const d = docs.update(path, data, ctx.user.id);
  broadcast(path, d);
  if (path === "config/roles") applyRolesWrite(ctx, d.data);
  send(ctx.res, 200, { ok: true, version: d.version });
});
route("POST", "/api/db/delete", async (ctx) => {
  const { path } = await readJson(ctx.req);
  splitPath(path, "doc"); assertWrite(ctx, path);
  docs.remove(path); broadcast(path, null);
  send(ctx.res, 200, { ok: true });
});
route("GET", "/api/stream", (ctx) => {
  const { req, res, user } = ctx;
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n: connected\n\n");
  const client = { res, user };
  clients.add(client);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(client); });
});

// assets
const assetIns = db.prepare("INSERT INTO assets (id, content_type, size, uploader, name, created_at) VALUES (?, ?, ?, ?, ?, ?)");
const assetGet = db.prepare("SELECT * FROM assets WHERE id = ?"), assetDel = db.prepare("DELETE FROM assets WHERE id = ?");
const assetPath = (id) => join(CONFIG.dataDir, "assets", id);
const validAssetId = (id) => /^[a-f0-9]{32}$/.test(id);
route("POST", "/api/assets", async (ctx) => {
  if (level(ctx.user) < 2) return send(ctx.res, 403, { code: "not_granted", message: "파일을 올릴 권한이 없어요." });
  const type = String(ctx.req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!ASSET_TYPES.has(type)) return send(ctx.res, 415, { code: "unsupported_type", message: "지원하지 않는 파일 형식이에요." });
  const buf = await readBody(ctx.req, type === "image/svg+xml" ? 2 * 1024 * 1024 : MAX_ASSET);
  if (!buf.length) return send(ctx.res, 400, { code: "invalid_request", message: "빈 파일이에요." });
  const id = crypto.randomBytes(16).toString("hex");
  writeFileSync(assetPath(id), buf);
  assetIns.run(id, type, buf.length, ctx.user.id, decodeURIComponent(String(ctx.req.headers["x-file-name"] || "")).slice(0, 200), new Date().toISOString());
  send(ctx.res, 200, { id, url: `/_blob/${id}`, sizeBytes: buf.length, contentType: type });
});
route("GET", "/api/assets", (ctx) => {
  const all = db.prepare("SELECT * FROM assets ORDER BY created_at").all();
  const mine = ctx.user.role === "developer" ? all : all.filter((a) => a.uploader === ctx.user.id);
  send(ctx.res, 200, { assets: mine.map((a) => ({ id: a.id, url: `/_blob/${a.id}`, contentType: a.content_type, sizeBytes: a.size, createdAt: a.created_at })), usage: { files: all.length, bytes: all.reduce((s, a) => s + a.size, 0), maxFiles: 100000, maxBytes: 0 } });
});
route("DELETE", "/api/assets/:id", (ctx) => {
  const id = ctx.params.id; if (!validAssetId(id)) return send(ctx.res, 400, { code: "invalid_request", message: "bad id" });
  const a = assetGet.get(id); if (!a) return send(ctx.res, 200, { deleted: false });
  if (a.uploader !== ctx.user.id && ctx.user.role !== "developer") return send(ctx.res, 403, { code: "not_uploader", message: "올린 사람만 지울 수 있어요." });
  if (existsSync(assetPath(id))) unlinkSync(assetPath(id));
  assetDel.run(id);
  send(ctx.res, 200, { deleted: true });
});
route("GET", "/_blob/:id", (ctx) => {
  const id = ctx.params.id, a = validAssetId(id) && assetGet.get(id);
  if (!a || !existsSync(assetPath(id))) { ctx.res.writeHead(404, SECURITY_HEADERS); return ctx.res.end("not found"); }
  ctx.res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": a.content_type, "Content-Length": a.size, "Cache-Control": "private, max-age=3600", "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'" });
  createReadStream(assetPath(id)).pipe(ctx.res);
});

// ---------- admin (developer only) ----------
const findUser = (id) => { const u = auth.byId(id); if (!u) throw new StoreError("not_found", "사용자를 찾을 수 없어요.", 404); return u; };
function guardLastDeveloper(target, nextRole, nextStatus) {
  const devs = auth.activeDevelopers();
  if (target.role === "developer" && target.status === "active" && (nextRole !== "developer" || nextStatus !== "active") && devs.length <= 1)
    throw new StoreError("invalid_argument", "마지막 개발자 계정은 역할을 바꾸거나 비활성화할 수 없어요. 다른 개발자를 먼저 지정하세요.");
}
function dirBytes(dir) { try { return readdirSync(dir).reduce((s, f) => s + statSync(join(dir, f)).size, 0); } catch { return 0; } }
route("GET", "/api/admin/status", (ctx) => {
  const dbFile = join(CONFIG.dataDir, "fsk.db");
  const size = (f) => existsSync(f) ? statSync(f).size : 0;
  let disk = null;
  try { const s = statfsSync(CONFIG.dataDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
  const users = auth.list(), assets = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM assets").get();
  const backups = listBackups();
  send(ctx.res, 200, {
    version: VERSION, node: process.version, platform: `${os.platform()} ${os.arch()}`, hostname: os.hostname(),
    startedAt: startedAt.toISOString(), uptimeSec: Math.round(process.uptime()), systemUptimeSec: Math.round(os.uptime()),
    loadavg: os.loadavg(), memory: { rss: process.memoryUsage().rss, systemFree: os.freemem(), systemTotal: os.totalmem() },
    dataDir: CONFIG.dataDir, dbBytes: size(dbFile) + size(dbFile + "-wal"), assets: { files: assets.n, bytes: assets.bytes }, disk,
    liveConnections: clients.size, liveUsers: new Set([...clients].map((c) => c.user.id)).size,
    users: { total: users.length, pending: users.filter((u) => u.status === "pending").length, byRole: Object.fromEntries(ROLES.map((r) => [r, users.filter((u) => u.role === r && u.status === "active").length])) },
    collections: docs.counts(), lastBackup: backups[0] || null, backupBytes: dirBytes(BACKUP_DIR), settings: { ...allSettings(), inviteCode: undefined },
    behindProxy: CONFIG.trustProxy, cookieSecure: isHttps(ctx.req)
  });
}, { auth: "developer" });
route("GET", "/api/admin/users", (ctx) => {
  const stats = auth.sessionStats(), live = new Set([...clients].map((c) => c.user.id));
  const counts = {};
  for (const d of docs.all()) { const by = d.updatedBy; if (by) counts[by] = (counts[by] || 0) + 1; }
  send(ctx.res, 200, { users: auth.list().map((u) => ({ ...auth.publicUser(u), sessions: stats[u.id]?.sessions || 0, lastSeen: stats[u.id]?.lastSeen || null, online: live.has(u.id), docsWritten: counts[u.id] || 0 })) });
}, { auth: "developer" });
route("POST", "/api/admin/users", async (ctx) => {
  const b = await readJson(ctx.req);
  const username = String(b.username || "").trim().toLowerCase(), name = String(b.name || "").trim();
  const err = checkUsername(username) || (!name || name.length > 20 ? "이름을 1~20자로 적어 주세요." : null) || (!ROLES.includes(b.role) ? "역할을 골라 주세요." : null);
  if (err) return send(ctx.res, 400, { code: "invalid_argument", message: err });
  if (auth.byUsername(username)) return send(ctx.res, 409, { code: "taken", message: "이미 쓰고 있는 아이디예요." });
  const pw = tempPassword();
  const u = auth.create({ username, name, dept: DEPTS.includes(b.dept) ? b.dept : "", role: b.role, status: "active", password: pw, mustChange: true });
  audit(ctx, "user.create", username, b.role);
  syncRoles();
  send(ctx.res, 200, { user: auth.publicUser(u), tempPassword: pw });
}, { auth: "developer" });
route("POST", "/api/admin/users/:id", async (ctx) => {
  const u = findUser(ctx.params.id), b = await readJson(ctx.req);
  const role = b.role ?? u.role, status = b.status ?? u.status;
  if (!ROLES.includes(role) || !STATUSES.includes(status)) return send(ctx.res, 400, { code: "invalid_argument", message: "역할 또는 상태 값이 올바르지 않아요." });
  const name = b.name === undefined ? u.name : String(b.name).trim();
  if (!name || name.length > 20) return send(ctx.res, 400, { code: "invalid_argument", message: "이름을 1~20자로 적어 주세요." });
  guardLastDeveloper(u, role, status);
  const dept = b.dept === undefined ? u.dept : (DEPTS.includes(b.dept) ? b.dept : "");
  auth.update(u.id, { name, dept, role, status });
  const changes = [role !== u.role && `역할 ${u.role} → ${role}`, status !== u.status && `상태 ${u.status} → ${status}`, name !== u.name && `이름 ${u.name} → ${name}`, dept !== u.dept && `부서 ${u.dept || "-"} → ${dept || "-"}`].filter(Boolean);
  if (changes.length) audit(ctx, status !== u.status && u.status === "pending" && status === "active" ? "user.approve" : "user.update", u.username, changes.join(", "));
  if (status !== "active") auth.endAllSessions(u.id);
  if (role !== u.role || status !== u.status) { dropStreams(u.id); syncRoles(); }
  send(ctx.res, 200, { user: auth.publicUser(auth.byId(u.id)) });
}, { auth: "developer" });
route("POST", "/api/admin/users/:id/reset-password", (ctx) => {
  const u = findUser(ctx.params.id), pw = tempPassword();
  auth.setPassword(u.id, pw, true); auth.endAllSessions(u.id); dropStreams(u.id);
  audit(ctx, "user.reset_password", u.username);
  send(ctx.res, 200, { tempPassword: pw });
}, { auth: "developer" });
route("POST", "/api/admin/users/:id/logout", (ctx) => {
  const u = findUser(ctx.params.id);
  auth.endAllSessions(u.id); dropStreams(u.id);
  audit(ctx, "user.force_logout", u.username);
  send(ctx.res, 200, { ok: true });
}, { auth: "developer" });
route("DELETE", "/api/admin/users/:id", (ctx) => {
  const u = findUser(ctx.params.id);
  if (u.id === ctx.user.id) return send(ctx.res, 400, { code: "invalid_argument", message: "자기 계정은 지울 수 없어요." });
  guardLastDeveloper(u, "deleted", "deleted");
  dropStreams(u.id); auth.remove(u.id); syncRoles();
  audit(ctx, "user.delete", u.username, `${u.name} · ${u.role}`);
  send(ctx.res, 200, { ok: true });
}, { auth: "developer" });
route("GET", "/api/admin/settings", (ctx) => send(ctx.res, 200, allSettings()), { auth: "developer" });
route("POST", "/api/admin/settings", async (ctx) => {
  const b = await readJson(ctx.req), changed = [];
  if (b.signupMode !== undefined) { if (!["approval", "invite", "closed"].includes(b.signupMode)) throw new StoreError("invalid_argument", "가입 방식 값이 올바르지 않아요."); setSetting("signupMode", b.signupMode); changed.push(`가입 방식 ${b.signupMode}`); }
  if (b.regenerateInvite) { setSetting("inviteCode", crypto.randomBytes(4).toString("hex")); changed.push("초대 코드 재발급"); }
  if (b.autoBackup !== undefined) { setSetting("autoBackup", !!b.autoBackup); changed.push(`자동 백업 ${b.autoBackup ? "켬" : "끔"}`); }
  if (b.backupHour !== undefined) { const h = Math.round(Number(b.backupHour)); if (!(h >= 0 && h <= 23)) throw new StoreError("invalid_argument", "백업 시각은 0~23시예요."); setSetting("backupHour", h); changed.push(`백업 시각 ${h}시`); }
  if (b.backupKeep !== undefined) { const k = Math.round(Number(b.backupKeep)); if (!(k >= 1 && k <= 90)) throw new StoreError("invalid_argument", "보관 개수는 1~90개예요."); setSetting("backupKeep", k); changed.push(`자동 백업 ${k}개 보관`); }
  if (changed.length) audit(ctx, "settings.update", "", changed.join(", "));
  send(ctx.res, 200, allSettings());
}, { auth: "developer" });
route("GET", "/api/admin/collections", (ctx) => send(ctx.res, 200, { collections: docs.counts() }), { auth: "developer" });
route("GET", "/api/admin/docs", (ctx) => {
  const col = ctx.url.searchParams.get("collection"), q = String(ctx.url.searchParams.get("q") || "").toLowerCase();
  const names = Object.fromEntries(auth.list().map((u) => [u.id, u.name]));
  const list = docs.list(col).filter((d) => !q || d.path.toLowerCase().includes(q) || JSON.stringify(d.data).toLowerCase().includes(q))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  send(ctx.res, 200, { docs: list.map((d) => ({ path: d.path, id: d.id, version: d.version, updatedAt: d.updatedAt, updatedBy: d.updatedBy, updatedByName: names[d.updatedBy] || d.updatedBy, bytes: Buffer.byteLength(JSON.stringify(d.data)), preview: JSON.stringify(d.data).slice(0, 160) })) });
}, { auth: "developer" });
route("GET", "/api/admin/doc", (ctx) => {
  const d = docs.get(ctx.url.searchParams.get("path"));
  if (!d) return send(ctx.res, 404, { code: "not_found", message: "문서가 없어요." });
  send(ctx.res, 200, d);
}, { auth: "developer" });
route("PUT", "/api/admin/doc", async (ctx) => {
  const { path, data, version } = await readJson(ctx.req, 400 * 1024);
  const cur = docs.get(path);
  if (cur && version !== undefined && cur.version !== version) return send(ctx.res, 409, { code: "conflict", message: `그 사이 문서가 바뀌었어요 (현재 v${cur.version}). 다시 불러온 뒤 수정하세요.` });
  const d = docs.set(path, data, ctx.user.id);
  broadcast(path, d);
  if (path === "config/roles") syncRoles();
  audit(ctx, cur ? "data.edit" : "data.create", path, `v${d.version}`);
  send(ctx.res, 200, d);
}, { auth: "developer" });
route("DELETE", "/api/admin/doc", (ctx) => {
  const path = ctx.url.searchParams.get("path"), cur = docs.get(path);
  docs.remove(path); broadcast(path, null);
  if (path === "config/roles") syncRoles();
  audit(ctx, "data.delete", path, cur ? JSON.stringify(cur.data).slice(0, 300) : "");
  send(ctx.res, 200, { ok: true });
}, { auth: "developer" });
route("GET", "/api/admin/audit", (ctx) => {
  const p = ctx.url.searchParams, limit = Math.min(1000, Number(p.get("limit")) || 300), action = p.get("action") || "", actor = p.get("actor") || "";
  const rows = db.prepare(`SELECT * FROM audit WHERE (? = '' OR action LIKE ? || '%') AND (? = '' OR actor = ?) ORDER BY id DESC LIMIT ?`).all(action, action, actor, actor, limit);
  send(ctx.res, 200, { entries: rows });
}, { auth: "developer" });
route("GET", "/api/admin/backups", (ctx) => send(ctx.res, 200, { backups: listBackups() }), { auth: "developer" });
route("POST", "/api/admin/backups", async (ctx) => {
  const b = await readJson(ctx.req);
  const name = createBackup("manual", ctx, String(b.note || "").slice(0, 100));
  send(ctx.res, 200, { name });
}, { auth: "developer" });
const backupFile = (name) => { if (!/^fsk-[\w.-]+\.json$/.test(name) || !existsSync(join(BACKUP_DIR, name))) throw new StoreError("not_found", "백업 파일이 없어요.", 404); return join(BACKUP_DIR, name); };
route("GET", "/api/admin/backups/:name", (ctx) => {
  const f = backupFile(ctx.params.name);
  ctx.res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${ctx.params.name}"`, "Cache-Control": "no-store" });
  createReadStream(f).pipe(ctx.res);
  audit(ctx, "backup.download", ctx.params.name);
}, { auth: "developer" });
route("POST", "/api/admin/backups/:name/restore", async (ctx) => {
  const f = backupFile(ctx.params.name), b = await readJson(ctx.req), mode = b.mode === "merge" ? "merge" : "replace";
  const rows = parseImport(JSON.parse(readFileSync(f, "utf8")));
  const safety = restoreDocs(ctx, rows, mode);
  audit(ctx, "backup.restore", ctx.params.name, `${mode} · ${rows.length} docs · 직전 상태 ${safety}`);
  send(ctx.res, 200, { restored: rows.length, safety });
}, { auth: "developer" });
route("DELETE", "/api/admin/backups/:name", (ctx) => {
  unlinkSync(backupFile(ctx.params.name)); audit(ctx, "backup.delete", ctx.params.name);
  send(ctx.res, 200, { ok: true });
}, { auth: "developer" });
route("POST", "/api/admin/import", async (ctx) => {
  const mode = ctx.url.searchParams.get("mode") === "replace" ? "replace" : "merge";
  const json = await readJson(ctx.req, 100 * 1024 * 1024);
  const rows = parseImport(json);
  const safety = restoreDocs(ctx, rows, mode);
  audit(ctx, "data.import", "", `${mode} · ${rows.length} docs · 직전 상태 ${safety}`);
  send(ctx.res, 200, { imported: rows.length, safety });
}, { auth: "developer" });
function assetRefs() { const text = docs.all().map((d) => JSON.stringify(d.data)).join("\n"); return (id) => text.includes(id); }
route("GET", "/api/admin/assets", (ctx) => {
  const ref = assetRefs(), names = Object.fromEntries(auth.list().map((u) => [u.id, u.name]));
  const list = db.prepare("SELECT * FROM assets ORDER BY created_at DESC").all();
  send(ctx.res, 200, { assets: list.map((a) => ({ id: a.id, contentType: a.content_type, size: a.size, name: a.name, uploader: a.uploader, uploaderName: names[a.uploader] || "", createdAt: a.created_at, referenced: ref(a.id) })) });
}, { auth: "developer" });
route("DELETE", "/api/admin/assets/:id", (ctx) => {
  const id = ctx.params.id; if (!validAssetId(id)) throw new StoreError("invalid_argument", "bad id");
  const a = assetGet.get(id);
  if (existsSync(assetPath(id))) unlinkSync(assetPath(id));
  assetDel.run(id);
  audit(ctx, "asset.delete", id, a ? `${a.name || a.content_type} · ${a.size}B` : "");
  send(ctx.res, 200, { ok: true });
}, { auth: "developer" });
route("POST", "/api/admin/assets/cleanup", (ctx) => {
  const ref = assetRefs(), cutoff = new Date(Date.now() - 86400000).toISOString();
  const orphans = db.prepare("SELECT * FROM assets WHERE created_at < ?").all(cutoff).filter((a) => !ref(a.id));
  let bytes = 0;
  for (const a of orphans) { if (existsSync(assetPath(a.id))) unlinkSync(assetPath(a.id)); assetDel.run(a.id); bytes += a.size; }
  audit(ctx, "asset.cleanup", "", `${orphans.length}개 · ${bytes}B`);
  send(ctx.res, 200, { removed: orphans.length, bytes });
}, { auth: "developer" });

// ---------- dispatcher ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ip = clientIp(req);
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) { res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" }); return res.end("not found"); }
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      let sameOrigin = true;
      if (origin) { try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; } }
      if (req.headers["x-fsk"] !== "1" || !sameOrigin) return send(res, 403, { code: "forbidden", message: "잘못된 요청 출처예요." });
    }
    const user = auth.sessionUser(cookies(req).fsk_session);
    const ctx = { req, res, url, ip, user, params: r.re.exec(url.pathname).groups || {} };
    if (r.auth === "session" && !user) return send(res, 401, { code: "revoked", message: "로그인이 필요해요." });
    if (r.auth === "user" && (!user || user.must_change_pw)) {
      if (url.pathname.startsWith("/_blob/")) { res.writeHead(401, SECURITY_HEADERS); return res.end(); }
      return send(res, 401, { code: "revoked", message: user ? "비밀번호를 먼저 바꿔 주세요." : "로그인이 필요해요." });
    }
    if (r.auth === "developer" && (!user || user.role !== "developer" || user.must_change_pw)) return send(res, 403, { code: "forbidden", message: "개발자만 쓸 수 있어요." });
    await r.handler(ctx);
  } catch (e) {
    if (e instanceof StoreError) { if (!res.headersSent) send(res, e.status, { code: e.code, message: e.message }); return; }
    console.error(new Date().toISOString(), req.method, url.pathname, e);
    if (!res.headersSent) send(res, 500, { code: "unavailable", message: "서버 오류가 났어요. 잠시 후 다시 시도해 주세요." });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`FSK 피트보드 ${VERSION} · http://${CONFIG.host}:${CONFIG.port} · data ${CONFIG.dataDir}`);
    if (auth.count() === 0) console.log("아직 계정이 없어요. /login 에서 처음 가입하는 사람이 개발자 계정이 돼요.");
  });
  setInterval(() => { autoBackupTick(); auth.purgeSessions(); }, 10 * 60000);
  setTimeout(autoBackupTick, 30000);
  const stop = () => { console.log("shutting down"); for (const c of clients) c.res.end(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

export { server, db, docs, auth, createBackup, CONFIG };
