// Streaming .tar.gz writer and reader for full backups (data + attachment files), no dependencies.
// ustar format: 512-byte headers, file data padded to 512 bytes, two zero blocks at the end.
import { createReadStream, openSync, writeSync, closeSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const BLOCK = 512;
const MAX_JSON = 512 * 1024 * 1024;

function header(name, size, mtime) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const put = (str, off, len) => h.write(str, off, len, "utf8");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(0o600, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor((mtime || Date.now()) / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
const pad = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

// entries: iterable of { name, data: Buffer } or { name, file: path, size }
async function* tarChunks(entries) {
  for (const e of entries) {
    if (e.data) {
      yield header(e.name, e.data.length, e.mtime);
      yield e.data;
      yield pad(e.data.length);
    } else {
      yield header(e.name, e.size, e.mtime);
      let n = 0;
      for await (const chunk of createReadStream(e.file)) { n += chunk.length; if (n > e.size) throw new Error(`${e.file} grew while archiving`); yield chunk; }
      if (n !== e.size) throw new Error(`${e.file} changed while archiving`);
      yield pad(e.size);
    }
  }
  yield Buffer.alloc(BLOCK * 2);
}

export async function writeTarGz(out, entries) {
  await pipeline(Readable.from(tarChunks(entries)), zlib.createGzip({ level: 1 }), out);
}

// Reads a .tar.gz stream. onEntry(name, size) returns "json" (collect the bytes, max 512 MiB),
// a file path to write the bytes to, or null to skip. Resolves to { json: Buffer|null, files: [{ name, path, size }] }.
export async function readTarGz(input, onEntry) {
  const out = { json: null, files: [] };
  let buf = Buffer.alloc(0), cur = null, ended = false;
  const startEntry = (h) => {
    const name = h.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const prefix = h.toString("utf8", 345, 500).replace(/\0.*$/s, "");
    const size = parseInt(h.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    if (!Number.isFinite(size) || size < 0) throw new Error("tar 파일이 손상됐어요.");
    const full = prefix ? `${prefix}/${name}` : name;
    const want = type === "0" || type === "\0" ? onEntry(full, size) : null;
    cur = { name: full, size, left: size, padLeft: (BLOCK - (size % BLOCK)) % BLOCK, mode: want, parts: [], fd: null };
    if (want === "json" && size > MAX_JSON) throw new Error("backup.json 이 너무 커요.");
    if (typeof want === "string" && want !== "json") cur.fd = openSync(want, "w", 0o600);
  };
  const finishEntry = () => {
    if (cur.mode === "json") out.json = Buffer.concat(cur.parts);
    else if (cur.fd !== null) { closeSync(cur.fd); out.files.push({ name: cur.name, path: cur.mode, size: cur.size }); }
    cur = null;
  };
  const gunzip = zlib.createGunzip();
  input.on("error", (e) => gunzip.destroy(e));
  input.pipe(gunzip);
  try {
    for await (const chunk of gunzip) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (!ended) {
        if (!cur) {
          if (buf.length < BLOCK) break;
          const h = buf.subarray(0, BLOCK); buf = buf.subarray(BLOCK);
          if (h.every((b) => b === 0)) { ended = true; break; }
          startEntry(h);
          if (cur.left === 0 && cur.padLeft === 0) finishEntry();
          continue;
        }
        if (cur.left > 0) {
          if (!buf.length) break;
          const take = buf.subarray(0, Math.min(cur.left, buf.length)); buf = buf.subarray(take.length); cur.left -= take.length;
          if (cur.mode === "json") cur.parts.push(Buffer.from(take));
          else if (cur.fd !== null) writeSync(cur.fd, take);
        }
        if (cur.left === 0) {
          const skip = Math.min(cur.padLeft, buf.length); buf = buf.subarray(skip); cur.padLeft -= skip;
          if (cur.padLeft === 0) finishEntry(); else break;
        }
      }
    }
  } finally { if (cur && cur.fd !== null) { try { closeSync(cur.fd); } catch {} } }
  if (cur) throw new Error("tar 파일이 중간에 끊겼어요.");
  return out;
}
