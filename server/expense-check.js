// 사비 내역서 양식 검사 on the server. It runs the page's own rules script (window.FSKExpenseRules in index.html) with the
// same JSZip the page loads, so a submission is checked by exactly the code the submitter's browser ran, but on the
// file the server actually stores. Only DOMParser is missing in Node; parseXml below stands in for it.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
// A club statement's xml parts are a few hundred KB at most. These keep a zip bomb from filling the Pi's memory.
const MAX_PART = 4 * 1024 * 1024, MAX_UNPACKED = 16 * 1024 * 1024;
const MAX_SUMMARY = 48 * 1024;        // what one submission may add to the submitter's document (256 KiB in all)

// The vendored file is UMD: given module/exports it hands JSZip back instead of setting a global.
const JSZip = (() => {
  const mod = { exports: {} };
  new Function("module", "exports", readFileSync(join(HERE, "public", "vendor", "jszip.min.js"), "utf8"))(mod, mod.exports);
  return mod.exports;
})();

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
let rulesFor = { html: null, rules: null };
function rulesOf(html) {
  if (rulesFor.html !== html) {
    const m = html.match(/<script>\s*(\/\/ 사비 내역서 양식 규칙[\s\S]*?)<\/script>/);
    if (!m) throw new Error("index.html has no 사비 내역서 rules script");
    const ctx = { window: {} };
    vm.runInNewContext(m[1], ctx);
    rulesFor = { html, rules: ctx.window.FSKExpenseRules };
  }
  return rulesFor.rules;
}
// An index.html from before the server check (e.g. copied back from the claude.ai Artifact) has rules without
// readWorkbook/summarize. Returns what is wrong, or "" when the page's rules are usable here.
export function rulesProblem(html) {
  let R;
  try { R = rulesOf(html); } catch { return "index.html 에 사비 내역서 양식 규칙이 없어요."; }
  const missing = ["checkStatement", "readWorkbook", "summarize"].filter((k) => typeof (R && R[k]) !== "function");
  return missing.length ? `index.html 이 서버 코드보다 오래된 버전이에요 (양식 규칙에 ${missing.join(", ")} 없음).` : "";
}
// Today in Korea, so "날짜가 오늘 이후" agrees with what the team's browsers said whatever the server's time zone is.
const todayKst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// Checks one statement. Returns the fields a submission stores (items, total, teams, accountMasked, check) plus the
// file's hash and size. A file that cannot be read comes back as 양식 불일치 rather than throwing.
// Checks run one at a time, so many uploads at once cannot multiply the memory a check needs.
let queue = Promise.resolve();
export function checkExpenseFile(html, buf, fileName, today = todayKst()) {
  const run = queue.then(() => checkNow(html, buf, fileName, today));
  queue = run.catch(() => {});
  return run;
}
const unreadable = (msg) => ({ level: "bad", errors: [msg], warns: [], infos: [], items: [], total: 0, account: "" });
async function checkNow(html, buf, fileName, today) {
  const R = rulesOf(html);
  let res;
  try {
    let zip, unpacked = 0;
    try { zip = await JSZip.loadAsync(buf); } catch { throw { user: "xlsx 파일을 열 수 없어요. 파일이 손상됐거나 암호가 걸려 있을 수 있어요." }; }
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
  return { ...summary, hash: crypto.createHash("sha256").update(buf).digest("hex"), fileSize: buf.length };
}
