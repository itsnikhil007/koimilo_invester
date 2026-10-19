// KoiMilo Web Push & PWA Service Worker
// Handles background push notifications, offline resilience, and TWA compliance

const CACHE_NAME = "koimilo-pwa-v2";
const OFFLINE_URL = "/offline.html";

// Pre-cache core offline assets and splash screen resources on install
const PRECACHE_ASSETS = [
  OFFLINE_URL,
  "/icon-512.png",
  "/icon-192.png",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  self.skipWaiting();
});

// Clean up stale caches and claim clients on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch event handler for PWA offline resilience & store package compliance
self.addEventListener("fetch", (event) => {
  // Only intercept standard GET requests
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Bypass non-http protocols (e.g. chrome-extension://, blob:)
  if (!url.protocol.startsWith("http")) return;

  // Bypass dynamic API, auth, realtime, and media stream requests
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/_next/webpack-hmr") ||
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("agora.io") ||
    url.hostname.includes("cloudinary.com")
  ) {
    return;
  }

  // Navigation requests (HTML pages): Always network-first, with dedicated /offline.html fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .catch(async () => {
          const offlinePage = await caches.match(OFFLINE_URL);
          if (offlinePage) return offlinePage;

          return new Response("You are offline. Please reconnect to use Koimilo.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        })
    );
    return;
  }

  // Static assets (Next.js chunks, images, icons, styles): Stale-While-Revalidate
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.match(/\.(png|jpg|jpeg|svg|webp|ico|woff2?)$/)
  ) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const copy = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      })
    );
  }
});

// Push notification handling
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {
      title: "KoiMilo",
      body: event.data.text() || "You have a new message.",
    };
  }

  const title = payload.title || "KoiMilo — New Message";
  const tag = payload.tag || (payload.matchId ? `koimilo-msg-${payload.matchId}` : "chat-message");
  const options = {
    body: payload.body || "Tap to open your conversation.",
    icon: payload.icon || "/icon-192.png",
    badge: payload.badge || "/icon-192.png",
    tag,
    renotify: true,
    vibrate: [100, 50, 100],
    data: {
      url: payload.url || (payload.matchId ? `/matches/${payload.matchId}` : "/matches"),
      matchId: payload.matchId,
    },
    actions: payload.actions || [
      { action: "open", title: "Open Chat" },
    ],
  };

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // If user is actively using the application (window is focused and visible),
      // DO NOT show a browser notification. The in-window notification modal will handle it.
      const isUserInApp = clientList.some(
        (c) => Boolean(c.focused) && c.visibilityState === "visible"
      );

      if (isUserInApp) {
        return;
      }

      // User is NOT in the application. Show the default browser notification.
      return self.registration.showNotification(title, options);
    })
  );
});

// Notification click handling
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || "/matches";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // 1. If an existing window is open, focus it and navigate to the chat
      for (const client of clientList) {
        if ("focus" in client) {
          if (client.url && client.url.includes(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
      }
      // 2. If no window is open, open a new window to the chat URL
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
