const shellCache = "genzheshuo-selfie-shell-2";
const modelCache = "genzheshuo-share-1";
const shell = ["./","./?v=2","./index.html","./app.js?v=2","./screen.css?v=2","./icon.png","./manifest.webmanifest","./follower.js","./recorder.js?v=2","./script-file.js","./storage-worker.js","./microphone.js","./voice-worker.js","./vendor/fflate.js","./vendor/sherpa/index.js","./vendor/sherpa/tokens-wFJ0vjND.js","./vendor/sherpa/asr-B3QtWJoU.js"];
const models = ["./models/encoder.onnx","./models/decoder.onnx","./models/joiner.onnx","./models/pinyin.json","./models/tokens.txt","./vendor/sherpa/prebuilt/asr.wasm"];
const urls = items => new Set(items.map(name => new URL(name,self.registration.scope).href));
const shellURLs = urls(shell);
const modelURLs = urls(models);

self.addEventListener("install",event => {
  event.waitUntil((async () => {
    const cache = await caches.open(shellCache);
    await cache.addAll([...shellURLs].map(url => new Request(url,{cache:"reload"})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate",event => { event.waitUntil(self.clients.claim()); });

self.addEventListener("fetch",event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const cacheName = shellURLs.has(request.url) ? shellCache : modelURLs.has(request.url) ? modelCache : null;
  if (!cacheName) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const saved = await cache.match(request);
    const navigation = request.mode === "navigate";
    if (saved && !navigation) return saved;
    try {
      const response = await fetch(request,navigation ? {cache:"no-cache"} : undefined);
      if (response.ok && !response.redirected) await cache.put(request,response.clone()).catch(() => {});
      return response.ok || !saved ? response : saved;
    } catch (error) {
      if (saved) return saved;
      throw error;
    }
  })());
});
