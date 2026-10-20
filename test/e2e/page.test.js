// Browser tests with Playwright (optional: skipped when Playwright is not installed).
//   npm i --no-save playwright && npx playwright install chromium && npm run test:e2e
//   or point PLAYWRIGHT_MODULE at an existing install (e.g. /opt/node-tools/node_modules/playwright/index.mjs).
// E2E_SHOTS=<folder> saves screenshots of the phone and desktop screens.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, Client, member } from "../helpers/server.js";
import { statementXlsx } from "../helpers/xlsx.js";

let pw = null;
try { pw = await import("playwright"); } catch { try { if (process.env.PLAYWRIGHT_MODULE) pw = await import(process.env.PLAYWRIGHT_MODULE); } catch {} }
const skip = pw ? false : "Playwright is not installed";
const SHOTS = process.env.E2E_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name, full = false) => SHOTS ? page.screenshot({ path: join(SHOTS, name + ".png"), fullPage: full }) : null;

let srv, browser, dev, vice, a;
before(async () => {
  if (skip) return;
  srv = await startServer();
  dev = new Client(srv.base);
  await dev.post("/api/auth/signup", { username: "dev", password: "password1", name: "김개발" });
  vice = await member(srv.base, dev, "vice", "박총무", { position: "vice_lead", dept: "battery" });
  a = await member(srv.base, dev, "aaa", "이에이", { dept: "chassis" });
  await dev.post("/api/db/set", { path: "config/car", data: { carName: "KR-27", compDate: "2026-11-20", targetMass: 220, budget: 30000000 } });
  await dev.post("/api/db/set", { path: "sessions/s1", data: { date: "2026-10-12", event: "오토크로스", location: "학교 주차장", createdAt: "2026-10-12T01:00:00Z" } });
  await dev.post("/api/db/set", { path: "milestones/m1", data: { title: "설계 보고서 제출", date: "2026-10-30", kind: "서류 제출", dept: "" } });
  browser = await pw.chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (srv) srv.stop(); });

async function signIn(ctx, username, password) {
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("#lUser", username); await page.fill("#lPw", password);
  await page.click("#loginForm button[type=submit]");
  await page.waitForURL((u) => u.pathname === "/" || u.pathname === "/admin");
  if (new URL(page.url()).pathname === "/") await page.waitForSelector(".acct-bar");
  return page;
}
const serverDoc = async (path) => (await dev.get("/api/db/doc?path=" + encodeURIComponent(path))).json;
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); } };

test("phone: layout fits, checklist works offline and syncs back", { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ baseURL: srv.base, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await signIn(ctx, "aaa", "password-aaa");
  assert.ok(await page.$('link[rel="manifest"]'));
  assert.ok(await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)), "service worker registered");
  await page.reload(); // now controlled by the service worker, which keeps a copy of the page
  await page.waitForSelector(".acct-bar");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(await overflow() <= 0, "no sideways scrolling on the 오늘 tab");
  await shot(page, "phone-today");
  await page.click("#tab-parts");
  assert.ok(await overflow() <= 0, "no sideways scrolling on the parts tab");
  await page.click("#tab-sessions");
  await page.waitForSelector('input[data-ck="battery1"]');
  assert.ok(await overflow() <= 0, "no sideways scrolling on the sessions tab");
  const box = await page.locator('input[data-ck="battery1"]').boundingBox();
  assert.ok(box.width >= 20 && box.height >= 20, `checkbox is a comfortable touch target (${box.width}x${box.height})`);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#meDept")).fontSize), "16px", "no iOS zoom on focus");

  await ctx.setOffline(true);
  await page.locator('input[data-ck="battery1"]').check();
  // the badge shows "오프라인" as soon as the network drops, then the count once the change is queued
  assert.ok(await until(async () => /오프라인 · 저장 대기 \d/.test(await page.textContent(".acct-sync"))), await page.textContent(".acct-sync"));
  assert.equal((await serverDoc("checks/s1--battery1")).exists, false, "nothing reached the server yet");
  await shot(page, "phone-offline-checklist");
  // opening the board with no signal: page from the service worker, data from this device
  await page.reload();
  await page.waitForSelector(".acct-bar");
  await page.click("#tab-sessions");
  await page.waitForSelector('input[data-ck="battery1"]');
  assert.equal(await page.isChecked('input[data-ck="battery1"]'), true, "the queued check survives a reload");
  assert.match(await page.textContent(".acct-sync"), /저장 대기/);

  await ctx.setOffline(false);
  assert.ok(await until(async () => (await serverDoc("checks/s1--battery1")).exists), "queued change reached the server");
  assert.equal((await serverDoc("checks/s1--battery1")).data.by, "이에이");
  assert.ok(await until(() => page.locator(".acct-sync").isHidden()), "sync badge clears");
  await ctx.close();
});

test("phone: 사비 내역서 submission, 총무 approval arrives under the bell", { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ baseURL: srv.base, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await signIn(ctx, "aaa", "password-aaa");
  await page.click("#tab-expense");
  await page.click("#btnExpNew");
  const { buffer, total } = statementXlsx({ items: [
    { team: "프레임", date: 46300, cat: "현가시스템", purpose: "업라이트 가공", product: "알루미늄 7075 봉재", vendor: "https://smartstore.naver.com/metal", price: 30000, qty: 2 },
    { team: "프레임", date: 46300, cat: "기타", purpose: "업라이트 가공", product: "택배비", vendor: "https://smartstore.naver.com/metal", price: 3000, qty: 1 }
  ] });
  await page.setInputFiles("#xFile", { name: "개인사비사용내역서_이에이_20261015.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
  await page.waitForSelector("#xResult .xsum");
  assert.match(await page.textContent("#xResult"), /양식 검사를 모두 통과했어요/);
  assert.match(await page.textContent("#xResult"), /63,000원/);
  await shot(page, "phone-expense-check");
  await page.click("#btnXSubmit");
  assert.ok(await until(async () => (await serverDoc(`expenses/${a.id}`)).exists), "submitted");
  const subs = (await serverDoc(`expenses/${a.id}`)).data.subs, key = `${a.id}:${Object.keys(subs)[0]}`;
  assert.equal(Object.values(subs)[0].total, total);

  // 총무 approves (as the page's treasurer panel would)
  await vice.post("/api/db/set", { path: `reviews/${vice.id}`, data: { items: { [key]: { status: "approved", note: "다음 주 화요일 지급", paidAt: "", paidAmount: null, fp: "", by: "박총무", at: new Date().toISOString(), log: [] } } } });
  await page.waitForSelector(".acct-count:not([hidden])");
  assert.equal(await page.textContent(".acct-count"), "1");
  await page.click(".acct-bell");
  await page.waitForSelector(".acct-item.unread");
  assert.match(await page.textContent(".acct-item"), /사비 정산 승인 · 지급 대기/);
  await shot(page, "phone-notifications");
  await page.click(".acct-item");
  await page.waitForSelector("#dlgExp[open]");
  assert.match(await page.textContent("#expDetail"), /다음 주 화요일 지급/);
  await shot(page, "phone-expense-detail");
  assert.ok(await page.locator(".acct-count").isHidden(), "read");
  await ctx.close();
});

test("desktop and admin console screens", { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ baseURL: srv.base, viewport: { width: 1280, height: 900 } });
  const page = await signIn(ctx, "dev", "password1");
  await page.goto("/");
  await page.click("#tab-parts");
  await page.waitForSelector("#btnTemplate:visible");
  await page.click("#btnTemplate");
  await page.waitForSelector("#partsList:not([hidden])");
  await until(async () => (await page.textContent("#count")).startsWith("4"));
  await shot(page, "desktop-parts");
  for (const tab of ["backups", "settings"]) {
    await page.goto("/admin#" + tab);
    await page.waitForSelector(`#p-${tab}:not([hidden])`);
    await page.waitForTimeout(300);
    await shot(page, "admin-" + tab, true);
  }
  await page.goto("/admin#overview");
  await page.waitForSelector("#alerts .alert");
  assert.match(await page.textContent("#alerts"), /외부 복사가 설정되지 않았어요/);
  await ctx.close();
});

test("오늘 first screen, and switching to the TV screen and back", { skip, timeout: 90000 }, async () => {
  // parts with deadlines around today for the dev's department
  const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  await dev.post("/api/db/set", { path: "parts/late1", data: { name: "지연된 업라이트", dept: "chassis", stage: "machining", owner: "김개발", due: d(-2), qty: 1 } });
  await dev.post("/api/db/set", { path: "parts/soon1", data: { name: "곧 마감 브래킷", dept: "chassis", stage: "order", owner: "이에이", due: d(2), qty: 1 } });
  await dev.post("/api/db/set", { path: "logs/bad1", data: { sessionId: "s1", dept: "battery", status: "bad", observation: "셀 온도 과열", actionDone: false } });
  const ctx = await browser.newContext({ baseURL: srv.base, viewport: { width: 1280, height: 900 } });
  const page = await signIn(ctx, "dev", "password1");
  await page.goto("/");
  await page.waitForSelector("#view-today:not([hidden]) .tcard");
  assert.equal(await page.locator(".tcard").count(), 5);
  assert.match(await page.textContent('[data-today="late"]'), /지연된 업라이트/);
  assert.match(await page.textContent('[data-today="issues"]'), /문제 1/);
  await page.selectOption("#meDept", "chassis");
  await page.waitForSelector('.trow[data-part="late1"]');
  assert.match(await page.textContent('.trow[data-part="late1"]'), /D\+2/);
  assert.match(await page.textContent('.trow[data-part="late1"]'), /내 담당/, "parts I own are marked");
  await shot(page, "desktop-today");
  await page.click('[data-today="late"]');
  assert.equal(await page.getAttribute("#tab-parts", "aria-selected"), "true");
  assert.equal(await page.inputValue("#fst"), "late", "the card opens the parts list filtered to overdue parts");

  await page.click('.viewsw [data-view="tv"]');
  await page.waitForSelector("#tv:not([hidden]) .tv-dday");
  assert.match(await page.textContent("#tv"), /지연된 업라이트/);
  assert.match(await page.textContent("#tv"), /셀 온도 과열/);
  await shot(page, "tv");
  await page.reload();
  await page.waitForSelector("#tv:not([hidden]) .tv-dday");
  assert.ok(true, "the TV choice survives a reload (for the workshop monitor)");
  await dev.post("/api/db/update", { path: "parts/late1", data: { stage: "done" } });
  await page.waitForFunction(() => !document.getElementById("tv").textContent.includes("지연된 업라이트"));
  await page.keyboard.press("Escape");
  await page.waitForSelector("#tv", { state: "hidden" });
  assert.equal(await page.getAttribute('.viewsw [data-view="normal"]', "aria-pressed"), "true");
  await page.goto("/?view=tv");
  await page.waitForSelector("#tv:not([hidden])");
  await page.click('#tv [data-view="normal"]');
  await page.waitForSelector("#tv", { state: "hidden" });
  await ctx.close();
});

test("sign-up needs a department, and only a developer changes it later", { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ baseURL: srv.base, viewport: { width: 1280, height: 900 } });
  const login = await ctx.newPage();
  await login.goto("/login");
  await login.click('[data-tab="signup"]');
  assert.equal(await login.getAttribute("#sDept", "required"), "", "the department is a required field");
  await login.fill("#sName", "최신입"); await login.fill("#sUser", "newbie"); await login.fill("#sPw", "password-newbie");
  await login.click("#sBtn");
  assert.equal(await login.evaluate(() => document.getElementById("sDept").validity.valueMissing), true);
  assert.equal(await login.isVisible("#signupForm"), true, "the form is not sent without a department");
  await login.close();

  const page = await signIn(ctx, "aaa", "password-aaa");
  await page.goto("/");
  await page.waitForSelector("#view-today:not([hidden])");
  assert.equal(await page.inputValue("#meDept"), "chassis", "the account's department is shown");
  assert.equal(await page.isDisabled("#meDept"), true, "a 팀원 can't change it");
  await dev.post(`/api/admin/users/${a.id}`, { dept: "aero" });
  await page.reload();
  await page.waitForSelector("#view-today:not([hidden])");
  assert.equal(await page.inputValue("#meDept"), "aero", "a developer's change shows up on the next load");
  await dev.post(`/api/admin/users/${a.id}`, { dept: "chassis" });
  await ctx.close();
});
