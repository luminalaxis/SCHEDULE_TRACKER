// Runtime shim: gives index.html the same window.claude.use(...) API it has on claude.ai,
// backed by this server (REST + Server-Sent Events). Loaded before the page script.
(() => {
  const ME = window.__FSK_ME;
  if (!ME) return;
  // level: 4 developer, 3 임원진 (팀장·부팀장·파트장), 2 팀원 — computed by the server.
  const level = ME.level || 0;

  // The page keeps "who am I" in localStorage; seed it from the signed-in account.
  try { localStorage.setItem("fsk.me.name", ME.name || ""); if (ME.dept) localStorage.setItem("fsk.me.dept", ME.dept); } catch {}

  const toLogin = () => { location.href = "/login?next=" + encodeURIComponent(location.pathname); };
  async function api(method, url, body) {
    const init = { method, credentials: "same-origin", headers: { "x-fsk": "1" } };
    if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, init); } catch { throw { code: "unavailable", message: "서버에 연결할 수 없어요." }; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { toLogin(); throw { code: "revoked", message: j.message || "로그인이 필요해요." }; }
    if (!r.ok) throw { code: j.code || "unavailable", message: j.message || r.statusText };
    return j;
  }
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const checkPath = (p, even) => {
    const segs = String(p).split("/");
    if (!p || segs.some((s) => !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s) || s === "." || s === "..") || (segs.length % 2 === 0) !== even)
      throw new TypeError(`${even ? "document" : "collection"} path has the wrong shape: ${p}`);
  };

  // ---------- live stream ----------
  const docListeners = new Map(); // path -> Set<listener>
  const queryListeners = new Set();
  let es = null, opened = false;
  function stream() {
    if (es) return;
    es = new EventSource("/api/stream");
    es.addEventListener("open", () => { if (opened) refetchAll(); opened = true; });
    es.addEventListener("change", (ev) => {
      const m = JSON.parse(ev.data);
      (docListeners.get(m.path) || []).forEach((l) => l.push(m.doc ? { exists: true, data: m.doc.data } : { exists: false }));
      queryListeners.forEach((q) => { if (q.collection === m.collection) q.apply(m.path, m.doc); });
    });
    es.addEventListener("reload", () => location.reload());
    es.addEventListener("error", () => { fetch("/api/me", { credentials: "same-origin" }).then((r) => { if (r.status === 401) toLogin(); }).catch(() => {}); });
  }
  function refetchAll() { docListeners.forEach((set) => set.forEach((l) => l.fetch())); queryListeners.forEach((q) => q.fetch()); }

  const snapDoc = (id, exists, data) => Object.freeze({ id, exists, data: () => (exists ? data : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
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
  function querySnapshot(list) {
    const d = list.map((x) => snapDoc(x.id, true, x.data));
    return Object.freeze({ docs: d, size: d.length, empty: !d.length, docChanges: () => d.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } });
  }

  // ---------- db ----------
  function docRef(path) {
    checkPath(path, true);
    const id = path.split("/").pop();
    return {
      id, path,
      async get() { const r = await api("GET", "/api/db/doc?path=" + encodeURIComponent(path)); return snapDoc(id, r.exists, r.data); },
      async set(data) { await api("POST", "/api/db/set", { path, data }); },
      async update(data) { await api("POST", "/api/db/update", { path, data }); },
      async delete() { await api("POST", "/api/db/delete", { path }); },
      async acquire(o) { return { acquired: true, holder: o && o.holder, expiresAt: new Date(Date.now() + 30000).toISOString() }; },
      collection(sub) { return collRef(path + "/" + sub); },
      onSnapshot(next, error) {
        stream();
        let dead = false;
        const l = {
          fetch: () => api("GET", "/api/db/doc?path=" + encodeURIComponent(path)).then((r) => { if (!dead) next(snapDoc(id, r.exists, r.data)); }).catch((e) => { if (!dead && error && e.code !== "unavailable") error(e); }),
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
    return {
      where: (f, op, v) => query(collection, { ...spec, where: [...(spec.where || []), [f, op, v]] }),
      orderBy: (field, dir) => query(collection, { ...spec, orderBy: { field, dir: dir || "asc" } }),
      limit: (n) => query(collection, { ...spec, limit: n }),
      async get() { const r = await api("POST", "/api/db/query", { collection, ...spec }); return querySnapshot(r.docs); },
      onSnapshot(next, error) {
        stream();
        let dead = false;
        const map = new Map();
        const emit = () => { if (!dead) next(querySnapshot(evalQuery(map, spec))); };
        const q = {
          collection,
          fetch: () => api("POST", "/api/db/query", { collection, ...spec }).then((r) => { map.clear(); r.docs.forEach((d) => map.set(d.path, d)); emit(); })
            .catch((e) => { if (!dead && error && e.code !== "unavailable") error(e); }),
          apply: (path, doc) => { if (doc) map.set(path, { id: doc.id, path, data: doc.data }); else map.delete(path); emit(); }
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
    if (!people || Date.now() - peopleAt > 30000) { people = (await api("GET", "/api/users/public")).users; peopleAt = Date.now(); }
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
      catch { throw { code: "store_unavailable", message: "서버에 연결할 수 없어요." }; }
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

  // ---------- account bar ----------
  function accountBar() {
    const side = document.querySelector(".top-side");
    if (!side) return;
    const bar = document.createElement("div");
    bar.className = "acct-bar";
    bar.innerHTML = `<style>
      .acct-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--muted)}
      .acct-bar b{color:var(--ink);font-weight:600}
      .acct-bar .acct-role{border:1px solid var(--line);border-radius:999px;padding:0 8px}
      .acct-bar a,.acct-bar button{font:inherit;font-size:12px;color:var(--accent);background:none;border:0;padding:2px 4px;cursor:pointer;text-decoration:none}
      .acct-bar a:hover,.acct-bar button:hover{text-decoration:underline}
    </style><b></b><span class="acct-role"></span>${ME.role === "developer" ? '<a href="/admin">관리 창</a>' : ""}<button type="button" data-logout>로그아웃</button>`;
    bar.querySelector("b").textContent = ME.name;
    bar.querySelector(".acct-role").textContent = ME.title || "팀원";
    bar.querySelector("[data-logout]").addEventListener("click", async () => { await api("POST", "/api/auth/logout", {}).catch(() => {}); location.href = "/login"; });
    side.prepend(bar);
    const nameInput = document.getElementById("meName");
    if (nameInput) { nameInput.value = ME.name; nameInput.readOnly = true; nameInput.title = "계정 이름이에요. 관리 창에서 바꿀 수 있어요."; }
    const deptSel = document.getElementById("meDept");
    if (deptSel) deptSel.addEventListener("change", () => api("POST", "/api/me/profile", { dept: deptSel.value }).catch(() => {}));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", accountBar); else accountBar();
})();
