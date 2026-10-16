// Checks that an upload's bytes match the type it claims, so an executable cannot be stored as "application/pdf"
// or "image/png". Binary types must start with their format signature; text types must not look like a program.
const startsWith = (buf, bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

const SIGNATURES = {
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  "image/webp": (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  "video/mp4": (b) => startsWith(b, ascii("ftyp"), 4),
  "video/webm": (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
  // PDF readers accept the header anywhere in the first 1 KiB
  "application/pdf": (b) => b.subarray(0, 1024).includes(Buffer.from("%PDF-")),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  "image/svg+xml": (b) => isText(b) && /<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8"))
};
// Programs and archives that must never pass as text (Linux ELF, macOS Mach-O, zip, PDF). Windows .exe files
// are caught by the NUL-byte rule below (their header always has NULs), so plain text starting "MZ" still passes.
const BINARY_HEADS = [[0x7f, 0x45, 0x4c, 0x46], [0xcf, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xca, 0xfe, 0xba, 0xbe], [0x50, 0x4b, 0x03, 0x04], ascii("%PDF-")];

function isText(b) {
  if (startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) return true; // UTF-16 text (Excel "유니코드 텍스트")
  const head = startsWith(b, [0xef, 0xbb, 0xbf]) ? b.subarray(3) : b;
  if (BINARY_HEADS.some((sig) => startsWith(head, sig))) return false;
  return !b.subarray(0, 64 * 1024).includes(0); // text has no NUL bytes (also true for CP949 CSV from Korean Excel)
}

export function contentMatches(type, buf) {
  if (SIGNATURES[type]) return SIGNATURES[type](buf);
  if (type.startsWith("text/") || type === "application/json") return isText(buf);
  return false;
}

// Control and bidirectional-override characters let "invoice‮xcod.exe" display as "invoiceexe.docx".
export const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "").trim();
