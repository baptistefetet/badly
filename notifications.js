const storage = require('./storage');

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

// Envoyer une notification push et nettoyer les abonnements expirés
async function sendPushNotifications(title, body, tag, targetUser = null, excludedUsers = null) {
  if (!webpush) {
    debugLog('web-push non disponible, notifications désactivées');
    return;
  }

  const users = storage.readUsers();
  const subscriptions = getAllSubscriptions(users, { targetUser, excludedUsers });

  if (subscriptions.length === 0) {
    debugLog(targetUser ? `Aucun abonnement push trouvé pour ${targetUser}` : 'Aucun abonnement push enregistré');
    return;
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
    storage.writeUsers(users);
    debugLog(`${failedEndpoints.length} abonnements expirés supprimés`);
  }
}

// Notification pour une nouvelle session
async function sendNewSessionNotification(session) {
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Nouvelle session de bad !';
  const body = `${session.club} - ${formattedDate}\nNiveau: ${session.level}\nOrganisé par ${session.organizer}`;
  const tag = `session-${session.id}`;

  const excludedUsers = session.organizer ? [session.organizer] : null;
  await sendPushNotifications(title, body, tag, null, excludedUsers);
}

// Notification quand une place se libère
async function sendSpotAvailableNotification(session) {
  const formattedDate = formatSessionDate(session);
  const title = '🎾 Une place s\'est libérée !';
  const body = `${session.club} - ${formattedDate}\nNiveau: ${session.level}`;
  const tag = `session-${session.id}-available`;

  await sendPushNotifications(title, body, tag);
}

// Notification pour l'organisateur et les followers quand quelqu'un s'inscrit
async function sendParticipantJoinedNotification(session, participantName) {
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Nouveau participant !';
  const body = `${participantName} s'est inscrit à la session du ${formattedDate}`;
  const tag = `session-${session.id}-join`;

  const recipients = [session.organizer, ...(session.followers || [])].filter(Boolean);

  for (const userName of recipients) {
    await sendPushNotifications(title, body, tag, userName);
  }
}

// Notification pour l'organisateur et les followers quand quelqu'un se désinscrit
async function sendParticipantLeftNotification(session, participantName) {
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Départ d\'un participant';
  const body = `${participantName} s'est désinscrit de la session du ${formattedDate}`;
  const tag = `session-${session.id}-leave`;

  const recipients = [session.organizer, ...(session.followers || [])].filter(Boolean);

  for (const userName of recipients) {
    await sendPushNotifications(title, body, tag, userName);
  }
}

async function sendSessionReminderNotification(session) {
  const formattedDate = formatSessionDate(session);
  const title = '⏰ Session dans 45 minutes';
  const body = `${session.club} - ${formattedDate}\nOn se retrouve bientôt sur le terrain !`;
  const tag = `session-${session.id}-reminder`;

  const recipients = [session.organizer, ...(session.participants || [])].filter(Boolean);
  if (recipients.length === 0) return;

  for (const userName of recipients) {
    await sendPushNotifications(title, body, tag, userName);
  }
}

async function sendChatMessageNotification(session, message) {
  const recipients = [
    session.organizer,
    ...(session.participants || []),
    ...(session.followers || [])
  ].filter((name) => name && name !== message.sender);

  const uniqueRecipients = [...new Set(recipients)];
  if (uniqueRecipients.length === 0) return;

  const title = `💬 ${message.sender}`;
  const body = message.text.length > 100
    ? message.text.substring(0, 97) + '...'
    : message.text;
  const tag = `session-${session.id}-chat`;

  for (const userName of uniqueRecipients) {
    await sendPushNotifications(title, body, tag, userName);
  }
}

function checkUpcomingSessionReminders() {
  try {
    const sessions = storage.readSessions();
    const now = new Date();
    let updated = false;

    for (const session of sessions) {
      if (session.reminderSent) continue;

      const start = new Date(session.datetime);
      if (Number.isNaN(start.getTime())) continue;
      if (now.getTime() >= start.getTime()) continue;

      const msBeforeStart = start.getTime() - now.getTime();
      const reminderWindowMs = REMINDER_MINUTES_BEFORE_START * 60 * 1000;
      if (msBeforeStart <= reminderWindowMs) {
        session.reminderSent = true;
        sendSessionReminderNotification(session).catch((err) => {
          debugError('Erreur lors de l\'envoi du rappel de session:', err);
        });
        updated = true;
      }
    }

    if (updated) {
      storage.writeSessions(sessions);
    }
  } catch (err) {
    debugError('Erreur lors de la vérification des rappels de sessions:', err);
  }
}

function startReminderScheduler() {
  setInterval(checkUpcomingSessionReminders, REMINDER_CHECK_INTERVAL_MS);
  setTimeout(checkUpcomingSessionReminders, 2000);
}

module.exports = {
  startReminderScheduler,
  sendNewSessionNotification,
  sendSpotAvailableNotification,
  sendParticipantJoinedNotification,
  sendParticipantLeftNotification,
  sendSessionReminderNotification,
  sendChatMessageNotification,
};
