// Unit tests for the server's helper modules: claude.ai migration, webhook formatting, tar.gz archives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { analyzeExport, remapRows } from "../server/migrate.js";
import { checkWebhookUrl, webhookBody } from "../server/notify.js";
import { writeTarGz, readTarGz } from "../server/archive.js";
import { stableJson, runQuery } from "../server/store.js";
import { contentMatches, cleanName } from "../server/filetype.js";

test("upload content matches its type", () => {
  const b = (x) => Buffer.isBuffer(x) ? x : Buffer.from(x, "latin1");
  assert.ok(contentMatches("image/png", Buffer.from("89504e470d0a1a0a0000", "hex")));
  assert.ok(contentMatches("image/webp", b("RIFF\x10\x00\x00\x00WEBPVP8 ")));
  assert.ok(!contentMatches("image/webp", b("RIFF\x10\x00\x00\x00AVI LIST")));
  assert.ok(contentMatches("video/mp4", b("\x00\x00\x00\x18ftypmp42")));
  assert.ok(contentMatches("application/pdf", b("\r\n%PDF-1.4")), "header within the first KiB");
  assert.ok(!contentMatches("application/pdf", b("\x7fELF\x02\x01")));
  assert.ok(contentMatches("text/csv", Buffer.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0x31])), "CP949 text from Korean Excel");
  assert.ok(contentMatches("text/plain", Buffer.from("\ufeff메모", "utf8")));
  assert.ok(!contentMatches("text/plain", b("\x7fELF\x02")) && !contentMatches("text/plain", b("ab\x00cd")));
  assert.ok(!contentMatches("application/x-msdownload", b("MZ")), "unknown types never match");
  assert.equal(cleanName(" a\u202Eb\u0007c\u2066.png "), "abc.png");
});

test("remapRows rewrites paths, keys and id references only", () => {
  const rows = [
    { path: "expenses/old", data: { subs: { s1: { by: "old", note: "old school" } } } },
    { path: "reviews/rev", data: { items: { "old:s1": { status: "paid" } } } },
    { path: "history/h", data: { uid: "old", targetId: "old:s1", list: ["old", "older", "x:old"] } }
  ];
  const out = remapRows(rows, { old: "new", unused: "" });
  assert.equal(out[0].path, "expenses/new");
  assert.equal(out[0].data.subs.s1.note, "old school", "text that merely contains the id is left alone");
  assert.equal(out[0].data.subs.s1.by, "new");
  assert.ok(out[1].data.items["new:s1"]);
  assert.deepEqual(out[2].data, { uid: "new", targetId: "new:s1", list: ["new", "older", "x:old"] });
  assert.equal(remapRows(rows, {}), rows);
});

test("analyzeExport names accounts and suggests matches", () => {
  const ids = analyzeExport([
    { path: "people/u1", data: { name: "김민수" } },
    { path: "expenses/u1", data: { subs: { a: { by: "민수" }, b: { by: "민수" } } } },
    { path: "checks/s--i", data: { uid: "u2", by: "이지은" } },
    { path: "config/roles", data: { ownerUid: "u3", treasurers: [] } }
  ], [{ id: "x1", name: "김민수" }, { id: "x2", name: "이지은" }, { id: "x3", name: "이지은" }]);
  const u1 = ids.find((x) => x.id === "u1"), u2 = ids.find((x) => x.id === "u2");
  assert.equal(u1.name, "김민수", "the people name outweighs submission names"); assert.equal(u1.suggestion, "x1"); assert.equal(u1.subs, 2);
  assert.equal(u2.suggestion, "", "two accounts share the name: no guess");
  assert.deepEqual(ids.find((x) => x.id === "u3").where, ["소유자"]);
});

test("webhook URLs and bodies", () => {
  assert.equal(checkWebhookUrl(""), null);
  assert.equal(checkWebhookUrl("https://discord.com/api/webhooks/1/x"), null);
  assert.equal(checkWebhookUrl("https://hooks.slack.com/services/T/B/X"), null);
  assert.match(checkWebhookUrl("http://hooks.slack.com/services/x"), /https/);
  assert.match(checkWebhookUrl("https://discord.com.evil.io/x"), /Discord 또는 Slack/);
  assert.match(checkWebhookUrl("http://169.254.169.254/latest"), /Discord 또는 Slack/);
  assert.equal(checkWebhookUrl("http://127.0.0.1:9/x", ["127.0.0.1"]), null);
  const d = webhookBody("https://discord.com/api/webhooks/1/x", "hi @everyone");
  assert.deepEqual(d.allowed_mentions, { parse: [] }); assert.doesNotMatch(d.content, /@everyone/);
  assert.equal(webhookBody("https://hooks.slack.com/services/x", "<!channel> a&b").text, "&lt;!channel&gt; a&amp;b");
  assert.ok(webhookBody("https://discord.com/x", "x".repeat(5000)).content.length <= 1800);
});

test("tar.gz round trip, and truncated archives are refused", async () => {
  const big = Buffer.alloc(70000, 3);
  const out = new PassThrough(), chunks = [];
  out.on("data", (c) => chunks.push(c));
  await writeTarGz(out, [{ name: "backup.json", data: Buffer.from('{"ok":true}') }, { name: "assets/a", data: big }]);
  const gz = Buffer.concat(chunks);
  const seen = [];
  const r = await readTarGz(Readable.from(gz), (name, size) => { seen.push([name, size]); return name === "backup.json" ? "json" : null; });
  assert.deepEqual(JSON.parse(r.json), { ok: true });
  assert.deepEqual(seen, [["backup.json", 11], ["assets/a", 70000]]);
  const zlib = await import("node:zlib");
  const cut = zlib.gzipSync(zlib.gunzipSync(gz).subarray(0, 2000));
  await assert.rejects(readTarGz(Readable.from(cut), () => "json"));
});

test("store helpers", () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } }), stableJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }));
  assert.throws(() => runQuery([], { where: "x" }), /where/);
  assert.throws(() => runQuery([], { orderBy: "at" }), /orderBy/);
});
