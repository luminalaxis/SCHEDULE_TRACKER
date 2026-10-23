// 사비 내역서 양식 검사 on the server. It runs the page's own rules script (window.FSKExpenseRules in index.html) with the
// same JSZip the page loads, so a submission is checked by exactly the code the submitter's browser ran, but on the
// file the server actually stores. Only DOMParser is missing in Node; parseXml below stands in for it.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import crypto from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_PART = 16 * 1024 * 1024;   // largest xml part we unpack, so a zip bomb cannot fill the Pi's memory

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
  if (e[0] !== "#") return ENT[e] ?? m;
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
const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</g;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
export function parseXml(text) {
  const doc = new XmlNode(null, {}, null);
  let cur = doc, m;
  const src = String(text).replace(/\r\n?/g, "\n");
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    if (m[1] !== undefined) cur.childNodes.push(m[1]);
    else if (m[2] !== undefined) { for (let n = cur; n !== doc; n = n.parentNode) if (n.nodeName === m[2]) { cur = n.parentNode; break; } }
    else if (m[3] !== undefined) {
      const attrs = {};
      for (const a of (m[4] || "").matchAll(ATTR)) attrs[a[1]] = decode((a[2] ?? a[3]).replace(/[\t\n]/g, " "));
      const el = new XmlNode(m[3], attrs, cur);
      cur.childNodes.push(el);
      if (!m[5]) cur = el;
    } else if (m[6] !== undefined && cur !== doc) cur.childNodes.push(decode(m[6]));
  }
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
// Today in Korea, so "날짜가 오늘 이후" agrees with what the team's browsers said whatever the server's time zone is.
const todayKst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// Checks one statement. Returns the fields a submission stores (items, total, teams, accountMasked, check) plus the
// file's hash and size. A file that cannot be read comes back as 양식 불일치 rather than throwing.
export async function checkExpenseFile(html, buf, fileName, today = todayKst()) {
  const R = rulesOf(html);
  let res;
  try {
    let zip;
    try { zip = await JSZip.loadAsync(buf); } catch { throw { user: "xlsx 파일을 열 수 없어요. 파일이 손상됐거나 암호가 걸려 있을 수 있어요." }; }
    const guarded = { file: (path) => {
      const f = zip.file(path);
      if (f && f._data && f._data.uncompressedSize > MAX_PART) throw { user: "파일 안의 표 데이터가 너무 커요. 동아리 양식 파일인지 확인해 주세요." };
      return f;
    } };
    res = R.checkStatement(await R.readWorkbook(guarded, parseXml), String(fileName || ""), today);
  } catch (e) {
    const msg = e && typeof e.user === "string" ? e.user : "파일을 읽을 수 없어요. 동아리 양식의 xlsx 파일인지 확인해 주세요.";
    res = { level: "bad", errors: [msg], warns: [], infos: [], items: [], total: 0, account: "" };
  }
  // copy out of the vm realm so the stored values are plain objects of this one
  const summary = JSON.parse(JSON.stringify(R.summarize(res)));
  return { ...summary, hash: crypto.createHash("sha256").update(buf).digest("hex"), fileSize: buf.length };
}
