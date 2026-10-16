// Moving claude.ai Artifact data to this server: claude.ai account ids differ from server account ids,
// so per-person documents (people/<id>, expenses/<id>, reviews/<id>) and every reference to an id are rewritten.

// Finds the claude.ai account ids an export refers to, with the best name we can find for each.
export function analyzeExport(rows, serverUsers = []) {
  const ids = new Map();
  const at = (id) => {
    if (typeof id !== "string" || !id) return null;
    if (!ids.has(id)) ids.set(id, { id, names: new Map(), where: new Set(), subs: 0 });
    return ids.get(id);
  };
  const name = (e, n, weight) => { if (e && typeof n === "string" && n.trim()) e.names.set(n.trim(), (e.names.get(n.trim()) || 0) + weight); };
  for (const { path, data } of rows) {
    const [col, id] = path.split("/");
    if (!data || typeof data !== "object") continue;
    if (col === "people" && id) { const e = at(id); e.where.add("사람 목록"); name(e, data.name, 100); }
    if (col === "expenses" && id) {
      const e = at(id); e.where.add("사비 내역서");
      for (const s of Object.values(data.subs || {})) { e.subs++; name(e, s && s.by, 10); }
    }
    if (col === "reviews" && id) {
      const e = at(id); e.where.add("총무 검토");
      for (const key of Object.keys(data.items || {})) { const owner = at(key.split(":")[0]); if (owner) owner.where.add("사비 내역서"); }
      for (const it of Object.values(data.items || {})) name(e, it && it.by, 5);
    }
    if (path === "config/roles") {
      if (data.ownerUid) at(data.ownerUid).where.add("소유자");
      for (const t of data.treasurers || []) { const e = at(t); if (e) e.where.add("총무"); }
    }
    if ((col === "history" || col === "checks") && typeof data.uid === "string" && data.uid) {
      const e = at(data.uid); e.where.add(col === "history" ? "변경 이력" : "점검 체크"); name(e, data.by, 1);
    }
  }
  const known = new Set(serverUsers.map((u) => u.id));
  const byName = new Map();
  for (const u of serverUsers) { const k = u.name.trim(); byName.set(k, byName.has(k) ? null : u.id); }
  return [...ids.values()].map((e) => {
    const best = [...e.names.entries()].sort((a, b) => b[1] - a[1])[0];
    const nm = best ? best[0] : "";
    return { id: e.id, name: nm, where: [...e.where], subs: e.subs, known: known.has(e.id), suggestion: known.has(e.id) ? e.id : (nm && byName.get(nm)) || "" };
  }).sort((a, b) => Number(a.known) - Number(b.known) || b.subs - a.subs || a.name.localeCompare(b.name, "ko"));
}

// Replaces old ids with new ones in document paths, object keys and string values.
// "old" → "new", and "old:..." → "new:..." (reviews items and history targets use "<uid>:<submission id>").
export function remapRows(rows, idMap) {
  const map = new Map(Object.entries(idMap || {}).filter(([a, b]) => a && typeof b === "string" && b && a !== b));
  if (!map.size) return rows;
  const str = (s) => {
    if (map.has(s)) return map.get(s);
    const i = s.indexOf(":");
    if (i > 0 && map.has(s.slice(0, i))) return map.get(s.slice(0, i)) + s.slice(i);
    return s;
  };
  const walk = (v) => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), walk(x)]));
    return v;
  };
  return rows.map((r) => ({ ...r, path: r.path.split("/").map(str).join("/"), data: walk(r.data) }));
}
