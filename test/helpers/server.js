// Starts the real server on a temp data dir for a test file, and a tiny HTTP client that keeps a session cookie.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function startServer(env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "fsk-test-"));
  const port = 18000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "server/server.js")], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ...env }, stdio: "pipe" });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; }); proc.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/healthz")).ok) return { base, port, dataDir, log: () => log, stop: () => { proc.kill(); rmSync(dataDir, { recursive: true, force: true }); } }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("server did not start\n" + log);
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ""; }
  async req(method, path, body, headers = {}) {
    const h = { "x-fsk": "1", ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload;
    if (body instanceof Buffer) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
    const r = await fetch(this.base + path, { method, headers: h, body: payload, redirect: "manual" });
    const set = r.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const buf = Buffer.from(await r.arrayBuffer()), text = buf.toString("utf8");
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, buf, headers: r.headers };
  }
  get(p) { return this.req("GET", p); }
  post(p, b, h) { return this.req("POST", p, b, h); }
}

// Signs up `username` and, when a developer client is given, approves it with the given position/department.
export async function member(base, dev, username, name, { position = "", dept = "" } = {}) {
  const c = new Client(base);
  const r = await c.post("/api/auth/signup", { username, password: "password-" + username, name, dept, agree: true });
  if (r.status !== 200) throw new Error(`signup ${username}: ${r.status} ${r.text}`);
  if (dev) {
    const users = (await dev.get("/api/admin/users")).json.users;
    const id = users.find((u) => u.username === username).id;
    const a = await dev.post(`/api/admin/users/${id}`, { status: "active", position, dept });
    if (a.status !== 200) throw new Error(`approve ${username}: ${a.status} ${a.text}`);
    await c.post("/api/auth/login", { username, password: "password-" + username });
  }
  c.id = (await c.get("/api/me")).json.id; c.name = name;
  return c;
}

export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
