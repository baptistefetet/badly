const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

// Charger les variables d'environnement depuis .env
try {
  require('dotenv').config();
} catch (err) {
  console.log('dotenv non disponible - utilisation des variables d\'environnement système uniquement');
}

const APP_VERSION = '1.3.3';

// Configuration basée sur l'environnement
const NODE_ENV = process.env.NODE_ENV || 'production';
const IS_DEV = NODE_ENV === 'development';
const DEBUG = process.env.DEBUG === 'true';
const PORT = parseInt(process.env.PORT, 10);
const storage = require('./storage');

console.log(`🚀 Environnement: ${NODE_ENV}${IS_DEV ? ' (DEV)' : ''}`);
console.log(`🏷️  Version: ${APP_VERSION}`);
const INDEX_FILE = path.join(__dirname, 'index.html');
const STYLE_FILE = path.join(__dirname, 'style.css');
const APP_JS_FILE = path.join(__dirname, 'app.js');
const MANIFEST_FILE = path.join(__dirname, 'manifest.json');
const FAVICON_FILE = path.join(__dirname, 'favicon.png');
const SW_FILE = path.join(__dirname, 'service-worker.js');
const ROBOTS_FILE = path.join(__dirname, 'robots.txt');
const SITEMAP_FILE = path.join(__dirname, 'sitemap.xml');
const COOKIE_NAME = 'badlyAuth';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_SALT = 'badly-static-salt-v1';

// Configuration Web Push (VAPID keys - à générer avec: npx web-push generate-vapid-keys)
// IMPORTANT: Remplacez ces clés par vos propres clés VAPID
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL;

let webpush;
try {
  webpush = require('web-push');
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log(`Web Push configuré${IS_DEV ? ' (DEV)' : ''}`);
} catch (err) {
  console.warn('web-push non disponible - les notifications push ne fonctionneront pas');
  console.warn('Installez avec: npm install web-push');
}

// Limits to prevent excessive data file growth
const MAX_USERS = 128;
const MAX_SESSIONS = 16;
const MAX_MESSAGES_PER_SESSION = 50;
const REMINDER_MINUTES_BEFORE_START = 45;
const REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

const { debugLog, debugError } = storage;

function hashPassword(password) {
  return crypto.createHash('sha256').update(`${password}:${PASSWORD_SALT}`).digest('hex');
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    const value = rest.join('=');
    out[key] = decodeURIComponent(value || '');
  }
  return out;
}

function getAuthPayload(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies[COOKIE_NAME]) return null;
  try {
    return JSON.parse(cookies[COOKIE_NAME]);
  } catch (err) {
    return null;
  }
}

function findUser(users, name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  return users.find((u) => u.normalized === normalized) || null;
}

function authenticateRequest(req, users) {
  const payload = getAuthPayload(req);
  if (!payload || typeof payload.name !== 'string' || typeof payload.passwordHash !== 'string') {
    return null;
  }
  const user = findUser(users, payload.name);
  if (!user) return null;
  if (user.passwordHash !== payload.passwordHash) return null;
  return user;
}

function sanitizeUserForClient(user) {
  return {
    name: user.name,
    passwordHash: user.passwordHash
  };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let acc = '';
    req.on('data', (chunk) => {
      acc += chunk;
      if (acc.length > 1e6) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!acc.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(acc));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function setAuthCookieHeaders(user) {
  const value = encodeURIComponent(JSON.stringify({ name: user.name, passwordHash: user.passwordHash }));
  return {
    'Set-Cookie': `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`
  };
}

function clearAuthCookieHeader() {
  return {
    'Set-Cookie': `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`
  };
}

function validateContentType(req) {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && contentType.includes('application/json');
}

function sessionHasExpired(session, referenceDate = new Date()) {
  const start = new Date(session.datetime);
  if (Number.isNaN(start.getTime())) return true;
  const endTime = start.getTime() + session.durationMinutes * 60000;
  return referenceDate.getTime() > endTime;
}

function sessionHasStarted(session, referenceDate = new Date()) {
  const start = new Date(session.datetime);
  if (Number.isNaN(start.getTime())) return true;
  return referenceDate.getTime() >= start.getTime();
}

function formatSessionForClient(session) {
  return {
    id: session.id,
    datetime: session.datetime,
    durationMinutes: session.durationMinutes,
    club: session.club,
    level: session.level,
    capacity: session.capacity,
    pricePerParticipant: session.pricePerParticipant,
    organizer: session.organizer,
    participants: session.participants,
    followers: session.followers || [],
    messages: session.messages || [],
    createdAt: session.createdAt,
    participantCount: Math.min(session.participants.length + 1, session.capacity)
  };
}

function purgeExpiredSessions() {
  const now = new Date();
  const sessions = storage.readSessions();
  const remaining = sessions.filter((session) => !sessionHasExpired(session, now));
  if (remaining.length !== sessions.length) {
    storage.writeSessions(remaining);
    return true;
  }
  return false;
}

async function handleSignup(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.name !== 'string' || typeof payload.password !== 'string') {
    sendError(res, 400, 'Missing credentials');
    return;
  }

  const name = payload.name.trim();
  const password = payload.password;

  if (name.length < 3 || name.length > 20 || !/^[A-Za-z0-9_-]+$/.test(name)) {
    sendError(res, 400, 'Nom invalide (3-20 caractères, alphanumérique, tiret ou underscore)');
    return;
  }

  if (password.length < 6 || password.length > 64) {
    sendError(res, 400, 'Mot de passe invalide (6-64 caractères)');
    return;
  }

  const users = storage.readUsers();
  const normalized = name.toLowerCase();

  if (users.length >= MAX_USERS) {
    sendError(res, 400, `Limite d'utilisateurs atteinte (${MAX_USERS} maximum)`);
    return;
  }

  if (users.some((u) => u.normalized === normalized)) {
    sendError(res, 400, 'Nom déjà utilisé');
    return;
  }

  const passwordHash = hashPassword(password);
  const user = {
    name,
    normalized,
    passwordHash,
    createdAt: new Date().toISOString(),
    pushSubscriptions: []
  };

  users.push(user);
  storage.writeUsers(users);

  sendJson(res, 200, { ok: true, user: sanitizeUserForClient(user) }, setAuthCookieHeaders(user));
}

async function handleSignin(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.name !== 'string') {
    sendError(res, 400, 'Missing credentials');
    return;
  }

  const name = payload.name.trim();
  const users = storage.readUsers();
  const user = findUser(users, name);
  if (!user) {
    setTimeout(() => sendError(res, 401, 'Authentification échouée'), 250);
    return;
  }

  let providedHash = null;
  if (typeof payload.password === 'string') {
    if (payload.password.length < 6 || payload.password.length > 64) {
      sendError(res, 400, 'Authentification échouée');
      return;
    }
    providedHash = hashPassword(payload.password);
  } else if (typeof payload.passwordHash === 'string') {
    providedHash = payload.passwordHash;
  }

  if (!providedHash || providedHash !== user.passwordHash) {
    setTimeout(() => sendError(res, 401, 'Authentification échouée'), 250);
    return;
  }

  sendJson(res, 200, { ok: true, user: sanitizeUserForClient(user) }, setAuthCookieHeaders(user));
}

async function handleSignout(req, res) {
  sendJson(res, 200, { ok: true }, clearAuthCookieHeader());
}

function requireAuth(req, res) {
  try {
    const users = storage.readUsers();
    const user = authenticateRequest(req, users);
    if (!user) {
      sendError(res, 401, 'Authentification requise');
      return null;
    }
    return { user };
  } catch (err) {
    sendError(res, 500, 'Erreur serveur');
    return null;
  }
}

function respondWithSessions(res) {
  const sessions = [...storage.readSessions()]
    .sort((a, b) => {
      const dateA = new Date(a.datetime);
      const dateB = new Date(b.datetime);
      return dateA.getTime() - dateB.getTime();
    })
    .map(formatSessionForClient);
  const validUsernames = storage.readUsers().map((u) => u.name);
  const clubs = storage.readClubs();
  sendJson(res, 200, { ok: true, sessions, clubs, validUsernames });
}

function handleListSessions(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  purgeExpiredSessions();
  respondWithSessions(res);
}

async function handleCreateSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  const { datetime, durationMinutes, club, level, capacity, pricePerParticipant } = payload || {};

  if (typeof datetime !== 'string') {
    sendError(res, 400, 'Date/heure invalide');
    return;
  }

  const parsedDate = new Date(datetime);
  if (Number.isNaN(parsedDate.getTime())) {
    sendError(res, 400, 'Date/heure invalide');
    return;
  }

  const now = Date.now();
  if (parsedDate.getTime() < now - 5 * 60 * 1000) {
    sendError(res, 400, 'La session doit être dans le futur');
    return;
  }

  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300) {
    sendError(res, 400, 'Durée invalide');
    return;
  }

  const clubs = storage.readClubs();
  const normalizedClub = typeof club === 'string' ? club.trim() : '';
  if (!normalizedClub) {
    sendError(res, 400, 'Club invalide');
    return;
  }
  if (clubs.length && !clubs.includes(normalizedClub)) {
    sendError(res, 400, 'Club inconnu');
    return;
  }

  const allowedLevels = ['débutant', 'débutant/moyen', 'moyen', 'confirmé'];
  const normalizedLevel = typeof level === 'string' ? level.trim() : '';
  if (!normalizedLevel || !allowedLevels.includes(normalizedLevel)) {
    sendError(res, 400, 'Niveau invalide');
    return;
  }

  const normalizedCapacity = Number(capacity);
  if (!Number.isInteger(normalizedCapacity) || normalizedCapacity < 1 || normalizedCapacity > 12) {
    sendError(res, 400, 'Capacité invalide');
    return;
  }

  const price = Number(pricePerParticipant);
  if (!Number.isFinite(price) || price < 0) {
    sendError(res, 400, 'Prix invalide');
    return;
  }
  const roundedPrice = Math.round(price * 100) / 100;

  const sessions = storage.readSessions();
  if (sessions.length >= MAX_SESSIONS) {
    sendError(res, 400, `Limite de sessions atteinte (${MAX_SESSIONS} maximum)`);
    return;
  }

  const session = {
    id: crypto.randomUUID(),
    datetime: parsedDate.toISOString(),
    durationMinutes: duration,
    club: normalizedClub,
    level: normalizedLevel,
    capacity: normalizedCapacity,
    pricePerParticipant: roundedPrice,
    organizer: user.name,
    participants: [],
    followers: [],
    messages: [],
    createdAt: new Date().toISOString(),
    reminderSent: false
  };

  sessions.push(session);
  storage.writeSessions(sessions);

  // Envoyer les notifications push
  sendNewSessionNotification(session).catch((err) => {
    debugError('Erreur lors de l\'envoi des notifications push:', err);
  });

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleDeleteSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  const sessions = storage.readSessions();
  const index = sessions.findIndex((session) => session.id === payload.sessionId);
  if (index === -1) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  const session = sessions[index];
  const isOrganizer = session.organizer === user.name;

  if (!isOrganizer) {
    sendError(res, 403, 'Seul l\'organisateur peut supprimer la session');
    return;
  }

  sessions.splice(index, 1);
  storage.writeSessions(sessions);

  sendJson(res, 200, { ok: true });
}

async function handleJoinSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  const sessions = storage.readSessions();
  const session = sessions.find((s) => s.id === payload.sessionId);
  if (!session) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  if (sessionHasStarted(session)) {
    sendError(res, 400, 'La session est déjà commencée');
    return;
  }

  if (session.organizer === user.name) {
    sendError(res, 400, 'Organisateur déjà inscrit');
    return;
  }

  if (session.participants.includes(user.name)) {
    sendError(res, 400, 'Utilisateur déjà inscrit');
    return;
  }

  if (session.participants.length + 1 >= session.capacity) {
    sendError(res, 400, 'Session complète');
    return;
  }

  session.participants.push(user.name);
  storage.writeSessions(sessions);

  // Notifier l'organisateur
  sendParticipantJoinedNotification(session, user.name).catch((err) => {
    debugError('Erreur lors de l\'envoi de la notification à l\'organisateur:', err);
  });

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleLeaveSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  const sessions = storage.readSessions();
  const session = sessions.find((s) => s.id === payload.sessionId);
  if (!session) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  if (session.organizer === user.name) {
    sendError(res, 400, 'L\'organisateur ne peut se désinscrire');
    return;
  }

  if (!session.participants.includes(user.name)) {
    sendError(res, 400, 'Utilisateur non inscrit');
    return;
  }

  if (sessionHasStarted(session)) {
    sendError(res, 400, 'La session est déjà commencée');
    return;
  }

  // Vérifier si la session était pleine avant le départ
  const totalBeforeLeaving = session.participants.length + 1; // +1 pour l'organisateur
  const wasSessionFull = totalBeforeLeaving >= session.capacity;

  session.participants = session.participants.filter((name) => name !== user.name);
  storage.writeSessions(sessions);

  // Notifier l'organisateur et les followers du départ
  sendParticipantLeftNotification(session, user.name).catch((err) => {
    debugError('Erreur lors de l\'envoi de la notification de départ:', err);
  });

  // Si la session était pleine et qu'une place vient de se libérer, notifier
  if (wasSessionFull) {
    sendSpotAvailableNotification(session).catch((err) => {
      debugError('Erreur lors de l\'envoi des notifications push:', err);
    });
  }

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleUpdateParticipants(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  if (!Array.isArray(payload.participants)) {
    sendError(res, 400, 'Liste des participants invalide');
    return;
  }

  const sessions = storage.readSessions();
  const session = sessions.find((s) => s.id === payload.sessionId);
  if (!session) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  if (session.organizer !== user.name) {
    sendError(res, 403, 'Seul l\'organisateur peut modifier les participants');
    return;
  }

  if (sessionHasStarted(session)) {
    sendError(res, 400, 'La session est déjà commencée');
    return;
  }

  // Valider et normaliser les noms des participants
  const normalizedParticipants = [];
  for (const name of payload.participants) {
    if (typeof name !== 'string') {
      sendError(res, 400, 'Nom de participant invalide');
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 20) {
      sendError(res, 400, 'Nom de participant invalide (1-20 caractères)');
      return;
    }
    // Ne pas autoriser l'organisateur dans la liste des participants
    if (trimmed.toLowerCase() === session.organizer.toLowerCase()) {
      sendError(res, 400, 'L\'organisateur ne peut pas être ajouté comme participant');
      return;
    }
    normalizedParticipants.push(trimmed);
  }

  // Vérifier la capacité (participants + organisateur)
  if (normalizedParticipants.length + 1 > session.capacity) {
    sendError(res, 400, 'Trop de participants pour la capacité de la session');
    return;
  }

  // Vérifier si la session était pleine avant la modification
  const totalBefore = session.participants.length + 1;
  const wasSessionFull = totalBefore >= session.capacity;

  // Mettre à jour les participants
  session.participants = normalizedParticipants;
  storage.writeSessions(sessions);

  // Si la session était pleine et qu'une place vient de se libérer, notifier
  const totalAfter = normalizedParticipants.length + 1;
  if (wasSessionFull && totalAfter < session.capacity) {
    sendSpotAvailableNotification(session).catch((err) => {
      debugError('Erreur lors de l\'envoi des notifications push:', err);
    });
  }

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleFollowSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  const sessions = storage.readSessions();
  const session = sessions.find((s) => s.id === payload.sessionId);
  if (!session) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  // L'organisateur ne peut pas suivre sa propre session
  if (session.organizer === user.name) {
    sendError(res, 400, 'L\'organisateur ne peut pas suivre sa propre session');
    return;
  }

  // Initialiser le tableau followers si nécessaire
  if (!session.followers) {
    session.followers = [];
  }

  if (session.followers.includes(user.name)) {
    sendError(res, 400, 'Vous suivez déjà cette session');
    return;
  }

  session.followers.push(user.name);
  storage.writeSessions(sessions);

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleUnfollowSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  const sessions = storage.readSessions();
  const session = sessions.find((s) => s.id === payload.sessionId);
  if (!session) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  if (!session.followers || !session.followers.includes(user.name)) {
    sendError(res, 400, 'Vous ne suivez pas cette session');
    return;
  }

  session.followers = session.followers.filter((name) => name !== user.name);
  storage.writeSessions(sessions);

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleSendMessage(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  const sessions = storage.readSessions();
  const session = sessions.find((s) => s.id === payload.sessionId);
  if (!session) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  // Vérifier que la session n'a pas commencé
  if (sessionHasStarted(session)) {
    sendError(res, 400, 'La session est déjà commencée');
    return;
  }

  // Vérifier que l'utilisateur est organisateur, participant ou follower
  const isOrganizer = session.organizer === user.name;
  const isParticipant = session.participants.includes(user.name);
  const isFollower = (session.followers || []).includes(user.name);
  if (!isOrganizer && !isParticipant && !isFollower) {
    sendError(res, 403, 'Vous devez être participant ou intéressé pour envoyer un message');
    return;
  }

  // Valider le texte du message
  if (!payload.text || typeof payload.text !== 'string') {
    sendError(res, 400, 'Message manquant');
    return;
  }
  const text = payload.text.trim();
  if (text.length === 0) {
    sendError(res, 400, 'Le message ne peut pas être vide');
    return;
  }
  if (text.length > 500) {
    sendError(res, 400, 'Le message ne peut pas dépasser 500 caractères');
    return;
  }

  // Créer le message
  const message = {
    id: crypto.randomUUID(),
    sender: user.name,
    text: text,
    timestamp: new Date().toISOString()
  };

  // Initialiser le tableau messages si nécessaire
  if (!session.messages) {
    session.messages = [];
  }

  // Ajouter le message et limiter à MAX_MESSAGES_PER_SESSION
  session.messages.push(message);
  if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
    session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
  }

  storage.writeSessions(sessions);

  // Envoyer les notifications push (async)
  sendChatMessageNotification(session, message).catch((err) => {
    debugError('Erreur lors de l\'envoi des notifications de chat:', err);
  });

  sendJson(res, 200, { ok: true, message, session: formatSessionForClient(session) });
}

async function handleEditSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || typeof payload.sessionId !== 'string') {
    sendError(res, 400, 'Identifiant session manquant');
    return;
  }

  const sessions = storage.readSessions();
  const session = sessions.find((s) => s.id === payload.sessionId);
  if (!session) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  if (session.organizer !== user.name) {
    sendError(res, 403, 'Seul l\'organisateur peut modifier la session');
    return;
  }

  if (sessionHasStarted(session)) {
    sendError(res, 400, 'La session est déjà commencée');
    return;
  }

  const originalDatetime = session.datetime;
  const { datetime, durationMinutes, club, level, capacity, pricePerParticipant } = payload;

  if (typeof datetime !== 'string') {
    sendError(res, 400, 'Date/heure invalide');
    return;
  }

  const parsedDate = new Date(datetime);
  if (Number.isNaN(parsedDate.getTime())) {
    sendError(res, 400, 'Date/heure invalide');
    return;
  }

  const now = Date.now();
  if (parsedDate.getTime() < now - 5 * 60 * 1000) {
    sendError(res, 400, 'La session doit être dans le futur');
    return;
  }

  const duration = Number(durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300) {
    sendError(res, 400, 'Durée invalide');
    return;
  }

  const clubs = storage.readClubs();
  const normalizedClub = typeof club === 'string' ? club.trim() : '';
  if (!normalizedClub) {
    sendError(res, 400, 'Club invalide');
    return;
  }
  if (clubs.length && !clubs.includes(normalizedClub)) {
    sendError(res, 400, 'Club inconnu');
    return;
  }

  const allowedLevels = ['débutant', 'débutant/moyen', 'moyen', 'confirmé'];
  const normalizedLevel = typeof level === 'string' ? level.trim() : '';
  if (!normalizedLevel || !allowedLevels.includes(normalizedLevel)) {
    sendError(res, 400, 'Niveau invalide');
    return;
  }

  const normalizedCapacity = Number(capacity);
  if (!Number.isInteger(normalizedCapacity) || normalizedCapacity < 1 || normalizedCapacity > 12) {
    sendError(res, 400, 'Capacité invalide');
    return;
  }

  // Vérifier que la nouvelle capacité est suffisante pour les participants actuels
  const currentTotal = session.participants.length + 1;
  if (normalizedCapacity < currentTotal) {
    sendError(res, 400, `La capacité ne peut être inférieure au nombre actuel de participants (${currentTotal})`);
    return;
  }

  const price = Number(pricePerParticipant);
  if (!Number.isFinite(price) || price < 0) {
    sendError(res, 400, 'Prix invalide');
    return;
  }
  const roundedPrice = Math.round(price * 100) / 100;

  // Mettre à jour la session
  session.datetime = parsedDate.toISOString();
  session.durationMinutes = duration;
  session.club = normalizedClub;
  session.level = normalizedLevel;
  session.capacity = normalizedCapacity;
  session.pricePerParticipant = roundedPrice;
  if (session.datetime !== originalDatetime) {
    session.reminderSent = false;
  }

  storage.writeSessions(sessions);

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, buffer) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': buffer.length });
    res.end(buffer);
  });
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
async function sendPushNotifications(users, title, body, tag, targetUser = null, excludedUsers = null) {
  if (!webpush) {
    debugLog('web-push non disponible, notifications désactivées');
    return;
  }

  const subscriptions = storage.getAllSubscriptions(users, { targetUser, excludedUsers });

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
      // Si l'abonnement a expiré (410) ou est invalide, le marquer pour suppression
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
  const users = storage.readUsers();
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Nouvelle session de bad !';
  const body = `${session.club} - ${formattedDate}\nNiveau: ${session.level}\nOrganisé par ${session.organizer}`;
  const tag = `session-${session.id}`;

  const excludedUsers = session.organizer ? [session.organizer] : null;
  return sendPushNotifications(users, title, body, tag, null, excludedUsers);
}

// Notification quand une place se libère
async function sendSpotAvailableNotification(session) {
  const users = storage.readUsers();
  const formattedDate = formatSessionDate(session);
  const title = '🎾 Une place s\'est libérée !';
  const body = `${session.club} - ${formattedDate}\nNiveau: ${session.level}`;
  const tag = `session-${session.id}-available`;

  return sendPushNotifications(users, title, body, tag);
}

// Notification pour l'organisateur et les followers quand quelqu'un s'inscrit
async function sendParticipantJoinedNotification(session, participantName) {
  const users = storage.readUsers();
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Nouveau participant !';
  const body = `${participantName} s'est inscrit à la session du ${formattedDate}`;
  const tag = `session-${session.id}-join`;

  // Notifier l'organisateur et les followers
  const recipients = [session.organizer, ...(session.followers || [])].filter(Boolean);

  await Promise.all(
    recipients.map((userName) =>
      sendPushNotifications(users, title, body, tag, userName)
    )
  );
}

// Notification pour l'organisateur et les followers quand quelqu'un se désinscrit
async function sendParticipantLeftNotification(session, participantName) {
  const users = storage.readUsers();
  const formattedDate = formatSessionDate(session);
  const title = '🏸 Départ d\'un participant';
  const body = `${participantName} s'est désinscrit de la session du ${formattedDate}`;
  const tag = `session-${session.id}-leave`;

  // Notifier l'organisateur et les followers
  const recipients = [session.organizer, ...(session.followers || [])].filter(Boolean);

  await Promise.all(
    recipients.map((userName) =>
      sendPushNotifications(users, title, body, tag, userName)
    )
  );
}

async function sendSessionReminderNotification(session) {
  const users = storage.readUsers();
  const formattedDate = formatSessionDate(session);
  const title = '⏰ Session dans 45 minutes';
  const body = `${session.club} - ${formattedDate}\nOn se retrouve bientôt sur le terrain !`;
  const tag = `session-${session.id}-reminder`;

  const recipients = [session.organizer, ...(session.participants || [])].filter(Boolean);
  if (recipients.length === 0) return;

  await Promise.all(
    recipients.map((userName) =>
      sendPushNotifications(users, title, body, tag, userName)
    )
  );
}

async function sendChatMessageNotification(session, message) {
  const users = storage.readUsers();
  // Destinataires : organizer + participants + followers (sauf sender)
  const recipients = [
    session.organizer,
    ...(session.participants || []),
    ...(session.followers || [])
  ].filter((name) => name && name !== message.sender);

  // Dédupliquer
  const uniqueRecipients = [...new Set(recipients)];
  if (uniqueRecipients.length === 0) return;

  const title = `💬 ${message.sender}`;
  const body = message.text.length > 100
    ? message.text.substring(0, 97) + '...'
    : message.text;
  const tag = `session-${session.id}-chat`;

  await Promise.all(
    uniqueRecipients.map((userName) =>
      sendPushNotifications(users, title, body, tag, userName)
    )
  );
}

async function handleSubscribePush(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }

  const auth = requireAuth(req, res);
  if (!auth) return;
  const { user } = auth;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || !payload.endpoint || !payload.keys) {
    sendError(res, 400, 'Abonnement push invalide');
    return;
  }

  const users = storage.readUsers();
  const currentUser = users.find((u) => u.name === user.name);
  if (!currentUser) {
    sendError(res, 500, 'Utilisateur introuvable');
    return;
  }

  if (!currentUser.pushSubscriptions) {
    currentUser.pushSubscriptions = [];
  }

  // Mettre à jour l'abonnement existant ou en créer un nouveau
  const index = currentUser.pushSubscriptions.findIndex(
    (sub) => sub.endpoint === payload.endpoint
  );

  if (index !== -1) {
    const existing = currentUser.pushSubscriptions[index];
    const updated = {
      endpoint: payload.endpoint,
      keys: payload.keys,
      expirationTime: payload.expirationTime || null,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    };
    const hasChanged =
      JSON.stringify(existing.keys) !== JSON.stringify(updated.keys) ||
      existing.expirationTime !== updated.expirationTime;
    if (hasChanged) {
      currentUser.pushSubscriptions[index] = updated;
      storage.writeUsers(users);
      debugLog(`Abonnement push mis à jour pour ${user.name}`);
    }
  } else {
    // Supprimer cet endpoint d'autres users (changement de compte sur le même navigateur)
    for (const u of users) {
      if (u.name !== user.name && u.pushSubscriptions) {
        u.pushSubscriptions = u.pushSubscriptions.filter(
          (sub) => sub.endpoint !== payload.endpoint
        );
      }
    }

    const subscription = {
      endpoint: payload.endpoint,
      keys: payload.keys,
      expirationTime: payload.expirationTime || null,
      createdAt: new Date().toISOString()
    };
    currentUser.pushSubscriptions.push(subscription);
    storage.writeUsers(users);
    debugLog(`Nouvel abonnement push enregistré pour ${user.name}`);
  }

  sendJson(res, 200, { ok: true });
}

async function handleUnsubscribePush(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }

  const auth = requireAuth(req, res);
  if (!auth) return;

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    sendError(res, 400, err.message);
    return;
  }

  if (!payload || !payload.endpoint) {
    sendError(res, 400, 'Endpoint manquant');
    return;
  }

  const users = storage.readUsers();
  let removed = false;
  for (const user of users) {
    if (user.pushSubscriptions) {
      const before = user.pushSubscriptions.length;
      user.pushSubscriptions = user.pushSubscriptions.filter(
        (sub) => sub.endpoint !== payload.endpoint
      );
      if (user.pushSubscriptions.length < before) {
        removed = true;
      }
    }
  }

  if (removed) {
    storage.writeUsers(users);
    debugLog('Abonnement push supprimé');
  }

  sendJson(res, 200, { ok: true });
}

function checkUpcomingSessionReminders() {
  try {
    const sessions = storage.readSessions();
    const now = new Date();
    let updated = false;

    for (const session of sessions) {
      if (session.reminderSent) continue;
      if (sessionHasStarted(session, now)) continue;

      const start = new Date(session.datetime);
      if (Number.isNaN(start.getTime())) continue;

      const msBeforeStart = start.getTime() - now.getTime();
      const reminderWindowMs = REMINDER_MINUTES_BEFORE_START * 60 * 1000;
      if (msBeforeStart > 0 && msBeforeStart <= reminderWindowMs) {
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

function handleGetVapidPublicKey(req, res) {
  sendJson(res, 200, { ok: true, publicKey: VAPID_PUBLIC_KEY });
}

// Webhook pour le déploiement automatique (GitHub Actions)
function handleWebhookDeploy(req, res) {
  console.log(`🚀 Webhook deploy: déploiement déclenché${IS_DEV ? ' (DEV)' : ''}`);

  const deployScript = path.join(__dirname, 'deploy.sh');

  exec(`bash ${deployScript}`, { cwd: __dirname }, (error, stdout, stderr) => {
    if (error) {
      console.error('❌ Erreur de déploiement:', error.message);
      console.error('stderr:', stderr);
      return;
    }
    console.log('✅ Déploiement terminé:', stdout);
  });

  sendJson(res, 200, { ok: true, message: 'Déploiement déclenché' });
}

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  const logPrefix = `${new Date().toISOString()} ${req.method} ${pathname}`;

  if (req.method === 'GET' && pathname === '/') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, INDEX_FILE, 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/style.css') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, STYLE_FILE, 'text/css; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/app.js') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, APP_JS_FILE, 'application/javascript; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/manifest.json') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, MANIFEST_FILE, 'application/manifest+json; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/favicon.png') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, FAVICON_FILE, 'image/png');
    return;
  }

  if (req.method === 'GET' && pathname === '/service-worker.js') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, SW_FILE, 'application/javascript; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/robots.txt') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, ROBOTS_FILE, 'text/plain; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/sitemap.xml') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, SITEMAP_FILE, 'application/xml; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/vapidPublicKey') {
    debugLog(`${logPrefix}`);
    handleGetVapidPublicKey(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/signup') {
    debugLog(`${logPrefix}`);
    handleSignup(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/signin') {
    debugLog(`${logPrefix}`);
    handleSignin(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/signout') {
    debugLog(`${logPrefix}`);
    handleSignout(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/listSessions') {
    debugLog(`${logPrefix}`);
    handleListSessions(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/version') {
    debugLog(`${logPrefix}`);
    sendJson(res, 200, { ok: true, version: APP_VERSION });
    return;
  }

  if (req.method === 'POST' && pathname === '/createSession') {
    debugLog(`${logPrefix}`);
    handleCreateSession(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/deleteSession') {
    debugLog(`${logPrefix}`);
    handleDeleteSession(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/joinSession') {
    debugLog(`${logPrefix}`);
    handleJoinSession(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/leaveSession') {
    debugLog(`${logPrefix}`);
    handleLeaveSession(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/updateParticipants') {
    debugLog(`${logPrefix}`);
    handleUpdateParticipants(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/followSession') {
    debugLog(`${logPrefix}`);
    handleFollowSession(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/unfollowSession') {
    debugLog(`${logPrefix}`);
    handleUnfollowSession(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/sendMessage') {
    debugLog(`${logPrefix}`);
    handleSendMessage(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/editSession') {
    debugLog(`${logPrefix}`);
    handleEditSession(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/subscribePush') {
    debugLog(`${logPrefix}`);
    handleSubscribePush(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/unsubscribePush') {
    debugLog(`${logPrefix}`);
    handleUnsubscribePush(req, res).catch((err) => {
      debugError(`${logPrefix} error`, err);
      sendError(res, 500, 'Erreur serveur');
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/webhook/deploy') {
    console.log(`${logPrefix} -> webhook deploy`);
    handleWebhookDeploy(req, res);
    return;
  }

  debugLog(`${logPrefix} -> 404`);
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

// Vérifier régulièrement si un rappel doit être envoyé
setInterval(checkUpcomingSessionReminders, REMINDER_CHECK_INTERVAL_MS);
setTimeout(checkUpcomingSessionReminders, 2000);

const server = http.createServer(requestHandler);

server.listen(PORT, () => {
  console.log(`Badly server${IS_DEV ? ' (DEV)' : ''} running on http://localhost:${PORT}`);
});
