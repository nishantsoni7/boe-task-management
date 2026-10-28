// BOE One service worker - phone alerts only.
//
// It does two things and nothing else: show a notification when a push arrives,
// and open the right screen when it is tapped. There is deliberately NO fetch
// handler and NO cache, so this file can never serve a stale copy of the app.
//
// The push text is generic by design (the lock screen is public); the screen the
// tap opens is behind the normal sign-in.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  // A push MUST show something (iOS cancels the subscription otherwise).
  const title = typeof data.title === 'string' && data.title ? data.title : 'BOE One'
  const body = typeof data.body === 'string' && data.body ? data.body : 'Open BOE One to see what needs you.'
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/'
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      renotify: true,
      icon: '/brand/icons/icon-192.png',
      badge: '/brand/icons/icon-192.png',
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus().then((focused) => ('navigate' in focused ? focused.navigate(target) : focused))
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
