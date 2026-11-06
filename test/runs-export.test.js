// 주행 기록 내보내기: the page's export rules (window.FSKRuns, run straight from index.html so page, server and tests
// cannot drift apart) and the server's 분석 보고서 endpoint, which runs the same rules on the Raspberry Pi.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT, startServer, Client, member } from "./helpers/server.js";

const html = readFileSync(join(ROOT, "index.html"), "utf8");
const src = html.match(/<script>\s*(\/\/ 주행 기록 내보내기 규칙[\s\S]*?)<\/script>/)[1];
const ctx = { window: {} };
vm.runInNewContext(src, ctx);
const R = ctx.window.FSKRuns;
const plain = (v) => JSON.parse(JSON.stringify(v));
const JSZip = (() => { const mod = { exports: {} }; new Function("module", "exports", readFileSync(join(ROOT, "server/public/vendor/jszip.min.js"), "utf8"))(mod, mod.exports); return mod.exports; })();

const DATA = {
  sessions: [
    { id: "s2", date: "2026-10-05", event: "오토크로스", laps: 8, createdAt: "2026-10-05T01:00:00Z" },
    { id: "s1", date: "2026-10-01", event: "오토크로스", location: "학교 주차장", weather: "맑음", airTemp: 18, laps: 10, goal: "캠버 변경 효과",
      checklist: { battery: [{ id: "b1", text: "셀 전압" }, { id: "b2", text: "SOC" }], chassis: [{ id: "c1", text: "휠 너트" }] }, createdAt: "2026-10-01T01:00:00Z" },
    { id: "s3", date: "2026-10-01", event: "오토크로스", laps: 4, createdAt: "2026-10-01T06:00:00Z" },
    { id: "s4", date: "2026-10-20", event: "가속", laps: 3 }
  ],
  logs: [
    { id: "l2", sessionId: "s1", dept: "chassis", status: "warn", author: "에이", metrics: { pFL: 12, pFR: 12.5, pRL: 11, pRR: 11.2, rideF: 30, rideR: 35 }, action: "공기압 재조정", partIds: ["p1", "gone"], createdAt: "2026-10-01T05:00:00Z" },
    { id: "l1", sessionId: "s1", dept: "battery", status: "ok", author: "비", metrics: { socStart: 95, socEnd: 60, energy: 2.5, cellTempMax: 41 }, attachments: [{ id: "x", name: "bms.csv", type: "text/csv" }, { id: "y", name: "사진.png", type: "image/png" }], createdAt: "2026-10-01T04:00:00Z" },
    { id: "l3", sessionId: "s2", dept: "battery", status: "bad", metrics: { socStart: 90, socEnd: 50, energy: 3, cellTempMax: 52 }, action: "냉각 점검", actionDone: true, createdAt: "2026-10-05T03:00:00Z" },
    { id: "l4", sessionId: "s2", dept: "powertrain", status: "ok", metrics: { motorTemp: 80, coolantTemp: 45, ptTopSpeed: 92 }, createdAt: "2026-10-05T03:30:00Z" },
    { id: "l5", sessionId: "s2", dept: "battery", status: "ok", metrics: { cellTempMax: 48 }, createdAt: "2026-10-05T04:00:00Z" },
    { id: "lx", sessionId: "nope", dept: "battery", status: "bad" }
  ],
  checks: [{ sessionId: "s1", itemId: "b1" }, { sessionId: "s1", itemId: "c1" }],
  comments: [{ logId: "l2", sessionId: "s1", author: "김에어로", dept: "aero", text: "리어도 확인해 주세요", createdAt: "2026-10-01T07:00:00Z" }],
  parts: [{ id: "p1", name: "프론트 휠" }]
};
const rowOf = (t, title) => Object.fromEntries(t.head.map((h, i) => [h, t.rows.find((r) => r[0] === title)[i]]));

test("세션 표: one row per session in date order, with computed columns and unique titles", () => {
  const t = R.sessionTable(DATA, {});
  assert.deepEqual(t.rows.map((r) => r[0]), ["2026-10-01 오토크로스", "2026-10-01 오토크로스 (2)", "2026-10-05 오토크로스", "2026-10-20 가속"], "same day and event get (2)");
  const s1 = rowOf(t, "2026-10-01 오토크로스");
  assert.equal(s1["종합 판정"], "주의");
  assert.equal(s1["정상"], 1); assert.equal(s1["주의"], 1); assert.equal(s1["미해결 이슈"], 1);
  assert.equal(s1["기록한 부서"], "배터리, 프레임·현가");
  assert.equal(s1["출주 전 점검"], "2/3"); assert.equal(s1["점검 완료율 (%)"], 66.7);
  assert.equal(s1["SOC 소모 (%)"], 35); assert.equal(s1["랩당 소모 에너지 (kWh/랩)"], 0.25);
  assert.equal(s1["의견 수"], 1); assert.equal(s1["첨부 파일 수"], 2);
  const s2 = rowOf(t, "2026-10-05 오토크로스");
  assert.equal(s2["종합 판정"], "문제"); assert.equal(s2["미해결 이슈"], 0, "a done action is not open");
  assert.equal(s2["최고 셀 온도 (℃)"], 48, "a session's value is the latest record that has it");
  assert.equal(s2["최고 속도 (km/h)"], 92);
  assert.equal(rowOf(t, "2026-10-20 가속")["종합 판정"], "기록 없음");
});

test("부서 기록 표: filled measurement columns only, derived values, comments and part names", () => {
  const t = R.logTable(DATA, {});
  assert.ok(!t.head.includes("CAN 오류 (회)"), "a field nobody filled is left out");
  assert.ok(t.head.includes("파워트레인 최고 속도 (km/h)") && !t.head.includes("최고 속도 (km/h)"), "a shared label gets its department");
  assert.equal(t.rows.length, 5, "a record of a missing session is dropped");
  assert.deepEqual(t.rows.map((r) => r[0]).slice(0, 2), ["2026-10-01 오토크로스 · 배터리", "2026-10-01 오토크로스 · 프레임·현가"], "session order, then department order");
  const c = rowOf(t, "2026-10-01 오토크로스 · 프레임·현가");
  assert.equal(c["공기압 평균 (psi)"], 11.675); assert.equal(c["공기압 최대 편차 (psi)"], 1.5); assert.equal(c["레이크 R−F (mm)"], 5);
  assert.equal(c["시작 SOC (%)"], null, "another department's columns stay empty");
  assert.equal(c["이슈 상태"], "미해결"); assert.equal(c["관련 부품"], "프론트 휠");
  assert.equal(c["의견"], "김에어로 (에어로): 리어도 확인해 주세요");
  const b = rowOf(t, "2026-10-01 오토크로스 · 배터리");
  assert.equal(b["랩당 SOC 소모 (%/랩)"], 3.5); assert.equal(b["첨부 파일"], "bms.csv, 사진.png");
  assert.equal(b["작성 시각"], "2026-10-01 13:00", "times in Korea");
  assert.equal(rowOf(t, "2026-10-05 오토크로스 · 파워트레인")["모터−냉각수 온도 차 (℃)"], 35);
  assert.equal(rowOf(t, "2026-10-05 오토크로스 · 배터리")["이슈 상태"], "해결됨");
});

test("filters: date range and event", () => {
  assert.equal(R.sessionTable(DATA, { from: "2026-10-02" }).rows.length, 2);
  assert.equal(R.sessionTable(DATA, { to: "2026-10-01" }).rows.length, 2);
  assert.deepEqual(R.sessionTable(DATA, { event: "가속" }).rows.map((r) => r[0]), ["2026-10-20 가속"]);
  assert.equal(R.logTable(DATA, { event: "가속" }).rows.length, 0);
  assert.equal(R.fileName("FS-26", "세션", { from: "2026-10-01", event: "가속" }, "csv", "2026-11-06"), "FS-26_세션_가속_2026-10-01~끝.csv");
  assert.equal(R.fileName("", "부서기록", {}, "csv", "2026-11-06"), "차량_부서기록_2026-11-06.csv");
});

test("CSV: UTF-8 BOM, CRLF, quotes for commas, quotes and line breaks", () => {
  const csv = R.toCsv({ head: ["a", "b"], rows: [["x, y", 'say "hi"'], ["줄1\n줄2", null], [1.5, 0]] });
  assert.equal(csv, '﻿a,b\r\n"x, y","say ""hi"""\r\n"줄1\n줄2",\r\n1.5,0\r\n');
});

test("logger CSV: skips metadata lines, finds the header, summarises numeric columns", () => {
  const r = R.analyzeLogger("﻿Logger v2\nRate: 10 Hz\n\ntime [s],rpm,temp,note\n0,1000,30,start\n0.5,2000,31,\n1,3000,35,end\n\n");
  assert.equal(r.rows, 3);
  assert.deepEqual(plain(r.columns.map((c) => c.name)), ["time [s]", "rpm", "temp"], "a column with no numbers is left out");
  const rpm = r.columns.find((c) => c.name === "rpm");
  assert.deepEqual(plain(rpm), { name: "rpm", n: 3, min: 1000, max: 3000, mean: 2000, sd: 1000, first: 1000, last: 3000 });
  assert.equal(r.timeColumn, "time [s]"); assert.equal(r.span, 1);
  const semi = R.analyzeLogger("t;v\n0;1,5\n1;2,5\n");
  assert.equal(semi.columns.find((c) => c.name === "v").mean, 2, "semicolon files use a decimal comma");
  const tab = R.analyzeLogger('"a"\t"b"\n1\t2\n3\t4\n');
  assert.deepEqual(plain(tab.columns.map((c) => [c.name, c.max])), [["a", 3], ["b", 4]]);
  assert.ok(R.analyzeLogger("그냥 메모\n숫자 없음\n").error);
  assert.equal(R.analyzeLogger("a,b\n1,2\n3,4\n5,6\n", { maxRows: 2 }).truncated, true);
  const big = R.analyzeLogger("ts,x\n" + [0, 1, 2].map((i) => `${1700000000000 + i},${i}`).join("\n"));
  assert.equal(big.columns[0].sd, 1, "large timestamps keep an exact spread");
  assert.ok(R.isLoggerFile({ name: "run1.CSV", type: "text/csv" }) && !R.isLoggerFile({ name: "a.png", type: "image/png" }));
});

test("분석 보고서: sheets, statistics and the logger sheet", async () => {
  const loggers = [{ logId: "l1", name: "bms.csv", result: R.analyzeLogger("time,cell\n0,3.9\n1,3.7\n") }, { logId: "l1", name: "bad.csv", result: { error: "읽을 수 없어요." } }];
  const sheets = R.report({ ...DATA, carName: "FS-26", loggers }, { today: "2026-11-06", generatedAt: "2026-11-06T03:00:00Z" });
  assert.deepEqual(plain(sheets.map((s) => s.name)), ["요약", "세션", "부서 기록", "지표 통계", "지표 추이", "판정표", "이슈", "로거 분석"]);
  const get = (name) => sheets.find((s) => s.name === name).rows.map((r) => r.map((c) => (c && typeof c === "object" ? c.v : c)));
  const stats = get("지표 통계"), head = stats[0], cell = stats.find((r) => r[1] === "최고 셀 온도");
  const S = Object.fromEntries(head.map((h, i) => [h, cell[i]]));
  assert.equal(S["세션 수"], 2); assert.equal(S["최소"], 41); assert.equal(S["최대"], 48); assert.equal(S["평균"], 44.5);
  assert.equal(S["변화 (마지막−처음)"], 7); assert.equal(S["최고 세션"], "2026-10-05 오토크로스");
  assert.equal(stats.find((r) => r[1] === "SOC 소모")[3], "계산");
  const issues = get("이슈");
  assert.deepEqual(plain(issues.slice(1).map((r) => [r[2], r[7], r[8]])), [["프레임·현가", "미해결", 36], ["배터리", "해결됨", ""]], "open first; days open since the session");
  const lg = get("로거 분석");
  assert.deepEqual(plain(lg[1].slice(0, 7)), ["2026-10-01 오토크로스", "배터리", "bms.csv", 2, "1 (time)", "time", 2]);
  assert.equal(lg.find((r) => r[5] === "cell")[9], 3.8);
  assert.equal(lg.at(-1)[13], "읽을 수 없어요.");
  assert.ok(get("요약")[0][0].startsWith("FS-26"));
  const buf = await R.xlsxBook(sheets, { JSZip, type: "nodebuffer" });
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file("xl/worksheets/sheet8.xml"));
  assert.match(await zip.file("xl/worksheets/sheet4.xml").async("string"), /<v>44\.5<\/v>/);
  assert.equal(R.report(DATA, {}).length, 7, "no logger sheet unless asked");
});

// ---------- the server ----------
let srv, dev, a;
before(async () => {
  srv = await startServer();
  dev = new Client(srv.base);
  await dev.post("/api/auth/signup", { username: "dev", password: "password1", name: "개발자", agree: true });
  a = await member(srv.base, dev, "aaa", "에이", { dept: "battery" });
});
after(async () => { await srv.stop(); });

test("server: 분석 보고서 runs the page's rules on the Pi and sends the xlsx to whoever asked", async () => {
  const up = await a.post("/api/assets", Buffer.from("# BMS log\ntime,cellV,cellT\n0,3.95,30\n1,3.80,38\n2,3.70,44\n"), { "content-type": "text/csv", "x-file-name": "bms.csv" });
  assert.equal(up.status, 200, up.text);
  await dev.post("/api/db/set", { path: "config/car", data: { carName: "FS-26" } });
  assert.equal((await a.post("/api/db/set", { path: "sessions/s1", data: { date: "2026-10-01", event: "오토크로스", laps: 10 } })).status, 200);
  await a.post("/api/db/set", { path: "sessions/s2", data: { date: "2026-10-09", event: "가속", laps: 2 } });
  await a.post("/api/db/set", { path: "logs/l1", data: { sessionId: "s1", dept: "battery", status: "warn", metrics: { socStart: 95, socEnd: 60 }, action: "셀 밸런싱", attachments: [{ id: up.json.id, name: "bms.csv", type: "text/csv", size: 60 }, { id: "f".repeat(32), name: "없는파일.csv", type: "text/csv" }] } });

  const r = await a.post("/api/export/runs", { from: "2026-10-01", to: "2026-10-05", logger: true });
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get("content-type"), /spreadsheetml/);
  assert.match(r.headers.get("content-disposition"), /filename\*=UTF-8''FS-26_%EC%A3%BC%ED%96%89%EB%B6%84%EC%84%9D_2026-10-01~2026-10-05\.xlsx/);
  const zip = await JSZip.loadAsync(r.buf);
  const wb = await zip.file("xl/workbook.xml").async("string");
  assert.match(wb, /name="로거 분석"/);
  const sessions = await zip.file("xl/worksheets/sheet2.xml").async("string");
  assert.match(sessions, /2026-10-01 오토크로스/); assert.doesNotMatch(sessions, /가속/, "the date filter was applied");
  const logger = await zip.file("xl/worksheets/sheet8.xml").async("string");
  assert.match(logger, /cellT/); assert.match(logger, /<v>44<\/v>/, "max of the logger column");
  assert.match(logger, /서버에서 파일을 찾을 수 없어요/);

  assert.equal((await a.post("/api/export/runs", { from: "2030-01-01" })).status, 400, "no sessions in range");
  const plainReport = await a.post("/api/export/runs", {});
  assert.equal(plainReport.status, 200);
  assert.ok(!(await (await JSZip.loadAsync(plainReport.buf)).file("xl/workbook.xml").async("string")).includes("로거 분석"));
  assert.equal((await new Client(srv.base).post("/api/export/runs", {})).status, 401, "signed in only");
  const audit = (await dev.get("/api/admin/audit")).json;
  assert.ok(JSON.stringify(audit).includes("export.runs"));
});

test("server: two reports at once — the second is told to wait", async () => {
  const [x, y] = await Promise.all([a.post("/api/export/runs", { logger: true }), a.post("/api/export/runs", { logger: true })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 429]);
});
