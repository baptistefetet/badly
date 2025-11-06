// Service Worker pour les notifications push
self.addEventListener('install', (event) => {
  console.log('Service Worker installé');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service Worker activé');
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  console.log('Notification push reçue', event);
  
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'Badly', body: event.data.text() };
    }
  }

  const title = data.title || 'Nouvelle session de bad !';
  const options = {
    body: data.body || 'Une nouvelle session vient d\'être créée',
    icon: '/favicon.png',
    badge: '/favicon.png',
    data: data.url ? { url: data.url } : {},
    tag: data.tag || 'badly-notification',
    requireInteraction: false,
    vibrate: [200, 100, 200],
    // Afficher un badge numérique si possible
    actions: []
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Incrémenter le badge sur l'icône de l'app
      incrementBadge()
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('Notification cliquée', event);
  event.notification.close();

  event.waitUntil(
    Promise.all([
      // Réinitialiser le badge quand l'utilisateur clique sur la notification
      clearBadge(),
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        // Si une fenêtre est déjà ouverte, la mettre au premier plan
        for (const client of clientList) {
          if (client.url === '/' && 'focus' in client) {
            return client.focus();
          }
        }
        // Sinon, ouvrir une nouvelle fenêtre
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
    ])
  );
});

// Fonctions pour gérer le badge numérique
async function incrementBadge() {
  if ('setAppBadge' in navigator) {
    try {
      // Toujours mettre le badge à 1
      await navigator.setAppBadge(1);
    } catch (err) {
      console.log('Badge API non supporté:', err);
    }
  }
}

async function clearBadge() {
  if ('clearAppBadge' in navigator) {
    try {
      await navigator.clearAppBadge();
    } catch (err) {
      console.log('Badge API non supporté:', err);
    }
  }
}
