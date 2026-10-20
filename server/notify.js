// Notifications: per-person inbox (shown under the bell in the page, pushed live over SSE) and an optional
// team channel webhook (Discord or Slack) for team-wide events. Personal ones (payments) never go to the channel.
//
// Per person: 사비 정산 status changes → the submitter; new 사비 내역서 → 총무 (부팀장, else developers);
// a comment on a test log → the log's author and earlier commenters; parts due in ≤3 days, today, or overdue → the
// part's 담당 (the account picked as 담당, else an account with that name, else that department's 파트장); milestones at D-7, D-1, D-day → everyone
// (or that department); sign-up requests → developers.
// Team channel (if set up): milestones, a daily overdue-parts summary, new 주의/문제 test verdicts.

import { DEPARTMENTS } from "./depts.js";

export const WEBHOOK_HOSTS = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com", "hooks.slack.com"];
export const WEBHOOK_KINDS = { schedule: "일정 D-7 · D-1 · 당일", parts: "마감 지난 부품 (하루 한 번 요약)", issues: "테스트 주의·문제 판정" };
const DEPT = DEPARTMENTS;
const EXP_ST = { pending: "검토 대기", fix: "보완 요청", approved: "승인 · 지급 대기", paid: "지급 완료", rejected: "반려" };
const EXP_TITLE = { fix: "사비 정산 보완 요청", approved: "사비 정산 승인 · 지급 대기", paid: "사비 정산 지급 완료", rejected: "사비 정산 반려" };
const LEVEL = { ok: "양식 통과", warn: "확인 필요", bad: "양식 불일치" };
const KEEP_DAYS = 60;

const won = (n) => Math.round(Number(n) || 0).toLocaleString("ko-KR") + "원";
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayNo = (s) => { const [y, m, d] = String(s).split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const validDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const fmtDate = (s) => { const [y, m, d] = s.split("-"); return `${y}. ${Number(m)}. ${Number(d)}`; };
const short = (s) => { const [, m, d] = String(s || "").split("-"); return m ? `${Number(m)}/${Number(d)}` : ""; };
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function checkWebhookUrl(url, extraHosts = []) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return "웹훅 주소 형식이 올바르지 않아요."; }
  if (u.username || u.password) return "웹훅 주소에 사용자 이름이나 비밀번호를 넣을 수 없어요.";
  if (![...WEBHOOK_HOSTS, ...extraHosts].includes(u.hostname)) return "Discord 또는 Slack 웹훅 주소만 쓸 수 있어요 (discord.com, hooks.slack.com).";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && extraHosts.includes(u.hostname))) return "웹훅 주소는 https로 시작해야 해요.";
  return null;
}

export function webhookBody(url, text) {
  const host = new URL(url).hostname, msg = clip(text, 1800);
  if (host === "hooks.slack.com") return { text: msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
  const safe = msg.replace(/@(everyone|here)/g, "@​$1");
  if (host.endsWith("discord.com") || host === "discordapp.com") return { content: safe, username: "FSK 피트보드", allowed_mentions: { parse: [] } };
  return { content: safe, text: safe };
}

export function createNotifier({ db, docs, auth, setting, setSetting, push, audit, extraHosts = [], now = () => new Date() }) {
  const q = {
    ins: db.prepare("INSERT OR IGNORE INTO notifications (user_id, at, kind, title, body, link, dedupe) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    list: db.prepare("SELECT id, at, kind, title, body, link, read_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?"),
    unread: db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL"),
    readOne: db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL"),
    readAll: db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL"),
    prune: db.prepare("DELETE FROM notifications WHERE at < ?"),
    logHas: db.prepare("SELECT 1 AS x FROM notify_log WHERE dedupe = ?"),
    logIns: db.prepare("INSERT OR IGNORE INTO notify_log (dedupe, at) VALUES (?, ?)"),
    logPrune: db.prepare("DELETE FROM notify_log WHERE at < ?")
  };
  const active = () => auth.list().filter((u) => u.status === "active");
  const named = (name) => { const n = String(name || "").trim(); return n ? active().filter((u) => u.name.trim() === n).map((u) => u.id) : []; };
  const partLeads = (dept) => active().filter((u) => u.position === "part_lead" && u.dept === dept).map((u) => u.id);
  const treasurers = () => { const v = active().filter((u) => u.position === "vice_lead").map((u) => u.id); return v.length ? v : active().filter((u) => u.role === "developer").map((u) => u.id); };
  const trusted = () => { const r = docs.get("config/roles")?.data || {}; return new Set([r.ownerUid, ...(r.treasurers || [])].filter(Boolean)); };
  const parseLink = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const unreadCount = (uid) => q.unread.get(uid).n;

  function notify(userIds, n, except) {
    const at = now().toISOString();
    let sent = 0;
    for (const uid of new Set(userIds)) {
      if (!uid || uid === except) continue;
      const u = auth.byId(uid);
      if (!u || u.status !== "active") continue;
      const title = clip(n.title, 120), body = clip(n.body, 300);
      const r = q.ins.run(uid, at, n.kind, title, body, n.link ? JSON.stringify(n.link) : null, n.dedupe || null);
      if (!r.changes) continue;
      sent++;
      push(uid, { id: Number(r.lastInsertRowid), at, kind: n.kind, title, body, link: n.link || null, read: false, unread: unreadCount(uid) });
    }
    return sent;
  }

  async function postWebhook(url, text) {
    let ok = false, status = "";
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(webhookBody(url, text)), signal: AbortSignal.timeout(8000), redirect: "error" });
      ok = r.ok; status = `HTTP ${r.status}`;
    } catch (e) { status = e && e.name === "TimeoutError" ? "시간 초과" : "연결 실패"; }
    setSetting("webhookLast", { at: now().toISOString(), ok, status });
    return { ok, status };
  }
  // Team channel. dedupe keys are recorded before sending so a slow webhook never sends twice.
  function sendTeam(kind, text, dedupe) {
    const url = setting("webhookUrl"), kinds = setting("webhookKinds") || [];
    if (!url || !kinds.includes(kind) || checkWebhookUrl(url, extraHosts)) return null;
    if (dedupe) { if (q.logHas.get(dedupe)) return null; q.logIns.run(dedupe, now().toISOString()); }
    return postWebhook(url, text);
  }

  function subOf(key) {
    const [owner, id] = key.split(":");
    return { owner, sub: (docs.get("expenses/" + owner)?.data?.subs || {})[id] || null };
  }

  function onReviews(ctx, reviewer, prev, next) {
    if (!trusted().has(reviewer)) return;
    const before = prev?.items || {}, after = next?.items || {};
    for (const [key, it] of Object.entries(after)) {
      if (!it || typeof it !== "object") continue;
      const old = before[key] || {}, st = EXP_ST[it.status] ? it.status : "pending", ost = EXP_ST[old.status] ? old.status : "pending";
      const { owner, sub } = subOf(key);
      const who = sub ? `${sub.applicant || sub.by || "이름 없음"} · ${won(it.override?.total ?? sub.total)}` : key;
      if (st !== ost) {
        audit(ctx, "expense.review", key, `${who} · ${EXP_ST[ost]} → ${EXP_ST[st]}${st === "paid" ? ` · 지급 ${won(it.paidAmount ?? sub?.total)} · ${it.paidAt || ""}` : ""}`);
        if (EXP_TITLE[st]) notify([owner], {
          kind: "expense." + st, title: EXP_TITLE[st],
          body: [who, st === "paid" && it.paidAmount != null ? `지급액 ${won(it.paidAmount)}` : "", it.note].filter(Boolean).join(" · "),
          link: { tab: "expense", exp: key }
        }, ctx?.user?.id);
      }
      if (!!it.deleted !== !!old.deleted) audit(ctx, it.deleted ? "expense.delete" : "expense.restore", key, who);
      if (it.override && it.override.replacedAt !== old.override?.replacedAt) audit(ctx, "expense.replace", key, `${who} → ${it.override.fileName || ""} ${won(it.override.total)}`);
    }
  }

  function onExpenses(ctx, owner, prev, next) {
    const before = prev?.subs || {};
    for (const [id, s] of Object.entries(next?.subs || {})) {
      if (before[id] || !s || typeof s !== "object") continue;
      notify(treasurers(), {
        kind: "expense.new", title: "새 사비 내역서",
        body: `${s.applicant || s.by || "이름 없음"} · ${won(s.total)} · ${LEVEL[s.check?.level] || ""}`,
        link: { tab: "expense", exp: `${owner}:${id}` }
      }, ctx?.user?.id);
    }
  }

  function onComment(ctx, prev, next) {
    if (prev || !next || typeof next.logId !== "string") return;
    const log = docs.get("logs/" + next.logId);
    if (!log) return;
    const others = docs.list("comments").filter((c) => c.data.logId === next.logId).map((c) => c.createdBy);
    const sess = typeof next.sessionId === "string" ? docs.get("sessions/" + next.sessionId)?.data : null;
    notify([log.createdBy, ...others], {
      kind: "comment", title: `${DEPT[log.data.dept] || ""} 기록에 새 의견`.trim(),
      body: `${next.author || ctx?.user?.name || ""}: ${next.text || ""}${sess ? ` (${short(sess.date)} ${sess.event || ""})` : ""}`,
      link: { tab: "sessions", sid: next.sessionId || log.data.sessionId || "" }
    }, ctx?.user?.id);
  }

  function onLog(id, prev, next) {
    if (!next || !["warn", "bad"].includes(next.status) || prev?.status === next.status) return;
    const sess = typeof next.sessionId === "string" ? docs.get("sessions/" + next.sessionId)?.data : null;
    const head = `${next.status === "bad" ? "🔴 문제" : "🟠 주의"} · ${DEPT[next.dept] || next.dept || ""}${sess ? ` · ${short(sess.date)} ${sess.event || ""}` : ""}`;
    sendTeam("issues", `${head}\n${clip(next.analysis || next.observation || "", 300)}${next.action ? `\n→ ${clip(next.action, 200)}` : ""}`, `issue:${id}:${next.status}`);
  }

  // Called after every successful write. Never throws: a notification problem must not fail the write.
  function onWrite(ctx, path, prev, next) {
    try {
      const [col, id] = path.split("/");
      if (path.split("/").length !== 2) return;
      if (col === "reviews") onReviews(ctx, id, prev, next);
      else if (col === "expenses" && next) onExpenses(ctx, id, prev, next);
      else if (col === "comments") onComment(ctx, prev, next);
      else if (col === "logs") onLog(id, prev, next);
    } catch (e) { console.error("notify failed", path, e); }
  }

  // Deadlines. Runs every 10 minutes; dedupe keys make each reminder fire once. Quiet before 08:00.
  function tick({ force = false } = {}) {
    const d = now();
    if (!force && d.getHours() < 8) return { skipped: true };
    const today = ymd(d), t = dayNo(today);
    let sent = 0;
    const late = [], dueToday = [];
    for (const p of docs.list("parts")) {
      const x = p.data;
      if (!validDay(x.due) || x.stage === "done") continue;
      const n = dayNo(x.due) - t;
      const bucket = n < 0 ? "late" : n === 0 ? "today" : n <= 3 ? "soon" : null;
      if (n < 0) late.push(x); else if (n === 0) dueToday.push(x);
      if (!bucket) continue;
      const picked = typeof x.ownerUid === "string" && active().some((u) => u.id === x.ownerUid) ? [x.ownerUid] : [];
      const to = picked.length ? picked : named(x.owner).length ? named(x.owner) : partLeads(x.dept);
      sent += notify(to, {
        kind: "part.due", title: bucket === "late" ? "마감 지난 부품" : bucket === "today" ? "오늘 마감인 부품" : `부품 마감 D-${n}`,
        body: `${x.name || "(이름 없음)"} · ${DEPT[x.dept] || ""} · 마감 ${fmtDate(x.due)}`, link: { tab: "parts", part: p.id }, dedupe: `due:${p.id}:${x.due}:${bucket}`
      });
    }
    if (late.length || dueToday.length) {
      const names = (list) => list.slice(0, 8).map((x) => `${x.name} (${DEPT[x.dept] || ""}${x.owner ? ", " + x.owner : ""})`).join(", ") + (list.length > 8 ? ` 외 ${list.length - 8}개` : "");
      sendTeam("parts", [late.length ? `📦 마감 지난 부품 ${late.length}개: ${names(late)}` : "", dueToday.length ? `⏰ 오늘 마감 ${dueToday.length}개: ${names(dueToday)}` : ""].filter(Boolean).join("\n"), `parts:${today}`);
    }
    for (const m of docs.list("milestones")) {
      const x = m.data;
      if (x.done || !validDay(x.date)) continue;
      const n = dayNo(x.date) - t, bucket = n === 7 ? "d7" : n === 1 ? "d1" : n === 0 ? "d0" : null;
      if (!bucket) continue;
      const label = n === 0 ? "D-DAY" : `D-${n}`, to = x.dept ? active().filter((u) => u.dept === x.dept).map((u) => u.id) : active().map((u) => u.id);
      const dedupe = `ms:${m.id}:${x.date}:${bucket}`;
      sent += notify(to, { kind: "milestone", title: `${label} · ${x.title || "일정"}`, body: `${fmtDate(x.date)} · ${x.kind || "일정"}${DEPT[x.dept] ? " · " + DEPT[x.dept] : ""}`, link: { tab: "schedule" }, dedupe });
      sendTeam("schedule", `🗓️ ${label} · ${x.title || "일정"} (${fmtDate(x.date)}${DEPT[x.dept] ? ", " + DEPT[x.dept] : ""})${x.note ? `\n${clip(x.note, 200)}` : ""}`, dedupe);
    }
    const cutoff = new Date(d.getTime() - KEEP_DAYS * 86400000).toISOString();
    q.prune.run(cutoff); q.logPrune.run(new Date(d.getTime() - 120 * 86400000).toISOString());
    return { sent };
  }

  return {
    notify, sendTeam, onWrite, tick, unreadCount,
    list: (uid, limit = 30) => q.list.all(uid, Math.max(1, Math.min(100, Number(limit) || 30))).map((r) => ({ id: r.id, at: r.at, kind: r.kind, title: r.title, body: r.body, link: parseLink(r.link), read: !!r.read_at })),
    markRead(uid, ids) {
      const at = now().toISOString();
      if (ids === "all") q.readAll.run(at, uid); else for (const id of ids) q.readOne.run(at, uid, Number(id));
      return unreadCount(uid);
    },
    testWebhook(url) { return postWebhook(url, "✅ FSK 피트보드 알림 테스트예요. 이 채널로 일정·부품 마감·테스트 이슈 알림이 와요."); }
  };
}
