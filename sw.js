/* Service Worker — 静态资源缓存优先；词表网络优先（保证数据更新能到达手机）
   听力音频单独放 sgwd-audio-* 缓存区：按需下载、版本升级不清除（否则每次发版都要重下几百 MB） */
const CACHE = 'sgwd-20260923-140232';
const AUDIO_CACHE = 'sgwd-audio-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './data/words.json',
  './data/meta.json',
  './data/readings.json',
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
      // 只清旧版本主缓存；音频缓存（sgwd-audio-*）保留
      Promise.all(keys.filter((k) => k !== CACHE && k.indexOf('sgwd-audio-') !== 0).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ---------- Web Push：接收推送并显示通知 ---------- */
self.addEventListener('push', (e) => {
  let data = { title: '🌸 该背单词了', body: '点开继续', url: './' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch (err) { /* 纯文本忽略 */ }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body || '',
      tag: data.tag || 'vocab',
      icon: './icons/icon-180.png',
      badge: './icons/icon-180.png',
      data: { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // 以 SW scope（/vocab-flash/）为 base 解析；用 origin 会丢子路径导致 404
  const target = new URL(e.notification.data && e.notification.data.url || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        // 已有窗口：聚焦并导航到通知指向的页面（如待办清单）
        if ('focus' in c) {
          c.focus();
          if ('navigate' in c) return c.navigate(target).catch(() => c);
          return c;
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isData = url.pathname.endsWith('/data/words.json') || url.pathname.endsWith('/data/meta.json')
    || url.pathname.endsWith('/data/readings.json') || url.pathname.indexOf('/data/listening/') >= 0;

  if (isData) {
    // 词表/索引/听力数据：网络优先，成功即刷新缓存；离线回落缓存
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

  // 听力音频：独立缓存区，按需下载后长期保留（缓存优先）
  if (url.pathname.indexOf('/audio/') >= 0) {
    e.respondWith(
      caches.open(AUDIO_CACHE).then((c) =>
        c.match(url.pathname).then((hit) => {
          if (hit) return hit;
          // 忽略 Range：整文件抓取后缓存（缓存半截的 206 会导致后续播放错乱）
          return fetch(new Request(url.href, { mode: 'same-origin', credentials: 'same-origin' }))
            .then((res) => {
              if (res && res.status === 200) {
                const copy = res.clone();
                c.put(url.pathname, copy);
              }
              return res;
            })
            .catch(() => Response.error());
        })
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
