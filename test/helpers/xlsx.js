// Builds a minimal 사비 내역서 xlsx in the club's layout (내역서 B2:K13, 영수증 sheet with a photo, hidden list sheet),
// enough for the page's reader. Uses a stored (uncompressed) zip, so no dependencies.
import zlib from "node:zlib";

export function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = (rels) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cell = (ref, v) => v && typeof v === "object" ? `<c r="${ref}"><f>${esc(v.f)}</f><v>${v.v}</v></c>` : typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
const sheet = (cells, extra = "") => {
  const rows = {};
  for (const [ref, v] of Object.entries(cells)) { const r = Number(ref.replace(/^[A-Z]+/, "")); (rows[r] ||= []).push(cell(ref, v)); }
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData>${Object.keys(rows).sort((a, b) => a - b).map((r) => `<row r="${r}">${rows[r].join("")}</row>`).join("")}</sheetData>${extra}</worksheet>`;
};
export const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// items: [{ team, date (excel serial or text), cat, purpose, product, vendor, price, qty }]
export function statementXlsx({ items, account = "신한 110-123-456789", receipts = 1 } = {}) {
  const head = ["번호", "팀명", "날짜", "구분", "사용목적", "제품명", "구매(가공)처-링크포함", "단가", "수량", "합계"];
  const cells = {};
  "BCDEFGHIJK".split("").forEach((c, i) => { cells[c + "2"] = head[i]; });
  let total = 0;
  items.forEach((it, i) => {
    const r = 3 + i, sum = it.price * it.qty; total += sum;
    Object.assign(cells, { ["B" + r]: i + 1, ["C" + r]: it.team, ["D" + r]: it.date, ["E" + r]: it.cat, ["F" + r]: it.purpose, ["G" + r]: it.product, ["H" + r]: it.vendor, ["I" + r]: it.price, ["J" + r]: it.qty, ["K" + r]: { f: `I${r}*J${r}`, v: sum } });
  });
  Object.assign(cells, { J13: "총 합계", K13: { f: "SUM(K3:K12)", v: total }, H13: account, G13: "계좌번호" });
  const lists = {};
  ["엔진&구동시스템", "조향시스템", "현가시스템", "제동시스템", "프레임&바디", "전장시스템", "휠&타이어", "기타"].forEach((v, i) => { lists["B" + (i + 1)] = v; });
  ["배터리", "파워트레인", "프레임", "회로", "에어로", "기타"].forEach((v, i) => { lists["D" + (i + 1)] = v; });
  const anchors = Array.from({ length: receipts }, (_, i) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${1 + (i % 3) * 9}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${8 + (i % 3) * 9}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="영수증${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i + 1}"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`).join("");
  const files = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
    { name: "_rels/.rels", data: REL([["rId1", "officeDocument", "xl/workbook.xml"]]) },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets><sheet name="내역서" sheetId="1" r:id="rId1"/><sheet name="영수증" sheetId="2" r:id="rId2"/><sheet name="." sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: REL([["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"], ["rId3", "worksheet", "worksheets/sheet3.xml"]]) },
    { name: "xl/worksheets/sheet1.xml", data: sheet(cells) },
    { name: "xl/worksheets/sheet2.xml", data: sheet({ B1: "영수증" }, receipts ? '<drawing r:id="rId1"/>' : "") },
    { name: "xl/worksheets/sheet3.xml", data: sheet(lists) }
  ];
  if (receipts) {
    files.push({ name: "xl/worksheets/_rels/sheet2.xml.rels", data: REL([["rId1", "drawing", "../drawings/drawing1.xml"]]) });
    files.push({ name: "xl/drawings/drawing1.xml", data: `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>` });
    files.push({ name: "xl/drawings/_rels/drawing1.xml.rels", data: REL(Array.from({ length: receipts }, (_, i) => [`rId${i + 1}`, "image", `../media/image${i + 1}.png`])) });
    for (let i = 0; i < receipts; i++) files.push({ name: `xl/media/image${i + 1}.png`, data: PNG_1PX });
  }
  return { buffer: zip(files), total };
}
