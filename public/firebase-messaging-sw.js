/* eslint-disable no-undef */
// Sndmart Customer Website - Web Push Service Worker (Firebase Cloud Messaging)
// Precaches a minimal shell; the main job here is background FCM delivery.

const CACHE_NAME = 'sndmart-customer-web-v1';
const PRECACHE_URLS = ['/', '/index.html', '/favicon.ico'];

// --- 1. SERVICE WORKER LIFECYCLE (PWA CACHING) ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(PRECACHE_URLS).catch((err) => {
          console.warn('[PWA SW] Pre-cache partial failure:', err);
        });
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        );
      })
      .then(() => clients.claim())
  );
});

// --- 2. FETCH EVENT LISTENER (Required for PWA Builder & Offline Fallback) ---
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Bypass external APIs and realtime database endpoints
  if (
    url.protocol.startsWith('chrome-extension') ||
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.pathname.startsWith('/api/')
  ) {
    return;
  }

  // Navigation requests: Network First, fallback to cached index or offline.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          const offlinePage = await caches.match('/offline.html');
          if (offlinePage) return offlinePage;
          return caches.match('/index.html');
        })
    );
    return;
  }

  // Same-origin static assets: Cache First with background revalidation
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          // Revalidate in background
          fetch(event.request)
            .then((networkResponse) => {
              if (networkResponse && networkResponse.status === 200) {
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
              }
            })
            .catch(() => {});
          return cachedResponse;
        }

        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        });
      })
    );
  }
});

// --- 3. FIREBASE CLOUD MESSAGING & BACKGROUND WEB PUSH ---
try {
  importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');
} catch (e) {
  console.warn('[SW] Firebase compat script load error:', e);
}

// Read configuration from query params passed during registration
const params = new URL(self.location.href).searchParams;
const swConfig = {
  apiKey: params.get('apiKey') || '',
  authDomain: params.get('authDomain') || '',
  projectId: params.get('projectId') || '',
  messagingSenderId: params.get('messagingSenderId') || '',
  appId: params.get('appId') || '',
  storageBucket: params.get('storageBucket') || '',
};

let messaging = null;

function initFirebase(config) {
  try {
    if (typeof firebase === 'undefined') return;

    if (!firebase.apps.length) {
      if (config.apiKey && config.projectId) {
        firebase.initializeApp(config);
        console.log('[SW] Firebase initialized with projectId:', config.projectId);
      } else {
        return;
      }
    }

    messaging = firebase.messaging();

    // Handles notifications when the tab is closed / app is backgrounded
    messaging.onBackgroundMessage((payload) => {
      console.log('[SW] onBackgroundMessage received:', payload);
      const title = payload.notification?.title || payload.data?.title || 'Sndmart Notification';
      const body =
        payload.notification?.body ||
        payload.data?.message ||
        payload.data?.body ||
        'New operational activity in your city.';
      const data = payload.data || {};

      const isNewOrder = data.type === 'new_order';

      const options = {
        body: body,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        tag: isNewOrder ? 'new-order' : (data.tag || data.order_id || `sndmart-${Date.now()}`),
        data: data,
        renotify: true,
        vibrate: isNewOrder ? [500, 200, 500, 200, 500, 200, 500, 200, 500] : [200, 100, 200],
        requireInteraction: isNewOrder,
      };

      self.registration.showNotification(title, options);
    });
  } catch (err) {
    console.warn('[SW] Firebase Messaging init error:', err);
  }
}

if (swConfig.apiKey && swConfig.projectId) {
  initFirebase(swConfig);
}

// Allow client to update Firebase config dynamically via message
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_FIREBASE_CONFIG') {
    initFirebase(event.data.config);
  } else if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Deep link navigation on notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let url = '/';

  if (data.order_id) {
    url = `/orders/${data.order_id}`;
  } else if (data.type === 'wallet_scratch_card') {
    url = '/wallet';
  } else if (data.click_action) {
    url = data.click_action;
  } else if (data.url) {
    url = data.url;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          if ('navigate' in client) {
            client.navigate(url);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
