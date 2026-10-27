// Backup timing and crash-safe file writes. A Raspberry Pi can lose power at any moment: a file is only renamed
// into place after its bytes are on disk, and the folder is synced so the rename itself survives.
import { openSync, closeSync, fsyncSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const pad2 = (n) => String(n).padStart(2, "0");
// Local time (the server's TZ), so file names and the daily backup hour follow the clock the team reads.
export const localStamp = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
export const localMonth = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

// Whether today's automatic backup is due: once a local day, at the first check on or after backupHour.
// names: backup file names already there (fsk-YYYYMMDD-HHMMSS-<kind>.json).
export function autoBackupDue(now, backupHour, names) {
  if (now.getHours() < backupHour) return false;
  const today = localStamp(now).slice(0, 8);
  return !names.some((n) => n.startsWith(`fsk-${today}`) && n.endsWith("-auto.json"));
}

export function syncDir(dir) {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch {}
}
export function writeFileDurable(file, data) {
  const tmp = file + ".tmp", fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  syncDir(dirname(file));
}
export function appendDurable(file, data) {
  const fd = openSync(file, "a", 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  syncDir(dirname(file));
}
