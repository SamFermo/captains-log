// Learning Lab offline cache. Network first (so updates arrive), cached copy when offline,
// slow (4 s) or failing.
const CACHE = "lab-86f15c702f";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("lab-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const cached = () => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"));
  e.respondWith(new Promise(resolve => {
    let done = false; const finish = r => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => cached().then(r => { if (r) finish(r); }), 4000);
    fetch(req, { cache: "no-cache" }).then(res => {
      clearTimeout(timer);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); finish(res); }
      else cached().then(r => finish(r || res));
    }).catch(() => { clearTimeout(timer); cached().then(r => finish(r || Response.error())); });
  }));
});
