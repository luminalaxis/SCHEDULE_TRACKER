// SQLite-backed document store with the same path grammar and access rules as the claude.ai Artifact db.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

// Organization: 개발자 (developer) > 임원진 (executive: 팀장·부팀장·파트장) > 팀원 (member).
// role is "developer" or "member"; position is "", "team_lead", "vice_lead" (부팀장, also the treasurer) or "part_lead".
// Access levels follow the Artifact db levels: member → interact (2), executive → admin (3), developer → owner (4).
export const POSITIONS = ["", "team_lead", "vice_lead", "part_lead"];
export const levelOf = (u) => !u ? 0 : u.role === "developer" ? 4 : u.position ? 3 : 2;
const LEVEL = { view: 1, interact: 2, admin: 3, owner: 4 };
const SEGMENT = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
export const MAX_DOC_BYTES = 256 * 1024;

export class StoreError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function splitPath(path, kind) {
  if (typeof path !== "string" || !path || path.length > 1000) throw new StoreError("invalid_argument", "path is missing or too long");
  const segs = path.split("/");
  if (segs.length > 16 || segs.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) throw new StoreError("invalid_argument", `bad path: ${path}`);
  if (kind === "doc" && segs.length % 2 !== 0) throw new StoreError("invalid_argument", `not a document path: ${path}`);
  if (kind === "collection" && segs.length % 2 !== 1) throw new StoreError("invalid_argument", `not a collection path: ${path}`);
  return segs;
}

// JSON with object keys sorted, so two equal documents compare equal whatever their key order.
export const stableJson = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x);

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function openStore(dataDir) {
  // The data folder holds payment details and password hashes: keep it private to the server's user.
  for (const d of [dataDir, join(dataDir, "assets"), join(dataDir, "backups")]) { mkdirSync(d, { recursive: true, mode: 0o700 }); try { chmodSync(d, 0o700); } catch {} }
  const db = new DatabaseSync(join(dataDir, "fsk.db"));
  try { chmodSync(join(dataDir, "fsk.db"), 0o600); } catch {}
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS docs_collection ON docs(collection);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dept TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL, status TEXT NOT NULL, pw_hash TEXT NOT NULL, must_change_pw INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT, ip TEXT, ua TEXT
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, content_type TEXT NOT NULL, size INTEGER NOT NULL, uploader TEXT, name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, actor_name TEXT, action TEXT NOT NULL,
      target TEXT, detail TEXT, ip TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, read_at TEXT, dedupe TEXT,
      UNIQUE (user_id, dedupe)
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id);
    CREATE TABLE IF NOT EXISTS notify_log (dedupe TEXT PRIMARY KEY, at TEXT NOT NULL);
  `);
  // v1.0 → v1.1: roles became developer/member + position. Old treasurers become 부팀장, old viewers become members.
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "position")) {
    db.exec("ALTER TABLE users ADD COLUMN position TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE users SET role = 'member', position = 'vice_lead' WHERE role = 'treasurer'");
    db.exec("UPDATE users SET role = 'member' WHERE role NOT IN ('developer', 'member')");
  }
  // v1.1 → v1.2: remember who created each document (notifications go to a log's author, not its last editor).
  if (!db.prepare("PRAGMA table_info(docs)").all().some((c) => c.name === "created_by")) db.exec("ALTER TABLE docs ADD COLUMN created_by TEXT");
  return db;
}

export function createDocs(db) {
  const q = {
    get: db.prepare("SELECT path, data, version, updated_at, updated_by, created_by FROM docs WHERE path = ?"),
    list: db.prepare("SELECT path, data, version, updated_at, updated_by, created_by FROM docs WHERE collection = ?"),
    upsert: db.prepare(`INSERT INTO docs (path, collection, data, version, updated_at, updated_by, created_by) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    del: db.prepare("DELETE FROM docs WHERE path = ?"),
    all: db.prepare("SELECT path, collection, data, version, updated_at, updated_by, created_by FROM docs ORDER BY path"),
    counts: db.prepare("SELECT collection, COUNT(*) AS n, SUM(LENGTH(data)) AS bytes, MAX(updated_at) AS last FROM docs GROUP BY collection ORDER BY collection"),
    wipe: db.prepare("DELETE FROM docs"),
    restoreRow: db.prepare("INSERT OR REPLACE INTO docs (path, collection, data, version, updated_at, updated_by, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
  };
  const row = (r) => r && { path: r.path, id: r.path.split("/").pop(), data: JSON.parse(r.data), version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by, createdBy: r.created_by || r.updated_by };
  const collectionOf = (path) => path.split("/").slice(0, -1).join("/");
  return {
    collectionOf,
    get(path) { splitPath(path, "doc"); return row(q.get.get(path)); },
    list(collection) { splitPath(collection, "collection"); return q.list.all(collection).map(row); },
    set(path, data, by) {
      splitPath(path, "doc");
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new StoreError("invalid_argument", "document body must be an object");
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json) > MAX_DOC_BYTES) throw new StoreError("invalid_argument", "document is over 256 KiB");
      q.upsert.run(path, collectionOf(path), json, new Date().toISOString(), by || null, by || null);
      return row(q.get.get(path));
    },
    update(path, patch, by) {
      const cur = this.get(path);
      if (!cur) throw new StoreError("invalid_argument", "update needs an existing document");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new StoreError("invalid_argument", "patch must be an object");
      return this.set(path, deepMerge(cur.data, patch), by);
    },
    remove(path) { splitPath(path, "doc"); q.del.run(path); },
    all() { return q.all.all().map((r) => ({ ...row(r), collection: r.collection })); },
    counts() { return q.counts.all(); },
    replaceAll(rows) {
      db.exec("BEGIN");
      try {
        q.wipe.run();
        for (const r of rows) this.restoreOne(r);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    mergeAll(rows) {
      db.exec("BEGIN");
      try { for (const r of rows) this.restoreOne(r); db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    restoreOne(r) {
      splitPath(r.path, "doc");
      if (!r.data || typeof r.data !== "object" || Array.isArray(r.data)) throw new StoreError("invalid_argument", `bad document at ${r.path}`);
      q.restoreRow.run(r.path, collectionOf(r.path), JSON.stringify(r.data), Number(r.version) || 1, r.updatedAt || new Date().toISOString(), r.updatedBy || "import", r.createdBy || r.updatedBy || "import");
    }
  };
}

// Access rules: the same declaration the Artifact uses (artifact.config.json → capabilities.db.rules).
// Levels: view < interact < admin < owner. Users map to levels with levelOf().
export function createRules(rules) {
  const parsed = (rules || []).map((r) => ({ segs: r.path ? r.path.split("/") : [], read: r.read ? LEVEL[r.read] : null, write: r.write ? LEVEL[r.write] : null }))
    .sort((a, b) => a.segs.length - b.segs.length);
  function effective(path, uid) {
    const segs = path.split("/");
    let read = LEVEL.view, write = LEVEL.interact;
    // data/users/<id>/ is private to that user unless a rule opens it (Artifact default).
    if (segs[0] === "data" && segs[1] === "users" && segs.length >= 3 && segs[2] !== uid) {
      const opened = parsed.some((r) => r.segs.length === 2 && r.segs[0] === "data" && r.segs[1] === "users");
      if (!opened) return { read: Infinity, write: Infinity };
    }
    for (const r of parsed) {
      if (r.segs.length > segs.length) continue;
      const match = r.segs.every((s, i) => s === "{self}" ? segs[i] === uid : s === segs[i]);
      if (!match) continue;
      if (r.read !== null) read = r.read;
      if (r.write !== null) write = r.write;
    }
    return { read, write: Math.max(write, read) };
  }
  return {
    canRead(user, path) { return !!user && effective(path, user.id).read <= levelOf(user); },
    canWrite(user, path) { return !!user && effective(path, user.id).write <= levelOf(user); }
  };
}

// Query evaluation for where/orderBy/limit, matching the Artifact db operators.
export function runQuery(docs, { where = [], orderBy = null, limit = null } = {}) {
  if (!Array.isArray(where) || where.some((w) => !Array.isArray(w) || w.length !== 3 || typeof w[0] !== "string")) throw new StoreError("invalid_argument", "where must be a list of [field, op, value]");
  if (orderBy !== null && (typeof orderBy !== "object" || Array.isArray(orderBy))) throw new StoreError("invalid_argument", "orderBy must be { field, dir }");
  const cmp = (a, b) => (a === b ? 0 : a === undefined || a === null ? 1 : b === undefined || b === null ? -1 : a < b ? -1 : 1);
  let out = docs.filter((d) => where.every(([f, op, v]) => {
    const x = d.data[f];
    switch (op) {
      case "==": return x === v;
      case "!=": return x !== v;
      case "<": return x < v;
      case "<=": return x <= v;
      case ">": return x > v;
      case ">=": return x >= v;
      case "in": return Array.isArray(v) && v.includes(x);
      case "not-in": return Array.isArray(v) && !v.includes(x);
      case "array-contains": return Array.isArray(x) && x.includes(v);
      default: throw new StoreError("invalid_argument", `unknown operator ${op}`);
    }
  }));
  if (orderBy && orderBy.field) {
    const dir = orderBy.dir === "desc" ? -1 : 1;
    out.sort((a, b) => {
      const av = a.data[orderBy.field], bv = b.data[orderBy.field];
      if (av === undefined && bv === undefined) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return dir * cmp(av, bv);
    });
  } else out.sort((a, b) => cmp(a.id, b.id));
  if (limit) out = out.slice(0, Math.max(1, Math.min(1000, Number(limit) || 1000)));
  return out;
}
