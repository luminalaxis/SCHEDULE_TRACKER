// Worker thread for the 주행 기록 분석 보고서 (see runs-export.js): reads the logger files, runs the page's report rules
// and writes the xlsx, then posts the bytes back and exits.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));

// The vendored JSZip is UMD: given module/exports it hands JSZip back instead of setting a global.
function jszip() {
  const mod = { exports: {} };
  new Function("module", "exports", readFileSync(join(HERE, "public", "vendor", "jszip.min.js"), "utf8"))(mod, mod.exports);
  return mod.exports;
}
// Logger files are UTF-8 (with or without a BOM); Korean Excel saves CSV as EUC-KR.
function decode(buf) {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  if (!utf8.includes("�")) return utf8;
  try { return new TextDecoder("euc-kr").decode(buf); } catch { return utf8; }
}

try {
  const { src, data, files, opts } = workerData;
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx);
  const R = ctx.window.FSKRuns;
  const loggers = Array.isArray(files) ? files.map((f) => {
    if (f.skip) return { logId: f.logId, name: f.name, result: { error: f.skip } };
    let result;
    try { result = R.analyzeLogger(decode(readFileSync(f.path))); } catch { result = { error: "파일을 읽을 수 없어요." }; }
    return { logId: f.logId, name: f.name, result };
  }) : undefined;
  const sheets = R.report({ ...data, loggers }, opts);
  const buf = await R.xlsxBook(sheets, { JSZip: jszip(), type: "nodebuffer" });
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
  parentPort.postMessage({ bytes }, [bytes.buffer]);
} catch (e) {
  parentPort.postMessage({ error: String((e && e.message) || e) });
}
