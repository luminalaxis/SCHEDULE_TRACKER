// The Raspberry Pi installer fills the systemd unit template (deploy/fsk-pitboard.service) with the account, paths and port.
// These checks keep the template and deploy/install.sh in step; they only render units and never install anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALL = join(ROOT, "deploy", "install.sh");
const hasBash = !spawnSync("bash", ["--version"]).error;
const render = (...args) => spawnSync("bash", [INSTALL, "--print-unit", ...args], { encoding: "utf8" });
const lines = (text) => new Set(text.split("\n"));

test("installer renders the unit for this account, folders and port", { skip: !hasBash && "bash not found" }, () => {
  const lan = render("--lan", "--port", "9001", "--data-dir", "/srv/fsk-data");
  assert.equal(lan.status, 0, lan.stderr);
  const l = lines(lan.stdout);
  for (const want of ["Environment=PORT=9001", "Environment=HOST=0.0.0.0", "Environment=TRUST_PROXY=0", "Environment=DATA_DIR=/srv/fsk-data",
    "ReadWritePaths=/srv/fsk-data", `WorkingDirectory=${ROOT.replace(/\/$/, "")}`, "Restart=always", "StartLimitIntervalSec=0"]) assert.ok(l.has(want), want);
  const me = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
  assert.ok(l.has(`User=${me}`), "runs as the account that installs it, not a fixed 'pi'");
  assert.match(lan.stdout, /^ExecStart=\/\S*node --disable-warning=ExperimentalWarning server\/server\.js$/m);
  assert.doesNotMatch(lan.stdout, /\/home\/pi\b/, "no leftover template paths");

  const tunnel = render("--tunnel", "--data-dir", "/srv/fsk-data");
  assert.equal(tunnel.status, 0, tunnel.stderr);
  const t = lines(tunnel.stdout);
  for (const want of ["Environment=PORT=8080", "Environment=HOST=127.0.0.1", "Environment=TRUST_PROXY=1"]) assert.ok(t.has(want), want);
});

test("installer refuses unsafe settings", { skip: !hasBash && "bash not found" }, () => {
  for (const args of [["--data-dir", join(ROOT, "data")], ["--data-dir", "/srv/fsk data"], ["--port", "80a"], ["--port", "70000"], ["--port"], ["--nope"],
    ["--data-dir", "/srv/fsk", "--backup-dir", "/srv/fsk/copy"]]) {
    const r = render(...args);
    assert.notEqual(r.status, 0, `should refuse ${args.join(" ")}`);
    assert.ok(r.stderr.trim(), `explains why it refused ${args.join(" ")}`);
  }
});

test("watchdog checks the server's health URL, which the installer rewrites for the port", () => {
  const unit = readFileSync(join(ROOT, "deploy", "fsk-pitboard-watchdog.service"), "utf8");
  assert.match(unit, /http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(unit, /systemctl is-active --quiet fsk-pitboard \|\| exit 0/, "leaves a server stopped on purpose alone");
  assert.match(readFileSync(join(ROOT, "server", "server.js"), "utf8"), /route\("GET", "\/healthz"[^\n]*auth: "none"/);
});

const hasAnalyze = hasBash && !spawnSync("systemd-analyze", ["--version"]).error;
test("systemd accepts the rendered units", { skip: !hasAnalyze && "systemd-analyze not found" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fsk-units-"));
  try {
    const r = render("--data-dir", dir);
    assert.equal(r.status, 0, r.stderr);
    writeFileSync(join(dir, "fsk-pitboard.service"), r.stdout);
    for (const f of ["fsk-pitboard-watchdog.service", "fsk-pitboard-watchdog.timer"]) copyFileSync(join(ROOT, "deploy", f), join(dir, f));
    const v = spawnSync("systemd-analyze", ["verify", "--man=no", ...["fsk-pitboard.service", "fsk-pitboard-watchdog.service", "fsk-pitboard-watchdog.timer"].map((f) => join(dir, f))], { encoding: "utf8" });
    const ours = (v.stdout + v.stderr).split("\n").filter((x) => x.includes(dir));
    assert.deepEqual(ours, [], "no warnings about our unit files");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
