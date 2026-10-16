// Service worker: lets the pit board open with no signal (at the track). The page itself and its scripts are
// fetched from the network first and fall back to the last copy; data comes from the runtime's own offline cache.
// API calls, attachments and the live stream are never cached here.
const CACHE = "fsk-shell-v1";
const SHELL = ["/fsk-runtime.js", "/vendor/jszip.min.js", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req, key) {
  try {
    const res = await fetch(req);
    // keep only real pages: never a redirect to /login or an error
    if (res.ok && !res.redirected && res.type === "basic") (await caches.open(CACHE)).put(key, res.clone());
    return res;
  } catch {
    const hit = await caches.match(key);
    return hit || Response.error();
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && url.pathname === "/") { e.respondWith(networkFirst(req, "/")); return; }
  if (SHELL.includes(url.pathname)) e.respondWith(networkFirst(req, url.pathname));
});

// Logging out clears the saved page (it carries the signed-in name).
self.addEventListener("message", (e) => {
  if (e.data === "fsk-logout") e.waitUntil(caches.delete(CACHE));
});
