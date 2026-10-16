// Unit tests for BOM CSV import. They run the exact script from index.html (window.FSKBom),
// so the page and these tests can never drift apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT } from "./helpers/server.js";

const html = readFileSync(join(ROOT, "index.html"), "utf8");
const src = html.match(/<script>\s*(\/\/ BOM CSV 가져오기 규칙[\s\S]*?)<\/script>/)[1];
const ctx = { window: {}, TextDecoder };
vm.runInNewContext(src, ctx);
const B = ctx.window.FSKBom;
const parts = (csv) => B.toParts(B.parseCsv(csv));
const plain = (v) => JSON.parse(JSON.stringify(v));

test("CSV: quotes, commas and line breaks inside cells, CRLF, blank rows", () => {
  const rows = B.parseCsv('부품명,메모\r\n"A암, 상",\"줄1\n줄2\"\r\n,\r\n"따옴표 ""안""",x\n');
  assert.deepEqual(plain(rows), [["부품명", "메모"], ["A암, 상", "줄1\n줄2"], ['따옴표 "안"', "x"]]);
});

test("CSV: tab and semicolon delimiters are detected from the header", () => {
  assert.deepEqual(plain(B.parseCsv("부품명\t수량\n업라이트\t2\n")), [["부품명", "수량"], ["업라이트", "2"]]);
  assert.deepEqual(plain(B.parseCsv("부품명;수량\n업라이트;2\n")), [["부품명", "수량"], ["업라이트", "2"]]);
});

test("decode: UTF-8 with BOM and Korean Excel's EUC-KR", () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("부품명\n업라이트\n")]);
  assert.equal(B.decode(utf8), "부품명\n업라이트\n");
  const euckr = new Uint8Array([186, 206, 199, 176, 184, 237, 44, 186, 206, 188, 173, 13, 10, 190, 247, 182, 243, 192, 204, 198, 174, 44, 199, 193, 183, 185, 192, 211, 13, 10]);
  assert.equal(B.decode(euckr), "부품명,부서\r\n업라이트,프레임\r\n");
});

test("the page's own BOM export reads back", () => {
  const csv = "부서,부품명,부품번호,구분,제작 단계,수량,개당 질량(g),총 질량(g),개당 비용(원),금액(원),공급처/가공처,담당자,마감일,메모\n"
    + '프레임·현가,프론트 업라이트,CH-F-001,제작,가공,2,1200,2400,85000,170000,"OO정밀, 김포",김개발,2026-11-02,"7075-T6"\n'
    + "파워트레인,구동 모터,,구매,발주,1,,,,,,,,\n";
  const r = parts(csv);
  assert.equal(r.error, undefined);
  assert.deepEqual(plain(r.cols), ["dept", "name", "partNo", "make", "stage", "qty", "unitMass", "unitCost", "supplier", "owner", "due", "note"]);
  assert.deepEqual(plain(r.items[0].data), { name: "프론트 업라이트", partNo: "CH-F-001", supplier: "OO정밀, 김포", owner: "김개발", note: "7075-T6", dept: "chassis", make: "make", stage: "machining", qty: 2, unitMass: 1200, unitCost: 85000, due: "2026-11-02" });
  assert.deepEqual(plain(r.items[1].data), { name: "구동 모터", partNo: "", supplier: "", owner: "", note: "", dept: "powertrain", make: "buy", stage: "order", qty: 1, unitMass: null, unitCost: null, due: "" });
  assert.equal(r.items.every((i) => !i.warns.length), true);
});

test("other sheets: aliases, kg, 원 and commas, short dates, and warnings", () => {
  const r = parts("품명,팀,상태,무게(kg),단가,납기,개수\n리어 윙,에어로,완료,1.25,\"12,000원\",11/5,x\n뭔가,이상한부서,곧,,abc,내일,3\n,배터리,,,,,\n");
  const year = new Date().getFullYear();
  assert.deepEqual(plain(r.items[0].data), { name: "리어 윙", dept: "aero", stage: "done", unitMass: 1250, unitCost: 12000, due: `${year}-11-05` });
  assert.match(r.items[0].warns.join(), /수량 'x'/);
  const w = r.items[1].warns.join(" / ");
  assert.match(w, /부서 '이상한부서'/); assert.match(w, /단계 '곧'/); assert.match(w, /비용 'abc'/); assert.match(w, /마감일 '내일'/);
  assert.equal(r.items[1].data.qty, 3);
  assert.equal(r.items[1].data.dept, undefined, "an unknown 부서 is left out, not guessed");
  assert.equal(r.items[2].skip, true, "rows without a name are skipped");
});

test("a file without a 부품명 column is refused", () => {
  assert.match(parts("이름없음,수량\na,1\n").error, /부품명/);
  assert.match(B.toParts([]).error, /비어/);
});

test("rows match existing parts by 부품번호, then by 부서 + 이름", () => {
  const list = [{ id: "a", name: "업라이트", partNo: "CH-1", dept: "chassis" }, { id: "b", name: "업라이트", dept: "aero" }, { id: "c", name: "시트", dept: "chassis" }];
  const deptOf = (p) => p.dept;
  assert.equal(B.matchPart({ name: "다른 이름", partNo: "ch-1" }, list, deptOf).id, "a");
  assert.equal(B.matchPart({ name: "업라이트", dept: "aero" }, list, deptOf).id, "b");
  assert.equal(B.matchPart({ name: "업라이트" }, list, deptOf), null, "an ambiguous name without 부서 makes a new part");
  assert.equal(B.matchPart({ name: " 시트 " }, list, deptOf).id, "c");
  assert.equal(B.matchPart({ name: "시트", dept: "aero" }, list, deptOf), null);
});

test("dates", () => {
  assert.equal(B.toDate("2026.11.2"), "2026-11-02");
  assert.equal(B.toDate("2026년 11월 2일"), "2026-11-02");
  assert.equal(B.toDate("2026/13/2"), null);
  assert.equal(B.toDate("3/4", 2027), "2027-03-04");
});
