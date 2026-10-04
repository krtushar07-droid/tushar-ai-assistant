// Minimal service worker so browsers treat the site as installable.
// It does not cache anything, so your updates always show immediately.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
