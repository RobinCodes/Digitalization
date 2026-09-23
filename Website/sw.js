/* Knowledge Index — service worker.
 *
 * It exists for one reason: to receive a push and put a notification on screen
 * when no tab is open. It deliberately does NOT cache anything. An archive whose
 * notes are access-checked per request and compiled on demand is the wrong thing
 * to serve from a stale cache, and a caching bug here would be far more damaging
 * than the bandwidth it saves.
 *
 * Pushes arrive with no payload. That is by design on the server side — encrypting
 * a payload would drag in a crypto dependency, and more importantly it would put
 * message text through Mozilla's or Google's push service. So this worker is told
 * only "something happened", and asks the site what to show.
 */

const PENDING_URL = '/api/notify/pending';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    // If a tab is already visible the page's own notification code has it covered —
    // showing it here too would double up.
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.some(c => c.visibilityState === 'visible')) return;
    } catch {}

    let data = null;
    try {
      const res = await fetch(PENDING_URL, { credentials: 'include', cache: 'no-store' });
      if (res.ok) data = await res.json();
    } catch {}

    // The spec requires a notification for every push, so there is always a
    // fallback: a signed-out or expired session must still produce something
    // truthful rather than a browser-generated "This site has been updated".
    if (!data || !data.ok || !Array.isArray(data.items) || !data.items.length) {
      return self.registration.showNotification('Knowledge Index', {
        body: 'You have new activity.',
        tag: 'ki-generic', icon: '/Assets/favicon.ico', badge: '/Assets/favicon.ico',
        data: { url: '/#page=chat' },
      });
    }

    // Two or more conversations at once become one line rather than a stack of
    // toasts; a single one keeps its detail.
    if (data.items.length > 1) {
      return self.registration.showNotification('Knowledge Index', {
        body: data.unread + ' unread message' + (data.unread === 1 ? '' : 's')
            + ' in ' + data.items.length + ' conversations',
        tag: 'ki-summary', renotify: true,
        icon: '/Assets/favicon.ico', badge: '/Assets/favicon.ico',
        data: { url: '/#page=chat' },
      });
    }

    const it = data.items[0];
    return self.registration.showNotification(it.title || 'Knowledge Index', {
      body: it.body || '',
      tag: it.tag || 'ki-chat', renotify: true,
      icon: '/Assets/favicon.ico', badge: '/Assets/favicon.ico',
      data: { url: '/#page=chat', convo: it.convo || '' },
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/#page=chat';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a tab that is already on the site rather than opening a third copy.
    for (const c of clients) {
      try {
        if (new URL(c.url).origin === self.location.origin) {
          await c.focus();
          if ('navigate' in c) { try { await c.navigate(target); } catch {} }
          return;
        }
      } catch {}
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// The browser can retire a subscription on its own (key rotation, a long silence).
// Re-create it and hand the new endpoint back, or notifications quietly stop.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('/api/push/key', { cache: 'no-store' });
      const { key } = await res.json();
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
      });
      const j = sub.toJSON();
      await fetch('/api/push/subscribe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint, keys: j.keys, ua: 'renewed' }),
      });
    } catch {}
  })());
});
