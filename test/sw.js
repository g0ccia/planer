/* Liefert Anhänge der Testfassung aus dem Browser-Speicher aus. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  /* Seite selbst immer frisch laden, damit neue Fassungen sofort ankommen */
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request, { cache: "no-store" }).catch(function () { return fetch(e.request); }));
    return;
  }
  var u = new URL(e.request.url);
  if (u.origin !== self.location.origin || u.pathname.indexOf("/_blob/") < 0) return;
  var key = u.origin + u.pathname;
  e.respondWith(caches.open("planer-blobs").then(function (c) {
    return c.match(key).then(function (r) { return r || new Response("", { status: 404 }); });
  }));
});
