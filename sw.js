const CACHE_NAME = "carie-ai-shell-v4";
const APP_FILES = [
  "./",
  "./index.html",
  "./config.js",
  "./i18n.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./images/welcome.jpg",
  "./images/technology.jpg",
  "./images/healthcare.jpg",
  "./images/creative.jpg",
  "./images/business.jpg",
  "./images/engineering.jpg",
  "./images/community.jpg"
];
// Always try the network first for these so a new deploy or config takes effect.
const NETWORK_FIRST = ["/index.html", "/config.js", "/i18n.js"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" || NETWORK_FIRST.some(path => url.pathname.endsWith(path))) {
    const key = event.request.mode === "navigate" ? "./index.html" : event.request;
    event.respondWith(fetch(event.request).then(response => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(key, copy)); }
      return response;
    }).catch(() => caches.match(key)));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)); }
    return response;
  })));
});
