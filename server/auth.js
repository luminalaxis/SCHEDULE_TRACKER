// Accounts, password hashing (scrypt) and cookie sessions.
import crypto from "node:crypto";

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
export const ROLES = ["developer", "member"];
export const STATUSES = ["active", "pending", "disabled"];
export const ROLE_LABEL = { developer: "개발자", member: "일반" };
export const POSITION_LABEL = { "": "팀원", team_lead: "팀장", vice_lead: "부팀장", part_lead: "파트장" };
export const tierOf = (u) => u.role === "developer" ? "developer" : u.position ? "executive" : "member";
export const TIER_LABEL = { developer: "개발자", executive: "임원진", member: "팀원" };
export const STATUS_LABEL = { active: "활성", pending: "승인 대기", disabled: "비활성" };

export const newId = (prefix = "", bytes = 16) => prefix + crypto.randomBytes(bytes).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// scrypt runs on libuv's thread pool, not the event loop: a login no longer stalls live updates and other requests.
// At most two run at once, so a flood of logins cannot take every pool thread from file reads and compression.
const scryptAsync = (pw, salt, len, opts) => new Promise((resolve, reject) => crypto.scrypt(pw, salt, len, opts, (e, key) => (e ? reject(e) : resolve(key))));
let running = 0;
const waiting = [];
async function scrypt(pw, salt, len, opts) {
  if (running >= 2) await new Promise((r) => waiting.push(r));
  running++;
  try { return await scryptAsync(pw, salt, len, opts); }
  finally { running--; const next = waiting.shift(); if (next) next(); }
}
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [kind, N, r, p, salt, hash] = String(stored).split("$");
    if (kind !== "scrypt") return false;
    const want = Buffer.from(hash, "base64");
    const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(want, got);
  } catch { return false; }
}
export function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(10), (b) => abc[b % abc.length]).join("").replace(/(.{5})/, "$1-");
}
export function checkPasswordRule(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "비밀번호는 8자 이상이어야 해요.";
  if (pw.length > 200) return "비밀번호가 너무 길어요.";
  return null;
}
export function checkUsername(u) {
  if (typeof u !== "string" || !/^[a-z0-9._-]{3,32}$/.test(u)) return "아이디는 영문 소문자·숫자·._- 3~32자로 정해 주세요.";
  return null;
}

export function createAuth(db) {
  const q = {
    count: db.prepare("SELECT COUNT(*) AS n FROM users"),
    byName: db.prepare("SELECT * FROM users WHERE username = ?"),
    byId: db.prepare("SELECT * FROM users WHERE id = ?"),
    insert: db.prepare("INSERT INTO users (id, username, name, dept, role, position, status, pw_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    all: db.prepare("SELECT id, username, name, dept, role, position, status, must_change_pw, created_at, last_login FROM users ORDER BY created_at"),
    sessionInsert: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    sessionGet: db.prepare("SELECT s.token_hash, s.expires_at, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"),
    sessionTouch: db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?"),
    sessionDel: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    sessionDelUser: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    sessionDelOthers: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?"),
    sessionCount: db.prepare("SELECT user_id, COUNT(*) AS n, MAX(last_seen) AS seen FROM sessions WHERE expires_at > ? GROUP BY user_id"),
    sessionPurge: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
    lastLogin: db.prepare("UPDATE users SET last_login = ? WHERE id = ?"),
    setPw: db.prepare("UPDATE users SET pw_hash = ?, must_change_pw = ? WHERE id = ?"),
    update: db.prepare("UPDATE users SET name = ?, dept = ?, role = ?, position = ?, status = ? WHERE id = ?"),
    del: db.prepare("DELETE FROM users WHERE id = ?"),
    devs: db.prepare("SELECT id FROM users WHERE role = 'developer' AND status = 'active' ORDER BY created_at")
  };
  const publicUser = (u) => u && ({
    id: u.id, username: u.username, name: u.name, dept: u.dept, role: u.role, position: u.position || "", tier: tierOf(u),
    title: [u.role === "developer" ? "개발자" : "", u.position ? POSITION_LABEL[u.position] + (u.position === "vice_lead" ? " (총무)" : "") : (u.role === "developer" ? "" : "팀원")].filter(Boolean).join(" · "),
    treasurer: u.position === "vice_lead", status: u.status, mustChangePassword: !!u.must_change_pw, createdAt: u.created_at, lastLogin: u.last_login
  });
  return {
    publicUser,
    count: () => q.count.get().n,
    byUsername: (u) => q.byName.get(u),
    byId: (id) => q.byId.get(id),
    list: () => q.all.all(),
    activeDevelopers: () => q.devs.all().map((r) => r.id),
    // Takes a hash from hashPassword (awaited by the caller first), so the checks before an insert and the insert
    // itself run without a pause in between: two sign-ups at once cannot both become the first account.
    create({ username, name, dept, role, position = "", status, pwHash, mustChange = false }) {
      const id = newId("u_");
      q.insert.run(id, username, name, dept || "", role, position, status, pwHash, mustChange ? 1 : 0, new Date().toISOString());
      return q.byId.get(id);
    },
    update(id, { name, dept, role, position, status }) {
      const u = q.byId.get(id);
      q.update.run(name ?? u.name, dept ?? u.dept, role ?? u.role, position ?? u.position ?? "", status ?? u.status, id);
      return q.byId.get(id);
    },
    remove: (id) => q.del.run(id),
    setPassword(id, pwHash, mustChange = false) { q.setPw.run(pwHash, mustChange ? 1 : 0, id); },
    startSession(userId, ip, ua) {
      const token = crypto.randomBytes(32).toString("base64url"), now = new Date();
      q.sessionInsert.run(sha256(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString(), now.toISOString(), ip || null, String(ua || "").slice(0, 200));
      q.lastLogin.run(now.toISOString(), userId);
      return { token, maxAge: SESSION_DAYS * 86400 };
    },
    sessionUser(token) {
      if (!token) return null;
      const h = sha256(token), s = q.sessionGet.get(h);
      if (!s) return null;
      if (s.expires_at < new Date().toISOString()) { q.sessionDel.run(h); return null; }
      if (s.status !== "active") return null;
      const now = new Date().toISOString();
      if (!s.last_seen || now.slice(0, 15) !== s.last_seen.slice(0, 15)) q.sessionTouch.run(now, h);
      return { ...s, tokenHash: h };
    },
    endSession: (token) => token && q.sessionDel.run(sha256(token)),
    endAllSessions: (userId) => q.sessionDelUser.run(userId),
    endOtherSessions: (userId, tokenHash) => q.sessionDelOthers.run(userId, tokenHash),
    sessionStats: () => Object.fromEntries(q.sessionCount.all(new Date().toISOString()).map((r) => [r.user_id, { sessions: r.n, lastSeen: r.seen }])),
    purgeSessions: () => q.sessionPurge.run(new Date().toISOString())
  };
}
