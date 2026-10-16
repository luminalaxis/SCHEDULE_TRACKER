// FSK 피트보드 self-hosted server: one Node process, no npm dependencies (Node 22.13+).
// Serves the same index.html as the claude.ai Artifact, plus a runtime shim (public/fsk-runtime.js)
// that implements window.claude.use("db" | "user" | "assets" | "downloads") against this server.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, statfsSync, createReadStream, readdirSync, unlinkSync, renameSync, mkdtempSync, rmSync, promises as fsp } from "node:fs";
import { join, dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { openStore, createDocs, createRules, runQuery, splitPath, StoreError, levelOf, POSITIONS, deepMerge, stableJson } from "./store.js";
import { createAuth, checkPasswordRule, checkUsername, verifyPassword, hashPassword, tempPassword, ROLES, STATUSES, POSITION_LABEL, tierOf } from "./auth.js";
import { writeTarGz, readTarGz } from "./archive.js";
import { analyzeExport, remapRows } from "./migrate.js";
import { createNotifier, checkWebhookUrl, WEBHOOK_KINDS } from "./notify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VERSION = "1.2.0";
const CONFIG = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "127.0.0.1",
  dataDir: process.env.DATA_DIR || join(ROOT, "data"),
  trustProxy: process.env.TRUST_PROXY === "1",
  cookieSecure: process.env.COOKIE_SECURE === "1",
  // Extra hosts allowed for the team webhook besides Discord and Slack (e.g. a self-hosted Mattermost). Set on the server only.
  webhookHosts: String(process.env.WEBHOOK_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean)
};
const DEPTS = ["battery", "circuit", "chassis", "aero", "powertrain"];
const ASSET_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "video/mp4", "video/webm", "application/pdf",
  "text/csv", "text/markdown", "application/json", "text/plain", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
const MAX_ASSET = 20 * 1024 * 1024;
const MAX_USER_ASSETS = 2 * 1024 ** 3;   // per person (developers exempt)
const MIN_FREE_DISK = 512 * 1024 ** 2;   // refuse uploads below this much free space

const db = openStore(CONFIG.dataDir);
const docs = createDocs(db);
const auth = createAuth(db);
const rules = createRules(JSON.parse(readFileSync(join(ROOT, "artifact.config.json"), "utf8")).capabilities.db.rules);
const startedAt = new Date();

// ---------- settings & audit ----------
const sGet = db.prepare("SELECT value FROM settings WHERE key = ?"), sSet = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
const DEFAULT_SETTINGS = {
  signupMode: "approval", inviteCode: "", autoBackup: true, backupHour: 4, backupKeep: 14,
  mirrorDir: "", mirrorLast: null, webhookUrl: "", webhookKinds: Object.keys(WEBHOOK_KINDS), webhookLast: null
};
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
function pushTo(userId, event, data) { for (const c of clients) if (c.user.id === userId) c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

const notifier = createNotifier({ db, docs, auth, setting, setSetting, push: (uid, n) => pushTo(uid, "notify", n), audit: (ctx, a, t, d) => audit(ctx, a, t, d), extraHosts: CONFIG.webhookHosts });

// config/roles mirrors the organization so the page's treasurer logic keeps working unchanged:
// ownerUid = first developer, treasurers = other developers + 부팀장 (vice_lead).
function syncRoles(patch = {}) {
  const cur = docs.get("config/roles")?.data || {};
  const devs = auth.activeDevelopers();
  const vice = auth.list().filter((u) => u.status === "active" && u.position === "vice_lead" && !devs.includes(u.id)).map((u) => u.id);
  const data = { ownerUid: devs[0] || cur.ownerUid || "", treasurers: [...devs.slice(1), ...vice], allowMemberSubmit: (patch.allowMemberSubmit ?? cur.allowMemberSubmit) !== false, updatedAt: new Date().toISOString() };
  broadcast("config/roles", docs.set("config/roles", data, "system"));
  privateCache = null;
}
// The page's own 권한 관리 dialog writes config/roles; on this server the treasurer is whoever is 부팀장,
// so only the "members may submit" switch is taken from that write.
function applyRolesWrite(ctx, data) { syncRoles({ allowMemberSubmit: data.allowMemberSubmit !== false }); }

// One 팀장, one 부팀장, one 파트장 per department: giving someone a position returns the previous holder to 팀원.
function checkPosition(position, dept) {
  if (!POSITIONS.includes(position)) throw new StoreError("invalid_argument", "직책 값이 올바르지 않아요.");
  if (position === "part_lead" && !dept) throw new StoreError("invalid_argument", "파트장은 부서를 먼저 정해 주세요.");
}
function handOver(ctx, targetId, position, dept) {
  const moved = [];
  if (!position) return moved;
  for (const u of auth.list()) {
    if (u.id === targetId || u.position !== position || (position === "part_lead" && u.dept !== dept)) continue;
    auth.update(u.id, { position: "" }); dropStreams(u.id);
    audit(ctx, "role.change", u.username, `${POSITION_LABEL[position]} → 팀원 (새 ${POSITION_LABEL[position]}에게 넘김)`);
    moved.push({ name: u.name, position });
  }
  return moved;
}

// ---------- backups ----------
const BACKUP_DIR = join(CONFIG.dataDir, "backups");
const backupStamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const backupName = (kind) => `fsk-${backupStamp()}-${kind}.json`;
function backupData(ctx, note) {
  return {
    format: "fsk-backup", version: 1, createdAt: new Date().toISOString(), createdBy: ctx?.user?.name || "system", note,
    docs: docs.all().map(({ path, data, version, updatedAt, updatedBy, createdBy }) => ({ path, data, version, updatedAt, updatedBy, createdBy })),
    users: db.prepare("SELECT * FROM users").all(),
    settings: allSettings(),
    assets: db.prepare("SELECT * FROM assets").all()
  };
}
function createBackup(kind, ctx, note = "") {
  const data = backupData(ctx, note);
  const name = backupName(kind), tmp = join(BACKUP_DIR, name + ".tmp");
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
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
    if (setting("mirrorDir")) mirrorNow(null);
  } catch (e) { console.error("auto backup failed", e); }
}

// ---------- off-site copy (USB drive, network share) ----------
// Copies backup files and attachment files that are not there yet. It never deletes attachment files or
// manual backups in the copy, so a mistake (or an attacker) deleting data on the server cannot wipe the copy.
function mirrorCheck(dir) {
  if (!dir) return null;
  if (!isAbsolute(dir)) return "절대 경로로 적어 주세요 (예: /media/pi/BACKUP/fsk).";
  const r = resolve(dir), dd = resolve(CONFIG.dataDir);
  if (r === dd || r.startsWith(dd + sep) || dd.startsWith(r + sep)) return "데이터 폴더와 겹치지 않는 곳이어야 해요.";
  if (!existsSync(r) || !statSync(r).isDirectory()) return "그 폴더가 없어요. USB 드라이브가 연결돼 있는지 확인하세요.";
  return null;
}
async function runMirror(ctx) {
  const dir = setting("mirrorDir"), res = { at: new Date().toISOString(), ok: false, message: "", files: 0, bytes: 0 };
  try {
    if (!dir) throw new Error("외부 복사 폴더가 정해지지 않았어요.");
    const err = mirrorCheck(dir); if (err) throw new Error(err);
    const root = resolve(dir), bdir = join(root, "backups"), adir = join(root, "assets"), src = join(CONFIG.dataDir, "assets");
    await fsp.mkdir(bdir, { recursive: true, mode: 0o700 }); await fsp.mkdir(adir, { recursive: true, mode: 0o700 });
    const copyIfNew = async (from, to) => {
      const st = await fsp.stat(from);
      try { if ((await fsp.stat(to)).size === st.size) return; } catch {}
      await fsp.copyFile(from, to + ".part"); await fsp.chmod(to + ".part", 0o600).catch(() => {}); await fsp.rename(to + ".part", to);
      res.files++; res.bytes += st.size;
    };
    const backups = listBackups();
    for (const b of backups) await copyIfNew(join(BACKUP_DIR, b.name), join(bdir, b.name));
    // the copy keeps more automatic backups than the server (60), and every manual one
    const autos = (await fsp.readdir(bdir)).filter((f) => /^fsk-[\w.-]+-auto\.json$/.test(f)).sort().reverse();
    for (const f of autos.slice(60)) await fsp.unlink(join(bdir, f));
    let assetsTotal = 0;
    for (const f of await fsp.readdir(src)) if (validAssetId(f)) { assetsTotal++; await copyIfNew(join(src, f), join(adir, f)); }
    await fsp.writeFile(join(root, "LAST_COPY.txt"), `FSK 피트보드 외부 복사\n마지막 복사: ${res.at}\n백업 파일 ${backups.length}개, 첨부 파일 ${assetsTotal}개\n복원 방법: 저장소 README의 '외부 복사본에서 복원'\n`);
    res.ok = true; res.message = res.files ? `새 파일 ${res.files}개를 복사했어요` : "새로 복사할 파일이 없어요";
  } catch (e) { res.message = e && e.message ? e.message : String(e); }
  setSetting("mirrorLast", res);
  audit(ctx, "backup.mirror", dir || "", `${res.ok ? "성공" : "실패"} · ${res.message}`);
  return res;
}
let mirroring = null;
function mirrorNow(ctx) { if (!mirroring) mirroring = runMirror(ctx).finally(() => { mirroring = null; }); return mirroring; }
function parseImport(json) {
  const raw = Array.isArray(json) ? json : json && Array.isArray(json.docs) ? json.docs : null;
  if (!raw) throw new StoreError("invalid_argument", "docs 배열이 있는 백업 파일이 아니에요.");
  return raw.map((d) => ({ path: (d && (d.path || (d.collection && d.id ? `${d.collection}/${d.id}` : ""))) || "", data: d && d.data, version: d && d.version, updatedAt: d && d.updatedAt, updatedBy: d && d.updatedBy, createdBy: d && d.createdBy }));
}
// Puts attachment files from an extracted full backup back in place (files that already exist are kept).
function restoreAssets(rows, dir) {
  const ins = db.prepare("INSERT OR IGNORE INTO assets (id, content_type, size, uploader, name, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  let n = 0;
  for (const a of rows || []) {
    if (!a || !validAssetId(a.id) || !ASSET_TYPES.has(a.content_type)) continue;
    const from = join(dir, a.id);
    if (!existsSync(assetPath(a.id))) { if (!existsSync(from)) continue; renameSync(from, assetPath(a.id)); n++; }
    ins.run(a.id, a.content_type, statSync(assetPath(a.id)).size, a.uploader || null, String(a.name || "").slice(0, 200), a.created_at || new Date().toISOString());
  }
  return n;
}
function restoreDocs(ctx, rows, mode) {
  const safety = createBackup("pre-restore", ctx, `${mode} 전 자동 보관`);
  if (mode === "replace") docs.replaceAll(rows); else docs.mergeAll(rows);
  privateCache = null;
  syncRoles();
  for (const c of clients) c.res.write("event: reload\ndata: {}\n\n");
  return safety;
}

// ---------- http helpers ----------
const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY", "Cross-Origin-Opener-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()" };
// Scripts run only with this response's nonce (no 'unsafe-inline'), so injected markup cannot run script.
const pageCsp = (nonce) => `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json);
}
function sendHtml(res, html, status = 200) {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": pageCsp(nonce) });
  res.end(html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`));
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
const AUTH_BODY = 16 * 1024;
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

// Rate limits: 10 failed logins per IP and 30 per account in 15 minutes, 10 sign-ups per IP per hour.
const LOGIN_WINDOW = 15 * 60000, SIGNUP_WINDOW = 3600000;
const fails = new Map(), accountFails = new Map(), signups = new Map();
const limited = (map, key, max, win) => { const f = map.get(key); return !!f && f.count >= max && Date.now() - f.first < win; };
const bump = (map, key, win) => { const f = map.get(key); if (!f || Date.now() - f.first > win) map.set(key, { count: 1, first: Date.now() }); else f.count++; };
function pruneLimits() { for (const m of [fails, accountFails, signups]) for (const [k, f] of m) if (Date.now() - f.first > SIGNUP_WINDOW) m.delete(k); }
// Unknown usernames still pay for one scrypt check, so response time does not reveal which accounts exist.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
const sameSecret = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- page ----------
let pageCache = { mtime: 0, html: "" };
function pageSource() {
  const p = join(ROOT, "index.html"), m = statSync(p).mtimeMs;
  if (m !== pageCache.mtime) pageCache = { mtime: m, html: readFileSync(p, "utf8") };
  return pageCache.html;
}
const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
const JSZIP_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
function renderPage(user) {
  const me = { ...auth.publicUser(user), level: levelOf(user) };
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
    + `<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#131A24"><link rel="icon" href="/icons/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icons/icon-192.png"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="피트보드">`
    + `<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font-size:14px;font-family:system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>`
    + `<script>window.__FSK_ME=${safeJson(me)};</script><script src="/fsk-runtime.js"></script></head><body>\n${pageSource().replace(JSZIP_CDN, "/vendor/jszip.min.js")}\n</body></html>`;
}
const staticFile = (name) => readFileSync(join(HERE, "public", name));
function sendStatic(res, name, type, cache = "no-cache", extra = {}) {
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": cache, ...extra });
  res.end(staticFile(name));
}

// ---------- 사비 정산 protection ----------
// Expense originals and receipt photos hold bank details and personal purchases: only the submitter,
// the uploader, 총무 (부팀장 / reviewers in config/roles) and developers may open them.
let privateCache = null;
const trustedReviewers = () => { const r = docs.get("config/roles")?.data || {}; return new Set([r.ownerUid, ...(r.treasurers || [])].filter(Boolean)); };
const expenseAssets = (s) => [s && s.fileAsset, ...((s && Array.isArray(s.receipts) ? s.receipts : []).map((r) => r && r.asset))].filter((a) => typeof a === "string" && a);
function privateAssets() {
  if (privateCache) return privateCache;
  const map = new Map();
  const add = (id, uid) => { const k = id.replace(/^\/_blob\//, ""); if (!map.has(k)) map.set(k, new Set()); if (uid) map.get(k).add(uid); };
  for (const d of docs.list("expenses")) for (const s of Object.values(d.data.subs || {})) expenseAssets(s).forEach((a) => add(a, d.id));
  const trusted = trustedReviewers();
  for (const d of docs.list("reviews")) for (const [key, it] of Object.entries(d.data.items || {})) {
    if (it && it.override) expenseAssets(it.override).forEach((a) => add(a, trusted.has(d.id) ? key.split(":")[0] : null));
  }
  return (privateCache = map);
}
const isManager = (u) => u.role === "developer" || u.position === "vice_lead" || trustedReviewers().has(u.id);
function canSeeAsset(user, a) {
  const viewers = privateAssets().get(a.id);
  return !viewers || isManager(user) || a.uploader === user.id || viewers.has(user.id);
}

// Submitted 사비 내역서 entries are final for the submitter: they can add new ones but not change or remove
// what was submitted (총무 replaces a file with a 수정본 instead). Developers keep full control (완전 삭제).
function guardWrite(ctx, path, prev, next) {
  const segs = path.split("/");
  if (segs[0] !== "expenses" || segs.length !== 2 || ctx.user.role === "developer") return;
  const before = (prev && prev.subs) || {}, after = next && next.subs && typeof next.subs === "object" && !Array.isArray(next.subs) ? next.subs : {};
  for (const [id, sub] of Object.entries(before)) {
    if (!(id in after) || stableJson(after[id]) !== stableJson(sub))
      throw new StoreError("locked", "제출한 사비 내역서는 고치거나 지울 수 없어요. 바꿀 내용이 있으면 총무에게 수정본 교체를 요청하세요.", 403);
  }
  for (const [id, sub] of Object.entries(after)) {
    if (id in before) continue;
    for (const a of expenseAssets(sub)) {
      const row = validAssetId(a) ? assetGet.get(a) : null;
      if (!row || row.uploader !== ctx.user.id) throw new StoreError("forbidden", "내가 올린 파일만 내역서에 넣을 수 있어요.", 403);
    }
  }
}
function afterWrite(ctx, path, prevData, d) {
  broadcast(path, d);
  const col = path.split("/")[0];
  if (col === "expenses" || col === "reviews" || path === "config/roles") privateCache = null;
  notifier.onWrite(ctx, path, prevData, d ? d.data : null);
}
function commitWrite(ctx, path, next) {
  const prev = docs.get(path);
  guardWrite(ctx, path, prev ? prev.data : null, next);
  const d = next === null ? (docs.remove(path), null) : docs.set(path, next, ctx.user.id);
  afterWrite(ctx, path, prev ? prev.data : null, d);
  return d;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler, auth: opts.auth || "user" });
const assertWrite = (ctx, path) => { if (!rules.canWrite(ctx.user, path)) throw new StoreError("invalid_argument", "이 경로에 쓸 권한이 없어요.", 403); };
const level = levelOf;

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
route("GET", "/fsk-runtime.js", (ctx) => sendStatic(ctx.res, "fsk-runtime.js", "text/javascript; charset=utf-8"), { auth: "none" });
// installable app (PWA): manifest, service worker (offline start), icons, and a local copy of JSZip
route("GET", "/sw.js", (ctx) => sendStatic(ctx.res, "sw.js", "text/javascript; charset=utf-8", "no-cache", { "Service-Worker-Allowed": "/" }), { auth: "none" });
route("GET", "/manifest.webmanifest", (ctx) => sendStatic(ctx.res, "manifest.webmanifest", "application/manifest+json; charset=utf-8", "public, max-age=3600"), { auth: "none" });
const ICONS = { "icon.svg": "image/svg+xml", "icon-192.png": "image/png", "icon-512.png": "image/png", "icon-maskable-512.png": "image/png" };
route("GET", "/icons/:name", (ctx) => {
  const type = Object.hasOwn(ICONS, ctx.params.name) && ICONS[ctx.params.name];
  if (!type) { ctx.res.writeHead(404, SECURITY_HEADERS); return ctx.res.end("not found"); }
  sendStatic(ctx.res, "icons/" + ctx.params.name, type, "public, max-age=86400");
}, { auth: "none" });
route("GET", "/vendor/jszip.min.js", (ctx) => sendStatic(ctx.res, "vendor/jszip.min.js", "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"), { auth: "none" });
route("GET", "/healthz", (ctx) => send(ctx.res, 200, { ok: true, version: VERSION }), { auth: "none" });

// auth
route("GET", "/api/auth/config", (ctx) => send(ctx.res, 200, { signupMode: setting("signupMode"), firstUser: auth.count() === 0, signedIn: !!ctx.user }), { auth: "none" });
route("POST", "/api/auth/login", async (ctx) => {
  if (limited(fails, ctx.ip, 10, LOGIN_WINDOW)) return send(ctx.res, 429, { code: "rate_limited", message: "로그인 시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요." });
  const { username, password } = await readJson(ctx.req, AUTH_BODY);
  const uname = String(username || "").trim().toLowerCase().slice(0, 64);
  if (limited(accountFails, uname, 30, LOGIN_WINDOW)) return send(ctx.res, 429, { code: "rate_limited", message: "이 아이디로 로그인 실패가 너무 많아요. 15분 뒤에 다시 시도하거나 개발자에게 문의하세요." });
  const u = auth.byUsername(uname);
  const ok = verifyPassword(String(password || ""), u ? u.pw_hash : DUMMY_HASH) && !!u;
  if (!ok) {
    bump(fails, ctx.ip, LOGIN_WINDOW); bump(accountFails, uname, LOGIN_WINDOW); audit({ ip: ctx.ip }, "login.fail", uname.slice(0, 40));
    return send(ctx.res, 401, { code: "bad_credentials", message: "아이디 또는 비밀번호가 맞지 않아요." });
  }
  if (u.status === "pending") return send(ctx.res, 403, { code: "pending", message: "가입 승인을 기다리고 있어요. 개발자에게 승인을 요청하세요." });
  if (u.status !== "active") return send(ctx.res, 403, { code: "disabled", message: "비활성화된 계정이에요. 개발자에게 문의하세요." });
  fails.delete(ctx.ip); accountFails.delete(uname);
  const s = auth.startSession(u.id, ctx.ip, ctx.req.headers["user-agent"]);
  setSessionCookie(ctx.req, ctx.res, s.token, s.maxAge);
  audit({ user: u, ip: ctx.ip }, "login", u.username);
  send(ctx.res, 200, { user: auth.publicUser(u) });
}, { auth: "none" });
route("POST", "/api/auth/signup", async (ctx) => {
  if (limited(signups, ctx.ip, 10, SIGNUP_WINDOW)) return send(ctx.res, 429, { code: "rate_limited", message: "가입 신청이 너무 많아요. 한 시간 뒤에 다시 시도해 주세요." });
  const b = await readJson(ctx.req, AUTH_BODY);
  const username = String(b.username || "").trim().toLowerCase(), name = String(b.name || "").trim(), dept = DEPTS.includes(b.dept) ? b.dept : "";
  const err = checkUsername(username) || checkPasswordRule(b.password) || (!name || name.length > 20 ? "이름을 1~20자로 적어 주세요." : null);
  if (err) return send(ctx.res, 400, { code: "invalid_argument", message: err });
  if (auth.byUsername(username)) return send(ctx.res, 409, { code: "taken", message: "이미 쓰고 있는 아이디예요." });
  const first = auth.count() === 0, mode = setting("signupMode");
  let role = "member", status = "pending";
  if (first) { role = "developer"; status = "active"; }
  else if (mode === "closed") return send(ctx.res, 403, { code: "closed", message: "지금은 가입을 받지 않아요. 개발자에게 계정을 만들어 달라고 요청하세요." });
  else if (mode === "invite") {
    if (!sameSecret(String(b.invite || "").trim(), setting("inviteCode"))) { bump(signups, ctx.ip, SIGNUP_WINDOW); return send(ctx.res, 403, { code: "bad_invite", message: "초대 코드가 맞지 않아요." }); }
    status = "active";
  }
  const u = auth.create({ username, name, dept, role, status, password: b.password });
  if (!first) bump(signups, ctx.ip, SIGNUP_WINDOW);
  audit({ user: u, ip: ctx.ip }, "signup", username, `${role} · ${status}`);
  if (first) syncRoles();
  if (status === "pending") notifier.notify(auth.activeDevelopers(), { kind: "signup", title: "가입 승인 요청", body: `${name} (${username})${dept ? " · " + ({ battery: "배터리", circuit: "회로", chassis: "프레임·현가", aero: "에어로", powertrain: "파워트레인" })[dept] : ""}`, link: { href: "/admin#users" } });
  if (status === "active") { const s = auth.startSession(u.id, ctx.ip, ctx.req.headers["user-agent"]); setSessionCookie(ctx.req, ctx.res, s.token, s.maxAge); }
  send(ctx.res, 200, { status, role });
}, { auth: "none" });
route("POST", "/api/auth/logout", (ctx) => {
  auth.endSession(cookies(ctx.req).fsk_session); clearSessionCookie(ctx.req, ctx.res);
  if (ctx.user) audit(ctx, "logout", ctx.user.username);
  send(ctx.res, 200, { ok: true });
}, { auth: "none" });
route("POST", "/api/auth/password", async (ctx) => {
  const b = await readJson(ctx.req, AUTH_BODY);
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
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
route("POST", "/api/db/set", async (ctx) => {
  const { path, data } = await readJson(ctx.req, 400 * 1024);
  splitPath(path, "doc"); assertWrite(ctx, path);
  if (!isObject(data)) throw new StoreError("invalid_argument", "document body must be an object");
  const d = commitWrite(ctx, path, data);
  if (path === "config/roles") applyRolesWrite(ctx, data);
  send(ctx.res, 200, { ok: true, version: d.version });
});
route("POST", "/api/db/update", async (ctx) => {
  const { path, data } = await readJson(ctx.req, 400 * 1024);
  splitPath(path, "doc"); assertWrite(ctx, path);
  const cur = docs.get(path);
  if (!cur) throw new StoreError("invalid_argument", "update needs an existing document");
  if (!isObject(data)) throw new StoreError("invalid_argument", "patch must be an object");
  const d = commitWrite(ctx, path, deepMerge(cur.data, data));
  if (path === "config/roles") applyRolesWrite(ctx, d.data);
  send(ctx.res, 200, { ok: true, version: d.version });
});
route("POST", "/api/db/delete", async (ctx) => {
  const { path } = await readJson(ctx.req);
  splitPath(path, "doc"); assertWrite(ctx, path);
  commitWrite(ctx, path, null);
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

// notifications (the bell in the page)
route("GET", "/api/notifications", (ctx) => send(ctx.res, 200, { items: notifier.list(ctx.user.id, ctx.url.searchParams.get("limit")), unread: notifier.unreadCount(ctx.user.id) }));
route("POST", "/api/notifications/read", async (ctx) => {
  const b = await readJson(ctx.req, AUTH_BODY);
  const ids = b.all === true ? "all" : Array.isArray(b.ids) ? b.ids.filter((x) => Number.isInteger(x)).slice(0, 200) : [];
  send(ctx.res, 200, { unread: notifier.markRead(ctx.user.id, ids) });
});

// assets
const assetIns = db.prepare("INSERT INTO assets (id, content_type, size, uploader, name, created_at) VALUES (?, ?, ?, ?, ?, ?)");
const assetGet = db.prepare("SELECT * FROM assets WHERE id = ?"), assetDel = db.prepare("DELETE FROM assets WHERE id = ?");
const assetPath = (id) => join(CONFIG.dataDir, "assets", id);
const validAssetId = (id) => /^[a-f0-9]{32}$/.test(id);
const assetUsage = db.prepare("SELECT COALESCE(SUM(size), 0) AS bytes FROM assets WHERE uploader = ?");
function freeDisk() { try { const s = statfsSync(CONFIG.dataDir); return s.bavail * s.bsize; } catch { return Infinity; } }
route("POST", "/api/assets", async (ctx) => {
  if (level(ctx.user) < 2) return send(ctx.res, 403, { code: "not_granted", message: "파일을 올릴 권한이 없어요." });
  const type = String(ctx.req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!ASSET_TYPES.has(type)) return send(ctx.res, 415, { code: "unsupported_type", message: "지원하지 않는 파일 형식이에요." });
  if (freeDisk() < MIN_FREE_DISK) return send(ctx.res, 507, { code: "quota_or_state", message: "서버 저장 공간이 부족해요. 개발자에게 알려 주세요." });
  if (ctx.user.role !== "developer" && assetUsage.get(ctx.user.id).bytes > MAX_USER_ASSETS) return send(ctx.res, 507, { code: "quota_or_state", message: "내가 올린 파일이 2GB를 넘었어요. 안 쓰는 첨부를 지운 뒤 다시 올려 주세요." });
  const buf = await readBody(ctx.req, type === "image/svg+xml" ? 2 * 1024 * 1024 : MAX_ASSET);
  if (!buf.length) return send(ctx.res, 400, { code: "invalid_request", message: "빈 파일이에요." });
  let fileName = String(ctx.req.headers["x-file-name"] || "");
  try { fileName = decodeURIComponent(fileName); } catch {}
  const id = crypto.randomBytes(16).toString("hex");
  writeFileSync(assetPath(id), buf, { mode: 0o600 });
  assetIns.run(id, type, buf.length, ctx.user.id, fileName.slice(0, 200), new Date().toISOString());
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
  if (!canSeeAsset(ctx.user, a)) { ctx.res.writeHead(403, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" }); return ctx.res.end("사비 내역서 파일은 제출자와 총무만 볼 수 있어요."); }
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
    users: {
      total: users.length, pending: users.filter((u) => u.status === "pending").length,
      byTier: Object.fromEntries(["developer", "executive", "member"].map((t) => [t, users.filter((u) => u.status === "active" && tierOf(u) === t).length])),
      org: {
        teamLead: users.filter((u) => u.status === "active" && u.position === "team_lead").map((u) => u.name),
        viceLead: users.filter((u) => u.status === "active" && u.position === "vice_lead").map((u) => u.name),
        partLeads: Object.fromEntries(DEPTS.map((d) => [d, users.filter((u) => u.status === "active" && u.position === "part_lead" && u.dept === d).map((u) => u.name)]))
      }
    },
    collections: docs.counts(), lastBackup: backups[0] || null, backupBytes: dirBytes(BACKUP_DIR),
    settings: { ...allSettings(), inviteCode: undefined, webhookUrl: undefined, webhookOn: !!setting("webhookUrl") },
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
  const role = b.role === "developer" ? "developer" : "member", position = b.position || "", dept = DEPTS.includes(b.dept) ? b.dept : "";
  const err = checkUsername(username) || (!name || name.length > 20 ? "이름을 1~20자로 적어 주세요." : null);
  if (err) return send(ctx.res, 400, { code: "invalid_argument", message: err });
  checkPosition(position, dept);
  if (auth.byUsername(username)) return send(ctx.res, 409, { code: "taken", message: "이미 쓰고 있는 아이디예요." });
  const pw = tempPassword();
  const u = auth.create({ username, name, dept, role, position, status: "active", password: pw, mustChange: true });
  const moved = handOver(ctx, u.id, position, dept);
  audit(ctx, "user.create", username, auth.publicUser(u).title);
  syncRoles();
  send(ctx.res, 200, { user: auth.publicUser(u), tempPassword: pw, handedOver: moved });
}, { auth: "developer" });
route("POST", "/api/admin/users/:id", async (ctx) => {
  const u = findUser(ctx.params.id), b = await readJson(ctx.req);
  const role = b.role ?? u.role, status = b.status ?? u.status;
  if (!ROLES.includes(role) || !STATUSES.includes(status)) return send(ctx.res, 400, { code: "invalid_argument", message: "역할 또는 상태 값이 올바르지 않아요." });
  const name = b.name === undefined ? u.name : String(b.name).trim();
  if (!name || name.length > 20) return send(ctx.res, 400, { code: "invalid_argument", message: "이름을 1~20자로 적어 주세요." });
  guardLastDeveloper(u, role, status);
  const dept = b.dept === undefined ? u.dept : (DEPTS.includes(b.dept) ? b.dept : "");
  const position = b.position === undefined ? (u.position || "") : String(b.position);
  checkPosition(position, dept);
  const moved = position !== u.position || (position === "part_lead" && dept !== u.dept) ? handOver(ctx, u.id, position, dept) : [];
  auth.update(u.id, { name, dept, role, position, status });
  const label = (p) => POSITION_LABEL[p || ""];
  const changes = [role !== u.role && `개발자 권한 ${u.role === "developer" ? "있음" : "없음"} → ${role === "developer" ? "있음" : "없음"}`, position !== (u.position || "") && `직책 ${label(u.position)} → ${label(position)}`,
    status !== u.status && `상태 ${u.status} → ${status}`, name !== u.name && `이름 ${u.name} → ${name}`, dept !== u.dept && `부서 ${u.dept || "-"} → ${dept || "-"}`].filter(Boolean);
  if (changes.length) audit(ctx, status !== u.status && u.status === "pending" && status === "active" ? "user.approve" : "user.update", u.username, changes.join(", "));
  if (status !== "active") auth.endAllSessions(u.id);
  if (role !== u.role || status !== u.status || position !== (u.position || "") || moved.length) { dropStreams(u.id); syncRoles(); }
  send(ctx.res, 200, { user: auth.publicUser(auth.byId(u.id)), handedOver: moved });
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
const adminSettings = () => ({ ...allSettings(), allowMemberSubmit: docs.get("config/roles")?.data?.allowMemberSubmit !== false, webhookKindLabels: WEBHOOK_KINDS, webhookExtraHosts: CONFIG.webhookHosts });
route("GET", "/api/admin/settings", (ctx) => send(ctx.res, 200, adminSettings()), { auth: "developer" });
route("POST", "/api/admin/settings", async (ctx) => {
  const b = await readJson(ctx.req), changed = [];
  if (b.signupMode !== undefined) { if (!["approval", "invite", "closed"].includes(b.signupMode)) throw new StoreError("invalid_argument", "가입 방식 값이 올바르지 않아요."); setSetting("signupMode", b.signupMode); changed.push(`가입 방식 ${b.signupMode}`); }
  if (b.regenerateInvite) { setSetting("inviteCode", crypto.randomBytes(4).toString("hex")); changed.push("초대 코드 재발급"); }
  if (b.autoBackup !== undefined) { setSetting("autoBackup", !!b.autoBackup); changed.push(`자동 백업 ${b.autoBackup ? "켬" : "끔"}`); }
  if (b.backupHour !== undefined) { const h = Math.round(Number(b.backupHour)); if (!(h >= 0 && h <= 23)) throw new StoreError("invalid_argument", "백업 시각은 0~23시예요."); setSetting("backupHour", h); changed.push(`백업 시각 ${h}시`); }
  if (b.backupKeep !== undefined) { const k = Math.round(Number(b.backupKeep)); if (!(k >= 1 && k <= 90)) throw new StoreError("invalid_argument", "보관 개수는 1~90개예요."); setSetting("backupKeep", k); changed.push(`자동 백업 ${k}개 보관`); }
  if (b.allowMemberSubmit !== undefined) { syncRoles({ allowMemberSubmit: !!b.allowMemberSubmit }); changed.push(`팀원 사비 내역서 제출 ${b.allowMemberSubmit ? "허용" : "막음"}`); }
  if (b.mirrorDir !== undefined) {
    const d = String(b.mirrorDir || "").trim(), err = mirrorCheck(d);
    if (err) throw new StoreError("invalid_argument", err);
    setSetting("mirrorDir", d ? resolve(d) : ""); changed.push(d ? `외부 복사 폴더 ${resolve(d)}` : "외부 복사 끔");
  }
  if (b.webhookUrl !== undefined) {
    const u = String(b.webhookUrl || "").trim(), err = checkWebhookUrl(u, CONFIG.webhookHosts);
    if (err) throw new StoreError("invalid_argument", err);
    if (u !== setting("webhookUrl")) { setSetting("webhookUrl", u); setSetting("webhookLast", null); changed.push(u ? `팀 채널 웹훅 ${new URL(u).hostname}` : "팀 채널 웹훅 끔"); }
  }
  if (b.webhookKinds !== undefined) {
    if (!Array.isArray(b.webhookKinds)) throw new StoreError("invalid_argument", "알림 종류 값이 올바르지 않아요.");
    const kinds = Object.keys(WEBHOOK_KINDS).filter((k) => b.webhookKinds.includes(k));
    setSetting("webhookKinds", kinds); changed.push(`팀 채널 알림: ${kinds.map((k) => WEBHOOK_KINDS[k]).join(", ") || "없음"}`);
  }
  if (changed.length) audit(ctx, "settings.update", "", changed.join(", "));
  send(ctx.res, 200, adminSettings());
}, { auth: "developer" });
route("POST", "/api/admin/webhook-test", async (ctx) => {
  const b = await readJson(ctx.req, AUTH_BODY), url = String(b.url || setting("webhookUrl") || "").trim();
  if (!url) throw new StoreError("invalid_argument", "웹훅 주소를 먼저 적어 주세요.");
  const err = checkWebhookUrl(url, CONFIG.webhookHosts); if (err) throw new StoreError("invalid_argument", err);
  const r = await notifier.testWebhook(url);
  audit(ctx, "notify.webhook_test", new URL(url).hostname, r.status);
  send(ctx.res, 200, r);
}, { auth: "developer" });
route("POST", "/api/admin/notify-run", (ctx) => send(ctx.res, 200, notifier.tick({ force: true })), { auth: "developer" });
route("POST", "/api/admin/mirror", async (ctx) => send(ctx.res, 200, await mirrorNow(ctx)), { auth: "developer" });
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
  afterWrite(ctx, path, cur ? cur.data : null, d);
  if (path === "config/roles") syncRoles();
  audit(ctx, cur ? "data.edit" : "data.create", path, `v${d.version}`);
  send(ctx.res, 200, d);
}, { auth: "developer" });
route("DELETE", "/api/admin/doc", (ctx) => {
  const path = ctx.url.searchParams.get("path"), cur = docs.get(path);
  docs.remove(path); afterWrite(ctx, path, cur ? cur.data : null, null);
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
// Full backup: every document, account (hashed passwords), setting, and the attachment files themselves.
route("GET", "/api/admin/backups-full", async (ctx) => {
  const data = backupData(ctx, "전체 백업 (첨부 파일 포함)"), name = `fsk-full-${backupStamp()}.tar.gz`;
  const files = data.assets.filter((a) => validAssetId(a.id) && existsSync(assetPath(a.id))).map((a) => ({ name: `assets/${a.id}`, file: assetPath(a.id), size: statSync(assetPath(a.id)).size }));
  audit(ctx, "backup.full", name, `${data.docs.length} docs · ${files.length} files`);
  ctx.res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
  try { await writeTarGz(ctx.res, [{ name: "backup.json", data: Buffer.from(JSON.stringify(data)) }, ...files]); }
  catch (e) { console.error("full backup failed", e); ctx.res.destroy(e); }
}, { auth: "developer" });
// Restore documents and attachment files from a full backup. Accounts and settings stay as they are
// (restore those with `npm run admin -- restore <file>` on the server).
route("POST", "/api/admin/restore-full", async (ctx) => {
  const mode = ctx.url.searchParams.get("mode") === "replace" ? "replace" : "merge";
  if (freeDisk() < MIN_FREE_DISK) throw new StoreError("quota_or_state", "서버 저장 공간이 부족해서 복원할 수 없어요.", 507);
  const tmp = mkdtempSync(join(CONFIG.dataDir, "restore-"));
  try {
    let out;
    try { out = await readTarGz(ctx.req, (name) => name === "backup.json" ? "json" : /^assets\/[a-f0-9]{32}$/.test(name) ? join(tmp, name.slice(7)) : null); }
    catch (e) { throw new StoreError("invalid_argument", "전체 백업 파일(.tar.gz)을 읽을 수 없어요."); }
    let json = null;
    try { json = out.json && JSON.parse(out.json.toString("utf8")); } catch {}
    if (!json || json.format !== "fsk-backup") throw new StoreError("invalid_argument", "피트보드 전체 백업 파일이 아니에요 (backup.json 이 없어요).");
    const rows = parseImport(json), safety = restoreDocs(ctx, rows, mode), files = restoreAssets(json.assets, tmp);
    audit(ctx, "backup.restore_full", json.createdAt || "", `${mode} · ${rows.length} docs · 파일 ${files}개 · 직전 상태 ${safety}`);
    send(ctx.res, 200, { restored: rows.length, files, safety });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, { auth: "developer" });
// Moving from claude.ai: list the claude.ai account ids in an export so each can be matched to an account here.
route("POST", "/api/admin/import/analyze", async (ctx) => {
  const rows = parseImport(await readJson(ctx.req, 100 * 1024 * 1024));
  const counts = {};
  for (const r of rows) { const c = String(r.path).split("/")[0]; counts[c] = (counts[c] || 0) + 1; }
  const users = auth.list().filter((u) => u.status === "active");
  send(ctx.res, 200, { docs: rows.length, collections: counts, ids: analyzeExport(rows, users), users: users.map((u) => ({ id: u.id, name: u.name, username: u.username, dept: u.dept })) });
}, { auth: "developer" });
route("POST", "/api/admin/import", async (ctx) => {
  const mode = ctx.url.searchParams.get("mode") === "replace" ? "replace" : "merge";
  const json = await readJson(ctx.req, 100 * 1024 * 1024);
  let rows = parseImport(json), mapped = 0;
  if (json && isObject(json.idMap)) {
    const known = new Set(auth.list().map((u) => u.id)), map = {};
    for (const [from, to] of Object.entries(json.idMap)) {
      if (!to) continue;
      if (typeof to !== "string" || !known.has(to)) throw new StoreError("invalid_argument", "연결할 계정을 찾을 수 없어요. 화면을 새로고침한 뒤 다시 골라 주세요.");
      map[from] = to; mapped++;
    }
    rows = remapRows(rows, map);
  }
  const safety = restoreDocs(ctx, rows, mode);
  audit(ctx, "data.import", "", `${mode} · ${rows.length} docs${mapped ? ` · 계정 ${mapped}개 연결` : ""} · 직전 상태 ${safety}`);
  send(ctx.res, 200, { imported: rows.length, mapped, safety });
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
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=15552000");
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
  const tick = () => { autoBackupTick(); auth.purgeSessions(); pruneLimits(); try { notifier.tick(); } catch (e) { console.error("notify tick failed", e); } };
  setInterval(tick, 10 * 60000);
  setTimeout(tick, 30000);
  const stop = () => { console.log("shutting down"); for (const c of clients) c.res.end(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

export { server, db, docs, auth, createBackup, CONFIG, notifier };
