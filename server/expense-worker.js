// Worker thread for the 사비 내역서 양식 검사 (see expense-check.js): one check at a time, results posted back.
import { parentPort } from "node:worker_threads";
import { checkInline } from "./expense-check.js";

parentPort.on("message", async ({ id, src, bytes, fileName, today }) => {
  try {
    const result = await checkInline(src, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), fileName, today);
    parentPort.postMessage({ id, result });
  } catch (e) { parentPort.postMessage({ id, error: String((e && e.message) || e) }); }
});
