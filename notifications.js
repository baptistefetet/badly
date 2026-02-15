const DEBUG = process.env.DEBUG === 'true';

function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

function debugError(...args) {
  if (DEBUG) {
    console.error(...args);
  }
}

// Configuration Web Push (VAPID keys)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL;

const NODE_ENV = process.env.NODE_ENV || 'production';
const IS_DEV = NODE_ENV === 'development';

let webpush;
try {
  webpush = require('web-push');
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log(`Web Push configuré${IS_DEV ? ' (DEV)' : ''}`);
} catch (err) {
  console.warn('web-push non disponible - les notifications push ne fonctionneront pas');
  console.warn('Installez avec: npm install web-push');
}

const REMINDER_MINUTES_BEFORE_START = 45;
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

// Collect push subscriptions from users array
function getAllSubscriptions(users, { targetUser = null, excludedUsers = null } = {}) {
  const results = [];
  for (const user of users) {
    if (!user.pushSubscriptions || user.pushSubscriptions.length === 0) continue;

    if (targetUser) {
      if (user.name.toLowerCase() !== targetUser.toLowerCase()) continue;
    }

    if (excludedUsers && excludedUsers.length > 0) {
      const normalizedExcluded = new Set(
        excludedUsers.filter(Boolean).map((name) => name.toLowerCase())
      );
      if (normalizedExcluded.has(user.name.toLowerCase())) continue;
    }

    for (const sub of user.pushSubscriptions) {
      results.push({
        endpoint: sub.endpoint,
        keys: sub.keys,
        expirationTime: sub.expirationTime,
        userName: user.name,
        createdAt: sub.createdAt,
        updatedAt: sub.updatedAt
      });
    }
  }
  return results;
}

// Formater la date de session pour les notifications
function formatSessionDate(session) {
  const sessionDate = new Date(session.datetime);
  const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
  return dateFormatter.format(sessionDate);
}

// Fonction bas niveau pour envoyer une notification push
// Modifie users in-place (cleanup abonnements expirés)
// Retourne true si des abonnements ont été nettoyés
async function sendPushNotifications(users, title, body, tag, targetUser = null, excludedUsers = null) {
  if (!webpush) {
    debugLog('web-push non disponible, notifications désactivées');
    return false;
  }

  const subscriptions = getAllSubscriptions(users, { targetUser, excludedUsers });

  if (subscriptions.length === 0) {
    debugLog(targetUser ? `Aucun abonnement push trouvé pour ${targetUser}` : 'Aucun abonnement push enregistré');
    return false;
  }

  const notificationPayload = {
    title,
    body,
    tag,
    url: '/'
  };

  const payload = JSON.stringify(notificationPayload);
  const failedEndpoints = [];

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(subscription, payload);
      debugLog(`Notification envoyée à ${subscription.endpoint.substring(0, 50)}...`);
    } catch (err) {
      debugError(`Échec d'envoi de notification:`, err);
      if (err.statusCode === 410 || err.statusCode === 404) {
        failedEndpoints.push(subscription.endpoint);
      }
    }
  }

  // Nettoyer les abonnements expirés
  if (failedEndpoints.length > 0) {
    const failedSet = new Set(failedEndpoints);
    for (const user of users) {
      if (user.pushSubscriptions) {
        user.pushSubscriptions = user.pushSubscriptions.filter(
          sub => !failedSet.has(sub.endpoint)
        );
      }
    }
    debugLog(`${failedEndpoints.length} abonnements expirés supprimés`);
    return true;
  }

  return false;
}

// Notification pour une nouvelle session
async function sendNewSessionNotification(users, session) {
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Nouvelle session de bad !';
  const body = `${session.club} - ${formattedDate}\nNiveau: ${session.level}\nOrganisé par ${session.organizer}`;
  const tag = `session-${session.id}`;

  const excludedUsers = session.organizer ? [session.organizer] : null;
  return sendPushNotifications(users, title, body, tag, null, excludedUsers);
}

// Notification quand une place se libère
async function sendSpotAvailableNotification(users, session) {
  const formattedDate = formatSessionDate(session);
  const title = '🎾 Une place s\'est libérée !';
  const body = `${session.club} - ${formattedDate}\nNiveau: ${session.level}`;
  const tag = `session-${session.id}-available`;

  return sendPushNotifications(users, title, body, tag);
}

// Notification pour l'organisateur et les followers quand quelqu'un s'inscrit
async function sendParticipantJoinedNotification(users, session, participantName) {
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Nouveau participant !';
  const body = `${participantName} s'est inscrit à la session du ${formattedDate}`;
  const tag = `session-${session.id}-join`;

  const recipients = [session.organizer, ...(session.followers || [])].filter(Boolean);
  let cleaned = false;

  for (const userName of recipients) {
    const result = await sendPushNotifications(users, title, body, tag, userName);
    if (result) cleaned = true;
  }

  return cleaned;
}

// Notification pour l'organisateur et les followers quand quelqu'un se désinscrit
async function sendParticipantLeftNotification(users, session, participantName) {
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Départ d\'un participant';
  const body = `${participantName} s'est désinscrit de la session du ${formattedDate}`;
  const tag = `session-${session.id}-leave`;

  const recipients = [session.organizer, ...(session.followers || [])].filter(Boolean);
  let cleaned = false;

  for (const userName of recipients) {
    const result = await sendPushNotifications(users, title, body, tag, userName);
    if (result) cleaned = true;
  }

  return cleaned;
}

async function sendSessionReminderNotification(users, session) {
  const formattedDate = formatSessionDate(session);
  const title = '⏰ Session dans 45 minutes';
  const body = `${session.club} - ${formattedDate}\nOn se retrouve bientôt sur le terrain !`;
  const tag = `session-${session.id}-reminder`;

  const recipients = [session.organizer, ...(session.participants || [])].filter(Boolean);
  if (recipients.length === 0) return false;

  let cleaned = false;

  for (const userName of recipients) {
    const result = await sendPushNotifications(users, title, body, tag, userName);
    if (result) cleaned = true;
  }

  return cleaned;
}

async function sendChatMessageNotification(users, session, message) {
  const recipients = [
    session.organizer,
    ...(session.participants || []),
    ...(session.followers || [])
  ].filter((name) => name && name !== message.sender);

  const uniqueRecipients = [...new Set(recipients)];
  if (uniqueRecipients.length === 0) return false;

  const title = `💬 ${message.sender}`;
  const body = message.text.length > 100
    ? message.text.substring(0, 97) + '...'
    : message.text;
  const tag = `session-${session.id}-chat`;

  let cleaned = false;

  for (const userName of uniqueRecipients) {
    const result = await sendPushNotifications(users, title, body, tag, userName);
    if (result) cleaned = true;
  }

  return cleaned;
}

module.exports = {
  VAPID_PUBLIC_KEY,
  REMINDER_MINUTES_BEFORE_START,
  REMINDER_CHECK_INTERVAL_MS,
  sendNewSessionNotification,
  sendSpotAvailableNotification,
  sendParticipantJoinedNotification,
  sendParticipantLeftNotification,
  sendSessionReminderNotification,
  sendChatMessageNotification,
};
