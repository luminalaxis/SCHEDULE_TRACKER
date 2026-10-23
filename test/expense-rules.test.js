// Unit tests for the 사비 내역서 form rules. They run the exact script from index.html (window.FSKExpenseRules),
// so the page and these tests can never drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers/server.js";

const html = readFileSync(join(ROOT, "index.html"), "utf8");
const src = html.match(/<script>\s*(\/\/ 사비 내역서 양식 규칙[\s\S]*?)<\/script>/)[1];
const ctx = { window: {} };
vm.runInNewContext(src, ctx);
const R = ctx.window.FSKExpenseRules;
const TODAY = "2026-10-16";
const FILE = "개인사비사용내역서_홍길동_20261015.xlsx";

// A statement in the club layout: header B2:K2, items from row 3, 총 합계 at J13/K13, account at H13.
function workbook({ items, head, account = "신한 110-123-456789", fileTotal, receipts = 1, listSheet = true, totalRow = 13, sheets } = {}) {
  const cells = {}, put = (ref, v, f = false) => { cells[ref] = { v, f }; };
  (head || ["번호", "팀명", "날짜", "구분", "사용목적", "제품명", "구매(가공)처-링크포함", "단가", "수량", "합계"]).forEach((h, i) => put("BCDEFGHIJK"[i] + "2", h));
  let sum = 0;
  (items || [item()]).forEach((it, i) => {
    const r = 3 + i;
    put("B" + r, i + 1); put("C" + r, it.team); put("D" + r, it.date); put("E" + r, it.cat); put("F" + r, it.purpose);
    put("G" + r, it.product); put("H" + r, it.vendor); put("I" + r, it.price); put("J" + r, it.qty);
    if (it.total !== null) put("K" + r, it.total ?? it.price * it.qty, true);
    sum += it.total ?? it.price * it.qty;
  });
  put("J" + totalRow, "총 합계"); put("K" + totalRow, fileTotal ?? sum, true); put("H" + totalRow, account);
  const list = {};
  ["엔진&구동시스템", "조향시스템", "현가시스템", "제동시스템", "프레임&바디", "전장시스템", "휠&타이어", "기타"].forEach((v, i) => { list["B" + (i + 1)] = { v }; });
  ["배터리", "파워트레인", "프레임", "회로", "에어로", "기타"].forEach((v, i) => { list["D" + (i + 1)] = { v }; });
  return { sheets: sheets || [
    { name: "내역서", state: "visible", cells, images: [] },
    { name: "영수증", state: "visible", cells: {}, images: Array.from({ length: receipts }, (_, i) => ({ path: `xl/media/image${i + 1}.png`, col: 1 + i * 9, row: 2 })) },
    ...(listSheet ? [{ name: ".", state: "hidden", cells: list, images: [] }] : [])
  ] };
}
function item(over = {}) {
  return { team: "에어로", date: 46300, cat: "프레임&바디", purpose: "리어 윙 제작", product: "카본 프리프레그", vendor: "https://smartstore.naver.com/carbon", price: 50000, qty: 2, ...over };
}
const check = (wb, file = FILE) => R.checkStatement(wb, file, TODAY);
const has = (list, re) => list.some((m) => re.test(m));

test("a correct statement passes", () => {
  const r = check(workbook());
  assert.equal(r.level, "ok", JSON.stringify(r.errors.concat(r.warns)));
  assert.equal(r.total, 100000); assert.equal(r.applicant, "홍길동"); assert.equal(r.items.length, 1);
  assert.equal(r.items[0].date, "2026-10-05"); assert.equal(r.account, "신한 110-123-456789"); assert.equal(r.receipts[0].slot, 1);
});

test("structure problems are errors", () => {
  assert.ok(has(check(workbook({ sheets: [{ name: "Sheet1", cells: {}, images: [] }] })).errors, /'내역서' 시트가 없어요/));
  const noReceiptSheet = workbook(); noReceiptSheet.sheets.splice(1, 1);
  assert.ok(has(check(noReceiptSheet).errors, /'영수증' 시트가 없어요/));
  const head = ["번호", "팀", "날짜", "구분", "사용목적", "제품명", "구매(가공)처-링크포함", "단가", "수량", "합계"];
  assert.ok(has(check(workbook({ head })).errors, /2행 머리글이 양식과 달라요 \(팀명\)/));
  assert.ok(has(check(workbook({ items: [] })).errors, /작성된 사용 내역이 없어요/));
});

test("item rules", () => {
  assert.ok(has(check(workbook({ items: [item({ team: "섀시" })] })).errors, /팀명 '섀시'/), "team must be on the form's list");
  assert.ok(has(check(workbook({ items: [item({ cat: "기계" })] })).errors, /구분 '기계'/));
  assert.ok(has(check(workbook({ items: [item({ purpose: "" })] })).errors, /사용목적 칸이 비어/));
  assert.ok(has(check(workbook({ items: [item({ total: 90000 })] })).errors, /합계 90,000원이 단가×수량 100,000원과 달라요/));
  assert.equal(check(workbook({ items: [item({ total: 99999 })] })).errors.length, 0, "1원 rounding is tolerated");
  assert.ok(has(check(workbook({ items: [item({ price: "오만원" })] })).errors, /단가가 숫자가 아니에요/));
  assert.ok(has(check(workbook({ items: [item({ qty: 1.5 })] })).warns, /수량이 정수가 아니에요/));
  assert.ok(has(check(workbook({ items: [item({ date: "어제" })] })).errors, /날짜 '어제'를 읽을 수 없어요/));
  assert.ok(has(check(workbook({ items: [item({ date: "2026.11.30" })] })).warns, /오늘 이후예요/));
  assert.ok(has(check(workbook({ items: [item({ product: "택배비", cat: "프레임&바디" })] })).warns, /배송비는 구분을 '기타'/));
  assert.equal(check(workbook({ items: [item({ product: "택배비", cat: "기타" })] })).warns.length, 0);
  assert.ok(has(check(workbook({ items: [item({ vendor: "철물점" })] })).warns, /링크나 주소가 없어요/));
  assert.equal(check(workbook({ items: [item({ vendor: "서울시 중구 을지로 12" })] })).warns.length, 0, "a street address counts");
  assert.ok(has(check(workbook({ items: [item({ total: null })] })).warns, /합계 칸이 비어/));
});

test("totals, account and receipts", () => {
  assert.ok(has(check(workbook({ fileTotal: 120000 })).errors, /총 합계 120,000원이 항목 합계 100,000원과 달라요/));
  assert.ok(has(check(workbook({ account: "" })).errors, /계좌번호가 비어/));
  assert.ok(has(check(workbook({ account: "신한 1234" })).errors, /자릿수가 이상해요 \(4자리\)/));
  assert.ok(has(check(workbook({ account: "110-123-456789" })).warns, /은행 이름이 없어요/));
  assert.ok(has(check(workbook({ receipts: 0 })).errors, /영수증 사진이 없어요/));
  const two = workbook({ items: [item(), item({ vendor: "https://coupang.com/x", date: 46301 })], receipts: 1 });
  assert.ok(has(check(two).warns, /영수증 사진은 1장인데 구매 건.*2건/));
  assert.ok(has(check(workbook({ totalRow: 15 })).warns, /총 합계가 15행에 있음/));
});

test("file name and fallbacks", () => {
  const r = check(workbook(), "내역서.xlsx");
  assert.ok(has(r.warns, /파일명이/)); assert.equal(r.applicant, "");
  assert.equal(check(workbook({ listSheet: false })).level, "ok", "built-in lists when the hidden sheet is missing");
});

test("download names always end in .xlsx", () => {
  assert.equal(R.xlsxFileName("개인사비사용내역서_홍길동_1015.xlsx"), "개인사비사용내역서_홍길동_1015.xlsx");
  assert.equal(R.xlsxFileName("정산.exe"), "정산.exe.xlsx");
  assert.equal(R.xlsxFileName("매크로.XLSM"), "매크로.XLSM.xlsx");
  assert.equal(R.xlsxFileName("invoice\u202Exslx.exe"), "invoicexslx.exe.xlsx", "right-to-left override is removed");
  assert.equal(R.xlsxFileName("../../a/b:c.xlsx"), "_.._a_b_c.xlsx");
  assert.equal(R.xlsxFileName(""), "사비내역서.xlsx");
  assert.equal(R.xlsxFileName("..."), "사비내역서.xlsx");
});

test("helpers", () => {
  assert.equal(R.excelDate(44927), "2023-01-01");
  assert.equal(R.excelDate("2026.3.5"), "2026-03-05");
  assert.equal(R.excelDate("2026년 3월 5일"), "2026-03-05");
  assert.equal(R.excelDate(`10/30`), `${new Date().getFullYear()}-10-30`);
  assert.equal(R.excelDate("13/40"), null);
  assert.equal(R.toNum("12,000원"), 12000); assert.equal(R.toNum("₩ 3,500"), 3500); assert.equal(R.toNum("abc"), null); assert.equal(R.toNum(""), null);
  assert.equal(R.maskAccount("신한 110-123-456789"), "신한 ••••••••6789");
  assert.equal(R.maskAccount("카카오뱅크 3333-01-2345678"), "카카오 •••••••••5678");
  assert.equal(R.maskAccount(""), "");
  assert.equal(R.receiptSlot(1, 2), 1); assert.equal(R.receiptSlot(1, 14), 2); assert.equal(R.receiptSlot(10, 2), 4); assert.equal(R.receiptSlot(40, 40), 10);
});

// The self-hosted server runs the same rules on the stored file (server/expense-check.js), with its own small XML reader.
test("server check reads the file the way the page does", async () => {
  const { checkExpenseFile } = await import("../server/expense-check.js");
  const { statementXlsx } = await import("./helpers/xlsx.js");
  const good = statementXlsx({ items: [item(), item({ product: "에폭시 & 경화제", price: 30000, qty: 1 })] });
  const r = await checkExpenseFile(html, good.buffer, FILE, TODAY);
  assert.equal(r.check.level, "ok", r.check.errors.concat(r.check.warns).join(" / "));
  assert.equal(r.total, good.total); assert.equal(r.items[1].product, "에폭시 & 경화제");
  assert.equal(r.accountMasked, "신한 ••••••••6789"); assert.equal(r.fileSize, good.buffer.length); assert.match(r.hash, /^[0-9a-f]{64}$/);
  const bad = await checkExpenseFile(html, statementXlsx({ items: [item({ team: "없는팀" })], receipts: 0 }).buffer, FILE, TODAY);
  assert.equal(bad.check.level, "bad");
  assert.ok(has(bad.check.errors, /없는팀/)); assert.ok(has(bad.check.errors, /영수증 사진이 없어요/));
  const junk = await checkExpenseFile(html, Buffer.from("not a zip"), FILE, TODAY);
  assert.equal(junk.check.level, "bad"); assert.match(junk.check.errors[0], /xlsx 파일을 열 수 없어요/);
});

test("server XML reader: prefixes, entities, phonetic runs, r: attributes", async () => {
  const { parseXml } = await import("../server/expense-check.js");
  const RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const doc = parseXml(`<?xml version="1.0" encoding="UTF-8"?>\r\n<!-- note --><x:sst xmlns:x="urn:main" xmlns:rel="${RNS}"><x:si><x:r><x:t xml:space="preserve"> A &amp; B&#x41;&#66;</x:t></x:r><x:rPh sb="0"><x:t>읽는법</x:t></x:rPh></x:si><x:si><x:t><![CDATA[<raw>]]></x:t></x:si><x:sheet name="내역서 &lt;1&gt;" rel:id="rId7"/></x:sst>`);
  const si = doc.getElementsByTagNameNS("*", "si");
  assert.equal(si.length, 2);
  const t = si[0].getElementsByTagNameNS("*", "t");
  assert.equal(t[0].textContent, " A & BAB"); assert.equal(t[1].parentNode.localName, "rPh");
  assert.equal(si[1].textContent, "<raw>");
  const sheet = doc.getElementsByTagNameNS("*", "sheet")[0];
  assert.equal(sheet.getAttribute("name"), "내역서 <1>");
  assert.equal(sheet.getAttributeNS(RNS, "id"), "rId7"); assert.equal(sheet.getAttribute("r:id"), null);
  assert.equal(sheet.getAttributeNS("urn:other", "id"), null);
});
