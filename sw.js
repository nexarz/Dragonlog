// Service worker for DRAGON//LOG
// Strategy: cache shell on install; on fetch, try network first for HTML (so updates are fast),
// cache-first for other assets. Works offline once installed.

const CACHE = 'dragonlog-v3';

const VOICE_CLIPS = (() => {
  const list = [
    '1', '2', '3', '4', '5',
    '10sec', 'final-push',
    'rest', 'cooldown',
    'next-rest', 'next-cooldown',
    'workout-loaded', 'workout-complete',
    'alert-spm', 'alert-dps',
  ];
  for (let i = 1; i <= 10; i++) {
    list.push(`ps${i}-go`, `warmup-ps${i}`, `next-ps${i}`, `next-warmup-ps${i}`);
  }
  return list.map(n => `./voices/${n}.mp3`);
})();

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './modules/state.js',
  './modules/fusion.js',
  './modules/sensors.js',
  './modules/format.js',
  './modules/workout.js',
  './modules/player.js',
  './modules/audio.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  ...VOICE_CLIPS,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch((e) => {
      console.warn('Shell cache failed:', e);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache cross-origin (e.g. Google Fonts) — let the browser handle those.
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML documents so updates propagate
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // background refresh
        fetch(req).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res));
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      });
    })
  );
});
