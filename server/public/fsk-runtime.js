// Runtime shim: gives index.html the same window.claude.use(...) API it has on claude.ai,
// backed by this server (REST + Server-Sent Events). Loaded before the page script.
// On top of that: an offline cache and write queue (the track often has no signal), the notification bell,
// and the installable-app service worker.
(() => {
  const ME = window.__FSK_ME;
  if (!ME) return;
  // level: 4 developer, 3 임원진 (팀장·부팀장·파트장), 2 팀원 — computed by the server.
  const level = ME.level || 0;

  // The page keeps "who am I" in localStorage; seed it from the signed-in account.
  // The department belongs to the account (only a developer changes it), so it always overwrites what the browser had.
  try { localStorage.setItem("fsk.me.name", ME.name || ""); localStorage.setItem("fsk.me.dept", ME.dept || ""); } catch {}

  const toLogin = () => { location.href = "/login?next=" + encodeURIComponent(location.pathname); };
  const net = { offline: !navigator.onLine };
  const offlineError = () => ({ code: "unavailable", offline: true, message: "서버에 연결할 수 없어요." });
  function setOffline(v) { if (net.offline !== v) { net.offline = v; syncUi(); } }
  async function api(method, url, body) {
    const init = { method, credentials: "same-origin", headers: { "x-fsk": "1" } };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, init); } catch { setOffline(true); throw offlineError(); }
    // the tunnel answers but the server behind it is down
    if (r.status === 502 || r.status === 503 || r.status === 504) { setOffline(true); throw offlineError(); }
    setOffline(false);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { toLogin(); throw { code: "revoked", message: j.message || "로그인이 필요해요." }; }
    if (!r.ok) throw { code: j.code || "unavailable", message: j.message || r.statusText, status: r.status };
    return j;
  }
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const checkPath = (p, even) => {
    const segs = String(p).split("/");
    if (!p || segs.some((s) => !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s) || s === "." || s === "..") || (segs.length % 2 === 0) !== even)
      throw new TypeError(`${even ? "document" : "collection"} path has the wrong shape: ${p}`);
  };
  const parentOf = (path) => path.split("/").slice(0, -1).join("/");
  const merge = (base, patch) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? merge(out[k], v) : v;
    return out;
  };
  let noticeTimer;
  function notice(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  // ---------- offline cache (IndexedDB, one database per account) ----------
  const local = (() => {
    let opening = null;
    const open = () => opening || (opening = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error("no indexedDB"));
      const r = indexedDB.open("fsk-" + ME.id, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = (mode, fn) => open().then((d) => new Promise((res, rej) => {
      const t = d.transaction("kv", mode), req = fn(t.objectStore("kv"));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error);
    }));
    return { get: (k) => run("readonly", (s) => s.get(k)).catch(() => undefined), set: (k, v) => run("readwrite", (s) => s.put(v, k)).catch(() => {}) };
  })();
  const known = new Map(); // path -> last known data (null = deleted)
  // query results waiting to be saved (live updates come in bursts); saved at once when the page is hidden
  const pendingSaves = new Map();
  const flushSaves = () => { pendingSaves.forEach((fn) => fn()); pendingSaves.clear(); };
  addEventListener("pagehide", flushSaves);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSaves(); });

  // ---------- write queue ----------
  // Writes made while offline are applied on screen at once, kept on this device, and sent in order when the
  // server is reachable again. Writes the server refuses then (no permission, deleted meanwhile) are dropped.
  // The queue lives in localStorage, which saves synchronously: closing the app right after a change keeps it.
  // IndexedDB is the fallback when localStorage is unavailable or full.
  const OUTBOX_KEY = "fsk.outbox." + ME.id;
  let outbox = [], flushing = false, toldOffline = false, inIdb = false;
  try { const v = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); if (Array.isArray(v)) outbox = v; } catch {}
  function saveOutbox() {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); if (inIdb) { inIdb = false; local.set("outbox", []); } return; } catch {}
    inIdb = true; local.set("outbox", outbox);
  }
  const outboxLoaded = local.get("outbox").then((v) => { if (Array.isArray(v) && v.length && !outbox.length) { outbox = v; inIdb = true; } syncUi(); });
  function overlayDoc(path, data) {
    let cur = data;
    for (const w of outbox) if (w.path === path) cur = w.op === "delete" ? null : w.op === "update" ? merge(cur || {}, w.data) : w.data;
    return cur;
  }
  function overlayQuery(map, collection) {
    for (const w of outbox) {
      if (parentOf(w.path) !== collection) continue;
      const cur = map.has(w.path) ? map.get(w.path).data : null;
      const next = w.op === "delete" ? null : w.op === "update" ? merge(cur || {}, w.data) : w.data;
      if (next) map.set(w.path, { id: w.path.split("/").pop(), path: w.path, data: next }); else map.delete(w.path);
    }
  }
  function applyLocal(path, data) {
    known.set(path, data);
    (docListeners.get(path) || []).forEach((l) => l.push(data ? { exists: true, data } : { exists: false }));
    queryListeners.forEach((q) => { if (q.collection === parentOf(path)) q.apply(path, data ? { id: path.split("/").pop(), data } : null); });
  }
  async function write(op, path, data) {
    await outboxLoaded;
    if (!outbox.length) {
      try { await api("POST", "/api/db/" + op, op === "delete" ? { path } : { path, data }); return; }
      catch (e) { if (!e.offline) throw e; }
    }
    const prev = known.has(path) ? known.get(path) : null;
    outbox.push({ op, path, data: op === "delete" ? null : data, at: new Date().toISOString() });
    saveOutbox();
    applyLocal(path, op === "delete" ? null : op === "update" ? merge(prev || {}, data) : data);
    if (!toldOffline) { toldOffline = true; notice("인터넷이 끊겨 있어요. 바꾼 내용은 이 기기에 저장해 두었다가 연결되면 올려요."); }
    syncUi();
  }
  async function flush() {
    await outboxLoaded;
    if (flushing || !outbox.length) return;
    flushing = true; syncUi();
    let sent = 0, refused = 0;
    try {
      while (outbox.length) {
        const w = outbox[0];
        try { await api("POST", "/api/db/" + w.op, w.op === "delete" ? { path: w.path } : { path: w.path, data: w.data }); sent++; }
        catch (e) { if (e.offline || e.code === "revoked") break; refused++; }
        outbox.shift(); saveOutbox();
      }
    } finally {
      flushing = false; syncUi();
      if (sent || refused) refetchAll();
      if (!outbox.length) toldOffline = false;
      if (refused) notice(`오프라인일 때 바꾼 내용 중 ${refused}개는 서버가 받아들이지 않았어요 (권한이 없거나 그 사이 지워진 항목).`);
      else if (sent && !outbox.length) notice(`오프라인일 때 바꾼 내용 ${sent}개를 모두 올렸어요.`);
    }
  }
  window.addEventListener("online", () => flush());
  setInterval(() => { if (outbox.length) flush(); }, 15000);

  // ---------- live stream ----------
  const docListeners = new Map(); // path -> Set<listener>
  const queryListeners = new Set();
  let es = null, opened = false, needRefetch = false;
  function stream() {
    if (es) return;
    es = new EventSource("/api/stream");
    es.addEventListener("open", () => { setOffline(false); if (opened || needRefetch) refetchAll(); opened = true; needRefetch = false; flush(); });
    es.addEventListener("change", (ev) => {
      const m = JSON.parse(ev.data), data = overlayDoc(m.path, m.doc ? m.doc.data : null);
      known.set(m.path, data);
      (docListeners.get(m.path) || []).forEach((l) => l.push(data ? { exists: true, data } : { exists: false }));
      queryListeners.forEach((q) => { if (q.collection === m.collection) q.apply(m.path, data ? { id: m.path.split("/").pop(), data } : null); });
    });
    es.addEventListener("notify", (ev) => onNotify(JSON.parse(ev.data)));
    es.addEventListener("profile", (ev) => onProfile(JSON.parse(ev.data)));
    es.addEventListener("reload", () => location.reload());
    es.addEventListener("error", () => { fetch("/api/me", { credentials: "same-origin" }).then((r) => { if (r.status === 401) toLogin(); }).catch(() => setOffline(true)); });
  }
  function refetchAll() { docListeners.forEach((set) => set.forEach((l) => l.fetch())); queryListeners.forEach((q) => q.fetch()); }

  const snapDoc = (id, exists, data, fromCache) => Object.freeze({ id, exists, data: () => (exists ? data : undefined), metadata: { fromCache: !!fromCache, hasPendingWrites: false } });
  function evalQuery(map, spec) {
    let list = [...map.values()];
    const where = spec.where || [];
    list = list.filter((d) => where.every(([f, op, v]) => {
      const x = d.data[f];
      return op === "==" ? x === v : op === "!=" ? x !== v : op === "<" ? x < v : op === "<=" ? x <= v : op === ">" ? x > v : op === ">=" ? x >= v
        : op === "in" ? v.includes(x) : op === "not-in" ? !v.includes(x) : op === "array-contains" ? Array.isArray(x) && x.includes(v) : false;
    }));
    const cmp = (a, b) => (a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a < b ? -1 : 1);
    if (spec.orderBy) { const dir = spec.orderBy.dir === "desc" ? -1 : 1, f = spec.orderBy.field; list.sort((a, b) => a.data[f] === undefined ? 1 : b.data[f] === undefined ? -1 : dir * cmp(a.data[f], b.data[f])); }
    else list.sort((a, b) => cmp(a.id, b.id));
    if (spec.limit) list = list.slice(0, spec.limit);
    return list;
  }
  function querySnapshot(list, fromCache) {
    const d = list.map((x) => snapDoc(x.id, true, x.data, fromCache));
    return Object.freeze({ docs: d, size: d.length, empty: !d.length, docChanges: () => d.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })), metadata: { fromCache: !!fromCache, hasPendingWrites: false } });
  }

  // ---------- db ----------
  function docRef(path) {
    checkPath(path, true);
    const id = path.split("/").pop();
    const remember = (exists, data) => { known.set(path, exists ? data : null); local.set("d:" + path, { exists, data: exists ? data : null }); };
    async function cached() {
      if (known.has(path)) { const v = known.get(path); return { exists: v !== null, data: v }; }
      return local.get("d:" + path);
    }
    return {
      id, path,
      async get() {
        try { const r = await api("GET", "/api/db/doc?path=" + encodeURIComponent(path)); remember(r.exists, r.data); const v = overlayDoc(path, r.exists ? r.data : null); return snapDoc(id, v !== null, v); }
        catch (e) { if (!e.offline) throw e; const c = await cached(); if (!c) throw e; const v = overlayDoc(path, c.exists ? c.data : null); return snapDoc(id, v !== null, v, true); }
      },
      set: (data) => write("set", path, data),
      update: (data) => write("update", path, data),
      delete: () => write("delete", path),
      async acquire(o) { return { acquired: true, holder: o && o.holder, expiresAt: new Date(Date.now() + 30000).toISOString() }; },
      collection(sub) { return collRef(path + "/" + sub); },
      onSnapshot(next, error) {
        stream();
        let dead = false;
        const l = {
          fetch: () => api("GET", "/api/db/doc?path=" + encodeURIComponent(path)).then((r) => {
            remember(r.exists, r.data);
            const v = overlayDoc(path, r.exists ? r.data : null);
            if (!dead) next(snapDoc(id, v !== null, v));
          }).catch(async (e) => {
            if (dead) return;
            if (e.offline) { needRefetch = true; const c = await cached(); if (c && !dead) { const v = overlayDoc(path, c.exists ? c.data : null); next(snapDoc(id, v !== null, v, true)); } return; }
            if (error) error(e);
          }),
          push: (s) => { if (!dead) next(snapDoc(id, s.exists, s.data)); }
        };
        if (!docListeners.has(path)) docListeners.set(path, new Set());
        docListeners.get(path).add(l);
        l.fetch();
        return () => { dead = true; docListeners.get(path)?.delete(l); };
      }
    };
  }
  function query(collection, spec) {
    const key = "q:" + collection + ":" + JSON.stringify(spec);
    return {
      where: (f, op, v) => query(collection, { ...spec, where: [...(spec.where || []), [f, op, v]] }),
      orderBy: (field, dir) => query(collection, { ...spec, orderBy: { field, dir: dir || "asc" } }),
      limit: (n) => query(collection, { ...spec, limit: n }),
      async get() {
        const map = new Map();
        try { (await api("POST", "/api/db/query", { collection, ...spec })).docs.forEach((d) => map.set(d.path, d)); overlayQuery(map, collection); return querySnapshot(evalQuery(map, spec)); }
        catch (e) { if (!e.offline) throw e; const c = await local.get(key); if (!c) throw e; c.forEach((d) => map.set(d.path, d)); overlayQuery(map, collection); return querySnapshot(evalQuery(map, spec), true); }
      },
      onSnapshot(next, error) {
        stream();
        let dead = false, fromCache = false;
        const map = new Map();
        const save = () => local.set(key, [...map.values()]);
        const persist = () => { if (!pendingSaves.has(key)) { pendingSaves.set(key, save); setTimeout(() => { if (pendingSaves.get(key) === save) { pendingSaves.delete(key); save(); } }, 300); } };
        const emit = () => { if (!dead) next(querySnapshot(evalQuery(map, spec), fromCache)); };
        const q = {
          collection,
          fetch: () => api("POST", "/api/db/query", { collection, ...spec }).then((r) => {
            map.clear();
            r.docs.forEach((d) => { map.set(d.path, d); known.set(d.path, d.data); });
            save(); overlayQuery(map, collection); fromCache = false; emit();
          }).catch(async (e) => {
            if (dead) return;
            if (e.offline) {
              needRefetch = true;
              if (!map.size) { const c = await local.get(key); if (c && !dead) { c.forEach((d) => { map.set(d.path, d); if (!known.has(d.path)) known.set(d.path, d.data); }); overlayQuery(map, collection); fromCache = true; emit(); } }
              return;
            }
            if (error) error(e);
          }),
          apply: (path, doc) => { if (doc) map.set(path, { id: doc.id, path, data: doc.data }); else map.delete(path); persist(); emit(); }
        };
        queryListeners.add(q);
        q.fetch();
        return () => { dead = true; queryListeners.delete(q); };
      }
    };
  }
  function collRef(path) {
    checkPath(path, false);
    return Object.assign(query(path, {}), {
      path,
      doc: (id) => docRef(path + "/" + (id || rid())),
      async add(data) { const ref = docRef(path + "/" + rid()); await ref.set(data); return ref; }
    });
  }
  const dbNs = Object.freeze({ doc: docRef, collection: collRef });

  // ---------- user ----------
  let people = null, peopleAt = 0;
  async function loadPeople() {
    if (!people || Date.now() - peopleAt > 30000) {
      try { people = (await api("GET", "/api/users/public")).users; peopleAt = Date.now(); local.set("people", people); }
      catch (e) { if (!e.offline) throw e; people = people || (await local.get("people")) || []; }
    }
    return people;
  }
  const colorOf = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 45%)`; };
  const avatar = (name, color) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${color}"/><text x="32" y="41" font-size="26" text-anchor="middle" fill="#fff" font-family="sans-serif">${(name || "?").slice(0, 1).replace(/[<&]/g, "")}</text></svg>`);
  const profile = (u, id) => { const color = colorOf(id); return { id, name: u ? u.name : "", avatarUrl: avatar(u && u.name, color), color, email: null, isMe: id === ME.id, guest: false }; };
  const userNs = Object.freeze({
    isOwner: async () => ME.role === "developer",
    canEdit: async () => level >= 3,
    can: async (n) => n === "data.write" || n === "assets.write" ? level >= 2 : n === "files.write" ? level >= 4 : false,
    id: async () => ME.id,
    name: async () => ME.name,
    email: async () => null,
    avatarUrl: async () => avatar(ME.name, colorOf(ME.id)),
    me: async () => ({ id: ME.id, name: ME.name, avatarUrl: avatar(ME.name, colorOf(ME.id)), color: colorOf(ME.id), email: null, isOwner: ME.role === "developer", canEdit: level >= 3 }),
    async profiles(ids) { const list = await loadPeople(); const arr = Array.isArray(ids) ? ids : [ids]; return Object.fromEntries([...new Set(arr)].map((id) => [id, profile(list.find((u) => u.id === id), id)])); },
    async search(q) { const list = await loadPeople(); const s = String(q || "").toLowerCase(); return list.filter((u) => !s || u.name.toLowerCase().includes(s)).slice(0, 8).map((u) => profile(u, u.id)); }
  });

  // ---------- assets ----------
  const assetsNs = Object.freeze({
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type;
      let r;
      try { r = await fetch("/api/assets", { method: "POST", credentials: "same-origin", headers: { "x-fsk": "1", "content-type": type, "x-file-name": encodeURIComponent(blob.name || "") }, body: blob }); }
      catch { setOffline(true); throw { code: "store_unavailable", message: "서버에 연결할 수 없어요. 파일은 연결된 뒤에 올려 주세요." }; }
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { toLogin(); throw { code: "upstream_auth", message: "로그인이 필요해요." }; }
      if (r.status === 413) throw { code: "too_large", message: j.message || "파일이 너무 커요." };
      if (!r.ok) throw { code: j.code || "upstream_error", message: j.message || r.statusText };
      return j;
    },
    list: () => api("GET", "/api/assets"),
    async delete(id) { return api("DELETE", "/api/assets/" + encodeURIComponent(String(id).replace(/^\/_blob\//, ""))); }
  });

  // ---------- downloads ----------
  const downloadsNs = Object.freeze({
    async save({ filename, data }) {
      if (!filename || data === undefined || data === null) throw { code: "bad_request", message: "filename and data are required" };
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { status: "saved" };
    }
  });

  const namespaces = { db: dbNs, user: userNs, assets: level >= 2 ? assetsNs : null, downloads: downloadsNs };
  window.claude = Object.freeze({ use: (name) => new Promise((resolve) => setTimeout(() => resolve(namespaces[name] ?? null), 0)) });
  window.FSK_SELF_HOSTED = true;

  // A developer changed this account's name or department: update the account bar and tell the page (index.html
  // listens for "fsk:profile"), so open screens follow without a reload.
  function onProfile(p) {
    ME.name = p.name; ME.dept = p.dept;
    try { localStorage.setItem("fsk.me.name", ME.name || ""); localStorage.setItem("fsk.me.dept", ME.dept || ""); } catch {}
    const b = document.querySelector(".acct-bar > b"); if (b) b.textContent = ME.name;
    const nameInput = document.getElementById("meName"); if (nameInput) nameInput.value = ME.name;
    window.dispatchEvent(new CustomEvent("fsk:profile", { detail: { name: ME.name, dept: ME.dept } }));
  }

  // ---------- notifications ----------
  const bell = { items: [], unread: 0 };
  const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "방금" : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`; };
  async function loadNotes() {
    try { const r = await api("GET", "/api/notifications?limit=30"); bell.items = r.items; bell.unread = r.unread; local.set("notes", r); }
    catch (e) { if (e.offline) { const c = await local.get("notes"); if (c) { bell.items = c.items; bell.unread = c.unread; } } }
    renderBell();
  }
  function onNotify(n) {
    bell.items = [n, ...bell.items.filter((x) => x.id !== n.id)].slice(0, 30); bell.unread = n.unread;
    renderBell();
    notice(`🔔 ${n.title}${n.body ? " · " + n.body : ""}`);
  }
  async function markRead(body) { try { bell.unread = (await api("POST", "/api/notifications/read", body)).unread; } catch {} }
  function go(link) {
    if (!link) return;
    if (link.href) { if (/^\/(?![/\\])/.test(link.href)) location.href = link.href; return; }
    const tab = link.tab && document.getElementById("tab-" + link.tab);
    if (tab) tab.click();
    const sel = link.exp ? `[data-exp="${CSS.escape(link.exp)}"]` : link.sid ? `.sitem[data-sid="${CSS.escape(link.sid)}"]` : link.part ? `.pname[data-part="${CSS.escape(link.part)}"]` : null;
    if (sel) setTimeout(() => { const el = document.querySelector(sel); if (el) el.click(); else notice("그 항목을 찾을 수 없어요. 지워졌거나 필터에 가려져 있을 수 있어요."); }, 80);
  }
  function renderBell() {
    const btn = document.querySelector(".acct-bell"), list = document.querySelector(".acct-list");
    if (!btn) return;
    const c = btn.querySelector(".acct-count");
    c.hidden = !bell.unread; c.textContent = bell.unread > 99 ? "99+" : String(bell.unread);
    btn.setAttribute("aria-label", bell.unread ? `알림 ${bell.unread}개 안 읽음` : "알림");
    try { if (navigator.setAppBadge) bell.unread ? navigator.setAppBadge(bell.unread) : navigator.clearAppBadge(); } catch {}
    list.replaceChildren(...(bell.items.length ? bell.items.map((n) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "acct-item" + (n.read ? "" : " unread"); b.dataset.nid = n.id;
      const t = document.createElement("b"); t.textContent = n.title;
      const body = document.createElement("span"); body.textContent = n.body || "";
      const at = document.createElement("time"); at.textContent = ago(n.at); at.dateTime = n.at;
      b.append(t, body, at);
      return b;
    }) : [Object.assign(document.createElement("p"), { className: "acct-empty", textContent: "아직 알림이 없어요. 사비 정산 처리, 내 기록에 달린 의견, 부품 마감과 일정이 여기에 와요." })]));
  }

  // ---------- account bar ----------
  function syncUi() {
    const el = document.querySelector(".acct-sync");
    if (!el) return;
    const n = outbox.length;
    el.hidden = !net.offline && !n;
    el.className = "acct-sync" + (net.offline ? " off" : "");
    el.textContent = flushing ? `올리는 중 · ${n}` : net.offline ? (n ? `오프라인 · 저장 대기 ${n}` : "오프라인") : `저장 대기 ${n}`;
    el.title = net.offline ? "서버에 연결되지 않았어요. 바꾼 내용은 이 기기에 저장되고, 연결되면 자동으로 올라가요." : "";
  }
  window.addEventListener("offline", () => setOffline(true));
  async function logout(btn) {
    if (outbox.length && !btn.classList.contains("armed")) { btn.classList.add("armed"); btn.textContent = `올리지 못한 변경 ${outbox.length}개가 사라져요. 한 번 더`; return; }
    await api("POST", "/api/auth/logout", {}).catch(() => {});
    // cached data and the saved page belong to this account: leave nothing behind on a shared device
    try { indexedDB.deleteDatabase("fsk-" + ME.id); localStorage.removeItem(OUTBOX_KEY); } catch {}
    try { navigator.serviceWorker?.controller?.postMessage("fsk-logout"); } catch {}
    try { if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k))); } catch {}
    location.href = "/login";
  }
  function accountBar() {
    const side = document.querySelector(".top-side");
    if (!side) return;
    const bar = document.createElement("div");
    bar.className = "acct-bar";
    bar.innerHTML = `<style>
      .acct-bar{position:relative;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--muted)}
      .acct-bar b{color:var(--ink);font-weight:600}
      .acct-bar .acct-role{border:1px solid var(--line);border-radius:999px;padding:0 8px}
      .acct-bar a,.acct-bar .acct-link{font:inherit;font-size:12px;color:var(--accent);background:none;border:0;padding:2px 4px;cursor:pointer;text-decoration:none}
      .acct-bar a:hover,.acct-bar .acct-link:hover{text-decoration:underline}
      .acct-bar .acct-link.armed{color:var(--bad);font-weight:600}
      .acct-bell{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:3px 10px;cursor:pointer;min-height:28px}
      .acct-bell:hover{border-color:var(--muted)}
      .acct-bell svg{width:14px;height:14px}
      .acct-count{background:var(--bad);color:#fff;border-radius:999px;padding:0 6px;font-size:11px;font-weight:600;line-height:16px}
      .acct-sync{border-radius:999px;padding:1px 9px;background:var(--accent-soft);color:var(--accent);font-weight:600}
      .acct-sync.off{background:var(--warn-soft);color:var(--warn)}
      .acct-pop{position:absolute;right:0;top:calc(100% + 6px);width:min(360px,calc(100vw - 32px));max-height:min(480px,70vh);overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 32px rgba(8,12,18,.18);z-index:30;text-align:left}
      .acct-pop-h{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface)}
      .acct-list{display:flex;flex-direction:column}
      .acct-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;padding:10px 12px;cursor:pointer;font:inherit;font-size:13px;color:var(--ink)}
      .acct-item:hover{background:var(--surface-2)}
      .acct-item b{font-weight:500}
      .acct-item.unread b{font-weight:700}
      .acct-item.unread{box-shadow:inset 3px 0 0 var(--accent)}
      .acct-item span{grid-column:1;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
      .acct-item time{grid-row:1;grid-column:2;color:var(--muted);font-size:11px;white-space:nowrap}
      .acct-empty{padding:16px 12px;color:var(--muted);font-size:13px;margin:0}
      @media (max-width:900px){.acct-pop{left:0;right:auto}}
      @media (max-width:600px){.acct-pop{position:fixed;left:12px;right:12px;top:auto;width:auto;margin-top:6px}.acct-bar>b,.acct-bar .acct-role,.acct-bar a{display:none}}
    </style><b></b><span class="acct-role"></span>
      <button type="button" class="acct-bell" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>알림<span class="acct-count" hidden></span></button>
      <span class="acct-sync" hidden></span>
      ${ME.role === "developer" ? '<a href="/admin">관리 창</a>' : ""}<button type="button" class="acct-link" data-logout>로그아웃</button>
      <div class="acct-pop" hidden><div class="acct-pop-h"><b>알림</b><button type="button" class="acct-link" data-readall>모두 읽음</button></div><div class="acct-list"></div></div>`;
    bar.querySelector("b").textContent = ME.name;
    bar.querySelector(".acct-role").textContent = ME.title || "팀원";
    const pop = bar.querySelector(".acct-pop"), bellBtn = bar.querySelector(".acct-bell");
    const setOpen = (open) => { pop.hidden = !open; bellBtn.setAttribute("aria-expanded", String(open)); };
    bellBtn.addEventListener("click", (e) => { e.stopPropagation(); setOpen(pop.hidden); if (!pop.hidden) loadNotes(); });
    bar.querySelector("[data-readall]").addEventListener("click", async () => { bell.items.forEach((n) => { n.read = true; }); bell.unread = 0; renderBell(); await markRead({ all: true }); renderBell(); });
    bar.querySelector(".acct-list").addEventListener("click", async (e) => {
      const it = e.target.closest("[data-nid]"); if (!it) return;
      const n = bell.items.find((x) => String(x.id) === it.dataset.nid);
      setOpen(false);
      if (n && !n.read) { n.read = true; bell.unread = Math.max(0, bell.unread - 1); renderBell(); markRead({ ids: [n.id] }); }
      if (n) go(n.link);
    });
    document.addEventListener("click", (e) => { if (!pop.hidden && !bar.contains(e.target)) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { setOpen(false); bellBtn.focus(); } });
    bar.querySelector("[data-logout]").addEventListener("click", (e) => logout(e.currentTarget));
    side.prepend(bar);
    const nameInput = document.getElementById("meName");
    // the account name is shown in the bar above; the page's own name field is only for claude.ai
    if (nameInput) { nameInput.value = ME.name; nameInput.readOnly = true; const box = nameInput.closest(".me"); if (box) box.hidden = true; }
    const deptSel = document.getElementById("meDept");
    // 팀원 can't change their own department: a developer does it in /admin (or here, for their own account)
    if (deptSel && level >= 4) deptSel.addEventListener("change", () => api("POST", "/api/me/profile", { dept: deptSel.value }).catch(() => {}));
    else if (deptSel) { deptSel.disabled = true; deptSel.title = "부서는 개발자만 바꿀 수 있어요"; }
    renderBell(); syncUi(); loadNotes(); stream();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", accountBar); else accountBar();

  // installable app + opening with no signal (needs HTTPS, or localhost)
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
