/* 单词小勇士 离线缓存。更新应用时，把下面的版本号改一下 */
const CACHE = 'wordhero-v20';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './icons.js', './avatars.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // 只删旧版本的应用缓存；标准发音（wordhero-tts-…）下载一次很大，更新应用时要保留
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^wordhero-v\d+$/.test(k) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 有的托管平台会把 index.html 重定向到 /，Chrome 不允许页面导航使用"重定向过的"响应，断网时会打不开 → 重新包装一份
async function clean(r) {
  if (!r || !r.redirected) return r;
  const body = await r.blob();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
// 先用缓存（断网也能秒开），同时在后台联网更新缓存，下次打开就是新版本
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 发音引擎的文件由引擎自己下载和缓存，这里不管
  if (/\/tts\//.test(url.pathname) || /\/tts-audio\//.test(url.pathname)) return;
  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await clean(await cache.match(key, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' ? await cache.match('./') : null));
    const net = fetch(req).then(async r => { if (r && r.ok && r.type === 'basic') { const c = await clean(r.clone()); await cache.put(key, c); } return r; }).catch(() => hit);
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.then(r => r || new Response('离线中，且还没有缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }));
});
