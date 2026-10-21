// Only the test site's static shell is cached. API requests always use the network.
const PREFIX = 'sunday-open-test-shell:' + self.registration.scope + ':';
const CACHE = PREFIX + '__PREVIEW_VERSION__';
const HOME = new URL('index.html', self.registration.scope).href;
const FILES = ['index.html', 'workspace-sync.__PREVIEW_VERSION__.js', 'preview-offline.__PREVIEW_VERSION__.js']
  .map(file => new URL(file, self.registration.scope).href);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map(url => new Request(url, {cache: 'reload'})));
    const html = await (await cache.match(HOME)).text();
    if (!html.includes('workspace-sync.__PREVIEW_VERSION__.js')) {
      await caches.delete(CACHE);
      throw new Error('Test deployment is not ready yet');
    }
    // Keep the current shell until its tabs close; never reload unsaved editors.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== new URL(self.registration.scope).origin) return;
  const home = request.mode === 'navigate' &&
    (url.pathname === new URL(self.registration.scope).pathname || url.pathname === new URL(HOME).pathname);
  if (!home && !FILES.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(home ? HOME : request) || fetch(request);
  })());
});
