// 주행 기록 분석 보고서 on the self-hosted server. It runs the page's own export rules (window.FSKRuns in index.html),
// so the report reads every record exactly as the page and its 노션용 CSV do. The work (reading data logger CSVs,
// statistics, writing the xlsx) happens in a worker thread with its own memory cap and a time limit, so a big export
// never stalls the Pi's other requests, and only one report is made at a time.
import { Worker } from "node:worker_threads";
import vm from "node:vm";

const TIMEOUT = 120000, WORKER_HEAP_MB = 384;
// Logger files the worker may read for one report (each attachment is at most 20MB already).
export const LOGGER_LIMITS = { files: 200, bytes: 200 * 1024 * 1024 };

let scriptFor = { html: null, src: null };
export function runsScript(html) {
  if (scriptFor.html !== html) {
    const m = html.match(/<script>\s*(\/\/ 주행 기록 내보내기 규칙[\s\S]*?)<\/script>/);
    if (!m) throw new Error("index.html has no 주행 기록 내보내기 rules script");
    scriptFor = { html, src: m[1] };
  }
  return scriptFor.src;
}
let rulesFor = { src: null, rules: null };
export function runsRules(html) {
  const src = runsScript(html);
  if (rulesFor.src !== src) {
    const ctx = { window: {} };
    vm.runInNewContext(src, ctx);
    rulesFor = { src, rules: ctx.window.FSKRuns };
  }
  return rulesFor.rules;
}

export class ReportBusy extends Error {}
let busy = false;
// data: { sessions, logs, checks, comments, parts, carName }; files: [{ logId, name, path }] or null (no logger sheet);
// opts: filters plus today / generatedAt. Resolves to the xlsx as a Buffer.
export async function buildRunReport(html, data, files, opts) {
  if (busy) throw new ReportBusy("busy");
  busy = true;
  const src = runsScript(html);
  const w = new Worker(new URL("./runs-worker.js", import.meta.url), { workerData: { src, data, files, opts }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT);
      w.once("message", (m) => (m && m.error ? reject(new Error(m.error)) : resolve(Buffer.from(m.bytes))));
      w.once("error", reject);
      w.once("exit", (code) => reject(new Error(`worker stopped (${code})`)));
    });
  } finally {
    clearTimeout(timer);
    busy = false;
    w.terminate().catch(() => {});
  }
}
