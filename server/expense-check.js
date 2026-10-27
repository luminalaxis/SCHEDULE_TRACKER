// 사비 내역서 양식 검사 on the server. It runs the page's own rules script (window.FSKExpenseRules in index.html) with the
// same JSZip the page loads, so a submission is checked by exactly the code the submitter's browser ran, but on the
// file the server actually stores. Only DOMParser is missing in Node; parseXml below stands in for it.
// The check itself runs in a worker thread (expense-worker.js) with its own memory cap, so unpacking and reading a
// workbook never stalls the server's other requests, and a file that still takes too long is given up on.
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
// A club statement's xml parts are a few hundred KB at most. These keep a zip bomb from filling the Pi's memory.
const MAX_PART = 4 * 1024 * 1024, MAX_UNPACKED = 16 * 1024 * 1024;
const MAX_SUMMARY = 48 * 1024;        // what one submission may add to the submitter's document (256 KiB in all)

const CHECK_TIMEOUT = 30000, WORKER_HEAP_MB = 256;

// The vendored file is UMD: given module/exports it hands JSZip back instead of setting a global. Loaded only where
// workbooks are read (the worker).
let JSZipLib = null;
const jszip = () => {
  if (!JSZipLib) {
    const mod = { exports: {} };
    new Function("module", "exports", readFileSync(join(HERE, "public", "vendor", "jszip.min.js"), "utf8"))(mod, mod.exports);
    JSZipLib = mod.exports;
  }
  return JSZipLib;
};

// ---------- a small XML DOM ----------
// Just what the reader uses: getElementsByTagNameNS("*", name), getAttribute, getAttributeNS, textContent, parentNode
// and localName. xlsx parts are machine-written, so this is a tokenizer, not a validating parser.
const ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== "#") return Object.hasOwn(ENT, e) ? ENT[e] : m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
class XmlNode {
  constructor(name, attrs, parent) {
    this.nodeName = name; this.localName = name ? name.slice(name.indexOf(":") + 1) : null;
    this.attrs = attrs; this.parentNode = parent; this.childNodes = [];
    this.ns = parent ? parent.ns : {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith("xmlns:")) { if (this.ns === parent?.ns) this.ns = { ...this.ns }; this.ns[k.slice(6)] = v; }
  }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  getAttributeNS(uri, local) {
    for (const [k, v] of Object.entries(this.attrs)) { const i = k.indexOf(":"); if (i > 0 && k.slice(i + 1) === local && k.slice(0, i) !== "xmlns" && this.ns[k.slice(0, i)] === uri) return v; }
    return null;
  }
  get textContent() {
    let out = "";
    const stack = [...this.childNodes].reverse();
    while (stack.length) { const n = stack.pop(); if (typeof n === "string") out += n; else for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]); }
    return out;
  }
  getElementsByTagNameNS(_uri, local) {
    const out = [], stack = [...this.childNodes].reverse();
    while (stack.length) {
      const n = stack.pop(); if (typeof n === "string") continue;
      if (local === "*" || n.localName === local) out.push(n);
      for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
    }
    return out;
  }
}
// One pass with indexOf, no backtracking regexes: a crafted part cannot make it slow. Malformed XML, more than
// MAX_DEPTH levels or MAX_NODES elements throws (the check then reports the file as unreadable).
const MAX_DEPTH = 64, MAX_NODES = 200000;
const isSpace = (c) => c === " " || c === "\n" || c === "\t" || c === "\r";
const malformed = () => { throw { user: "파일 안의 XML이 깨져 있어요. 엑셀이나 한셀에서 다시 저장해 주세요." }; };
function parseTag(src, start, end, parent) {
  let i = start;
  while (i < end && !isSpace(src[i]) && src[i] !== "/") i++;
  const name = src.slice(start, i), attrs = {};
  if (!name) malformed();
  for (;;) {
    while (i < end && isSpace(src[i])) i++;
    if (i >= end || src[i] === "/") break;
    const n0 = i;
    while (i < end && !isSpace(src[i]) && src[i] !== "=") i++;
    const key = src.slice(n0, i);
    while (i < end && isSpace(src[i])) i++;
    if (!key || src[i] !== "=") malformed();
    i++;
    while (i < end && isSpace(src[i])) i++;
    const q = src[i];
    if (q !== '"' && q !== "'") malformed();
    const close = src.indexOf(q, i + 1);
    if (close < 0 || close >= end) malformed();
    attrs[key] = decode(src.slice(i + 1, close).replace(/[\t\n]/g, " "));
    i = close + 1;
  }
  return new XmlNode(name, attrs, parent);
}
export function parseXml(text) {
  const src = String(text).replace(/\r\n?/g, "\n"), n = src.length, doc = new XmlNode(null, {}, null);
  let cur = doc, depth = 0, nodes = 0, i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { if (cur !== doc) cur.childNodes.push(decode(src.slice(i))); break; }
    if (lt > i && cur !== doc) cur.childNodes.push(decode(src.slice(i, lt)));
    const skipTo = (marker, from) => { const e = src.indexOf(marker, from); if (e < 0) malformed(); return e + marker.length; };
    if (src.startsWith("<!--", lt)) { i = skipTo("-->", lt + 4); continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = skipTo("]]>", lt + 9); if (cur !== doc) cur.childNodes.push(src.slice(lt + 9, e - 3)); i = e; continue; }
    if (src.startsWith("<?", lt)) { i = skipTo("?>", lt + 2); continue; }
    if (src.startsWith("<!", lt)) { i = skipTo(">", lt + 2); continue; }
    // the tag ends at the first '>' outside a quoted attribute value
    let gt = lt + 1, quote = "";
    for (; gt < n; gt++) { const c = src[gt]; if (quote) { if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === ">") break; }
    if (gt >= n) malformed();
    if (src[lt + 1] === "/") {
      const name = src.slice(lt + 2, gt).trim();
      if (cur === doc || cur.nodeName !== name) malformed();
      cur = cur.parentNode; depth--;
    } else {
      const selfClosing = src[gt - 1] === "/";
      const el = parseTag(src, lt + 1, selfClosing ? gt - 1 : gt, cur);
      if (++nodes > MAX_NODES) throw { user: "파일 안의 표 데이터가 너무 커요. 동아리 양식 파일인지 확인해 주세요." };
      cur.childNodes.push(el);
      if (!selfClosing) { if (++depth > MAX_DEPTH) malformed(); cur = el; }
    }
    i = gt + 1;
  }
  if (cur !== doc) malformed();
  return doc;
}

// ---------- the check ----------
// Rules come from index.html, re-read when the page changes (the server already caches it by mtime).
let scriptFor = { html: null, src: null };
function rulesScript(html) {
  if (scriptFor.html !== html) {
    const m = html.match(/<script>\s*(\/\/ 사비 내역서 양식 규칙[\s\S]*?)<\/script>/);
    if (!m) throw new Error("index.html has no 사비 내역서 rules script");
    scriptFor = { html, src: m[1] };
  }
  return scriptFor.src;
}
let rulesFor = { src: null, rules: null };
function rulesOf(src) {
  if (rulesFor.src !== src) {
    const ctx = { window: {} };
    vm.runInNewContext(src, ctx);
    rulesFor = { src, rules: ctx.window.FSKExpenseRules };
  }
  return rulesFor.rules;
}
// Today in Korea, so "날짜가 오늘 이후" agrees with what the team's browsers said whatever the server's time zone is.
const todayKst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// Checks one statement. Returns the fields a submission stores (items, total, teams, accountMasked, check) plus the
// file's hash and size. A file that cannot be read comes back as 양식 불일치 rather than throwing.
// Checks run one at a time, so many uploads at once cannot multiply the memory a check needs.
let queue = Promise.resolve();
export function checkExpenseFile(html, buf, fileName, today = todayKst()) {
  const src = rulesScript(html);
  const run = queue.then(() => inWorker(src, buf, fileName, today));
  queue = run.catch(() => {});
  return run;
}
const unreadable = (msg) => ({ level: "bad", errors: [msg], warns: [], infos: [], items: [], total: 0, account: "" });
const hashOf = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// What a submission stores when the worker gave up on the file (too slow, or over its memory cap).
const failed = (src, buf, msg) => ({ ...JSON.parse(JSON.stringify(rulesOf(src).summarize(unreadable(msg)))), hash: hashOf(buf), fileSize: buf.length });

// ---------- the worker ----------
let worker = null, jobs = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  const w = new Worker(new URL("./expense-worker.js", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
  w.unref();
  const fail = (err) => {
    if (worker === w) worker = null;
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  };
  w.on("message", ({ id, result, error }) => {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  });
  w.on("error", fail);
  w.on("exit", () => fail(new Error("worker stopped")));
  return (worker = w);
}
async function inWorker(src, buf, fileName, today) {
  const w = getWorker(), id = ++jobs, bytes = new Uint8Array(buf);
  let timer;
  w.ref();   // keep the process alive while a check is running (the idle worker does not)
  try {
    const done = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT); });
    w.postMessage({ id, src, bytes, fileName, today }, [bytes.buffer]);
    return await Promise.race([done, late]);
  } catch (e) {
    pending.delete(id);
    if (e && e.message === "timeout") { await w.terminate(); return failed(src, buf, "파일을 확인하는 데 너무 오래 걸려요. 동아리 양식 파일인지 확인해 주세요."); }
    if (worker !== w || (e && e.message === "worker stopped")) return failed(src, buf, "파일이 너무 커서 확인할 수 없어요. 동아리 양식 파일인지 확인해 주세요.");
    throw e;
  } finally {
    clearTimeout(timer);
    if (worker === w) w.unref();
  }
}

// Runs inside the worker.
export async function checkInline(src, buf, fileName, today) {
  const R = rulesOf(src);
  let res;
  try {
    let zip, unpacked = 0;
    try { zip = await jszip().loadAsync(buf); } catch { throw { user: "xlsx 파일을 열 수 없어요. 파일이 손상됐거나 암호가 걸려 있을 수 있어요." }; }
    const guarded = { file: (path) => {
      const f = zip.file(path), size = f && f._data ? f._data.uncompressedSize : 0;
      if (f && (!(size >= 0) || size > MAX_PART || (unpacked += size) > MAX_UNPACKED)) throw { user: "파일 안의 표 데이터가 너무 커요. 동아리 양식 파일인지 확인해 주세요." };
      return f;
    } };
    res = R.checkStatement(await R.readWorkbook(guarded, parseXml), String(fileName || "").slice(0, 200), today);
  } catch (e) {
    res = unreadable(e && typeof e.user === "string" ? e.user : "파일을 읽을 수 없어요. 동아리 양식의 xlsx 파일인지 확인해 주세요.");
  }
  // copy out of the vm realm so the stored values are plain objects of this one
  let summary = JSON.parse(JSON.stringify(R.summarize(res)));
  if (JSON.stringify(summary).length > MAX_SUMMARY) summary = JSON.parse(JSON.stringify(R.summarize(unreadable("칸에 적힌 내용이 너무 길어요. 동아리 양식대로 짧게 적어 주세요."))));
  return { ...summary, hash: hashOf(buf), fileSize: buf.length };
}
