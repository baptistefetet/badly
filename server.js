const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEBUG = false;
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const MANIFEST_FILE = path.join(__dirname, 'manifest.json');
const FAVICON_FILE = path.join(__dirname, 'favicon.png');
const COOKIE_NAME = 'badlyAuth';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_SALT = 'badly-static-salt-v1';

// Limits to prevent excessive data file growth
const MAX_USERS = 32;
const MAX_SESSIONS = 8;

// Logging functions
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

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = {
      users: [],
      sessions: [],
      clubs: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
}

function readData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  let parsed;
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error('Invalid data.json content');
  }
  if (!parsed.users || !Array.isArray(parsed.users)) parsed.users = [];
  if (!parsed.sessions || !Array.isArray(parsed.sessions)) parsed.sessions = [];
  if (!parsed.clubs || !Array.isArray(parsed.clubs)) parsed.clubs = [];
  return parsed;
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

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

function findUser(data, name) {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  return data.users.find((u) => u.normalized === normalized) || null;
}

function authenticateRequest(req, data) {
  const payload = getAuthPayload(req);
  if (!payload || typeof payload.name !== 'string' || typeof payload.passwordHash !== 'string') {
    return null;
  }
  const user = findUser(data, payload.name);
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
    createdAt: session.createdAt,
    participantCount: Math.min(session.participants.length + 1, session.capacity)
  };
}

function purgeExpiredSessions(data) {
  const now = new Date();
  const remaining = data.sessions.filter((session) => !sessionHasExpired(session, now));
  const removed = data.sessions.length !== remaining.length;
  if (removed) {
    data.sessions = remaining;
    writeData(data);
  }
  return removed;
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

  ensureDataFile();
  const data = readData();
  const normalized = name.toLowerCase();

  if (data.users.length >= MAX_USERS) {
    sendError(res, 400, `Limite d'utilisateurs atteinte (${MAX_USERS} maximum)`);
    return;
  }

  if (data.users.some((user) => user.normalized === normalized)) {
    sendError(res, 400, 'Nom déjà utilisé');
    return;
  }

  const passwordHash = hashPassword(password);
  const user = {
    name,
    normalized,
    passwordHash,
    createdAt: new Date().toISOString()
  };

  data.users.push(user);
  writeData(data);

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
  ensureDataFile();
  const data = readData();
  const user = findUser(data, name);
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
    ensureDataFile();
    const data = readData();
    const user = authenticateRequest(req, data);
    if (!user) {
      sendError(res, 401, 'Authentification requise');
      return null;
    }
    return { data, user };
  } catch (err) {
    sendError(res, 500, 'Erreur serveur');
    return null;
  }
}

function respondWithSessions(res, data) {
  const sessions = [...data.sessions].sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
    .map(formatSessionForClient);
  sendJson(res, 200, { ok: true, sessions, clubs: data.clubs });
}

function handleListSessions(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { data } = auth;

  purgeExpiredSessions(data);

  // data may change after purge; reload for consistency
  const fresh = readData();
  respondWithSessions(res, fresh);
}

async function handleCreateSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { data, user } = auth;

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

  const normalizedClub = typeof club === 'string' ? club.trim() : '';
  if (!normalizedClub) {
    sendError(res, 400, 'Club invalide');
    return;
  }
  if (data.clubs.length && !data.clubs.includes(normalizedClub)) {
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

  if (data.sessions.some((session) => session.club === normalizedClub && session.datetime === parsedDate.toISOString())) {
    sendError(res, 400, 'Une session existe déjà pour ce club à cette date');
    return;
  }

  if (data.sessions.length >= MAX_SESSIONS) {
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
    createdAt: new Date().toISOString()
  };

  data.sessions.push(session);
  writeData(data);

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleDeleteSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { data, user } = auth;

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

  const index = data.sessions.findIndex((session) => session.id === payload.sessionId);
  if (index === -1) {
    sendError(res, 404, 'Session introuvable');
    return;
  }

  const session = data.sessions[index];
  const isOrganizer = session.organizer === user.name;
  const isGod = user.normalized === 'god';

  if (!isOrganizer && !isGod) {
    sendError(res, 403, 'Action interdite');
    return;
  }

  data.sessions.splice(index, 1);
  writeData(data);

  sendJson(res, 200, { ok: true });
}

async function handleJoinSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { data, user } = auth;

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

  const session = data.sessions.find((s) => s.id === payload.sessionId);
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
  writeData(data);

  sendJson(res, 200, { ok: true, session: formatSessionForClient(session) });
}

async function handleLeaveSession(req, res) {
  if (!validateContentType(req)) {
    sendError(res, 400, 'Content-Type must be application/json');
    return;
  }
  const auth = requireAuth(req, res);
  if (!auth) return;
  const { data, user } = auth;

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

  const session = data.sessions.find((s) => s.id === payload.sessionId);
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

  session.participants = session.participants.filter((name) => name !== user.name);
  writeData(data);

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

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  const logPrefix = `${new Date().toISOString()} ${req.method} ${pathname}`;

  if (req.method === 'GET' && pathname === '/') {
    debugLog(`${logPrefix} -> 200`);
    serveStaticFile(res, INDEX_FILE, 'text/html; charset=utf-8');
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

  debugLog(`${logPrefix} -> 404`);
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
}

ensureDataFile();

const server = http.createServer(requestHandler);

server.listen(PORT, () => {
  console.log(`Badly server running on http://localhost:${PORT}`);
});
