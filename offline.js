const cacheName = "genzheshuo-share-1";
const shell = ["./","./index.html","./app.js","./screen.css","./icon.png","./manifest.webmanifest","./follower.js","./recorder.js","./script-file.js","./storage-worker.js","./microphone.js","./voice-worker.js","./vendor/fflate.js","./vendor/sherpa/index.js","./vendor/sherpa/tokens-wFJ0vjND.js","./vendor/sherpa/asr-B3QtWJoU.js"];
const models = ["./models/encoder.onnx","./models/decoder.onnx","./models/joiner.onnx","./models/pinyin.json","./models/tokens.txt","./vendor/sherpa/prebuilt/asr.wasm"];
const entries = new Set(shell.concat(models).map(name => new URL(name,self.registration.scope).href));

self.addEventListener("install",event => {
  event.waitUntil((async () => {
    await (await caches.open(cacheName)).addAll(shell);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate",event => { event.waitUntil(self.clients.claim()); });

self.addEventListener("fetch",event => {
  const request = event.request;
  if (request.method !== "GET" || !entries.has(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const saved = await cache.match(request);
    if (saved) return saved;
    const response = await fetch(request);
    if (response.ok && !response.redirected) {
      await cache.put(request,response.clone()).catch(() => {});
    }
    return response;
  })());
});
