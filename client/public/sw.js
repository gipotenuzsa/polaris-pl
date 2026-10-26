/* Polaris: service worker для Web Push (PWA). Показывает уведомление и по нажатию открывает нужный экран. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // iOS требует показывать уведомление на каждый push — иначе подписку отзывают
  event.waitUntil(
    self.registration.showNotification(data.title || 'Polaris', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      data: { url: data.url || '/', approvalId: data.approvalId || null },
      actions: data.approvalId
        ? [
            { action: 'approve', title: 'Одобрить' },
            { action: 'reject', title: 'Отклонить' },
          ]
        : [],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  const approvalId = event.notification.data && event.notification.data.approvalId;
  if (approvalId && (event.action === 'approve' || event.action === 'reject')) {
    // Решение прямо из уведомления, без открытия приложения (сессия — cookie этого же сайта).
    event.waitUntil(
      (async () => {
        let text = 'Не удалось применить решение — откройте приложение.';
        try {
          const res = await fetch('/api/approvals/' + approvalId + '/' + event.action, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (res.ok) text = event.action === 'approve' ? 'Одобрено ✓' : 'Отклонено';
        } catch {
          /* нет сети — покажем подсказку */
        }
        await self.registration.showNotification('Polaris', { body: text, icon: '/icon-192.png', tag: 'approval-result' });
      })(),
    );
    return;
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(url);
            } catch {
              /* окно другого происхождения — просто фокусируем */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
