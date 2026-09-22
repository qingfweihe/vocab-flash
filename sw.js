/* Service Worker — 静态资源缓存优先；词表网络优先（保证数据更新能到达手机） */
const CACHE = 'sgwd-20260922-094633';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './data/words.json',
  './data/meta.json',
  './icons/icon-180.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // 逐项缓存：单个资源失败不影响其余（网络抖动时也能装上 SW）
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(ASSETS.map((u) => c.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ---------- Web Push：接收推送并显示通知 ---------- */
self.addEventListener('push', (e) => {
  let data = { title: '🌸 该背单词了', body: '点开继续' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (err) { /* 纯文本忽略 */ }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || '',
      tag: data.tag || 'vocab',
      icon: './icons/icon-180.png',
      badge: './icons/icon-180.png',
      data: { url: './' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isData = url.pathname.endsWith('/data/words.json') || url.pathname.endsWith('/data/meta.json');

  if (isData) {
    // 词表/索引：网络优先，成功即刷新缓存；离线回落缓存
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then((hit) =>
          hit || new Response('{"units":[]}', { headers: { 'Content-Type': 'application/json' } })
        )
      )
    );
    return;
  }

  // 其余资源：缓存优先；未命中抓网络并写入缓存
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => {
        // 仅导航请求回落首页；其他资源如实失败，避免把 HTML 当图片/脚本返回
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html').then((h) => h || Response.error());
        }
        return Response.error();
      });
    })
  );
});
