// Substituído pelo service worker principal (../sw.js), que já guarda estes arquivos para uso offline.
// Esta versão só remove o registro antigo, sem apagar caches.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.registration.unregister());
});
