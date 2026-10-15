// SQLite-backed document store with the same path grammar and access rules as the claude.ai Artifact db.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const ROLE_LEVEL = { developer: 4, treasurer: 3, member: 2, viewer: 1 };
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

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function openStore(dataDir) {
  mkdirSync(join(dataDir, "assets"), { recursive: true });
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  const db = new DatabaseSync(join(dataDir, "fsk.db"));
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
  `);
  return db;
}

export function createDocs(db) {
  const q = {
    get: db.prepare("SELECT path, data, version, updated_at, updated_by FROM docs WHERE path = ?"),
    list: db.prepare("SELECT path, data, version, updated_at, updated_by FROM docs WHERE collection = ?"),
    upsert: db.prepare(`INSERT INTO docs (path, collection, data, version, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(path) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    del: db.prepare("DELETE FROM docs WHERE path = ?"),
    all: db.prepare("SELECT path, collection, data, version, updated_at, updated_by FROM docs ORDER BY path"),
    counts: db.prepare("SELECT collection, COUNT(*) AS n, SUM(LENGTH(data)) AS bytes, MAX(updated_at) AS last FROM docs GROUP BY collection ORDER BY collection"),
    wipe: db.prepare("DELETE FROM docs"),
    restoreRow: db.prepare("INSERT OR REPLACE INTO docs (path, collection, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)")
  };
  const row = (r) => r && { path: r.path, id: r.path.split("/").pop(), data: JSON.parse(r.data), version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by };
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
      q.upsert.run(path, collectionOf(path), json, new Date().toISOString(), by || null);
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
      q.restoreRow.run(r.path, collectionOf(r.path), JSON.stringify(r.data), Number(r.version) || 1, r.updatedAt || new Date().toISOString(), r.updatedBy || "import");
    }
  };
}

// Access rules: the same declaration the Artifact uses (artifact.config.json → capabilities.db.rules).
// Levels: view < interact < admin < owner. Roles map to levels: viewer 1, member 2, treasurer 3, developer 4.
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
    canRead(user, path) { return !!user && effective(path, user.id).read <= (ROLE_LEVEL[user.role] || 0); },
    canWrite(user, path) { return !!user && effective(path, user.id).write <= (ROLE_LEVEL[user.role] || 0); }
  };
}

// Query evaluation for where/orderBy/limit, matching the Artifact db operators.
export function runQuery(docs, { where = [], orderBy = null, limit = null } = {}) {
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
