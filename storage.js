const fs = require('fs');
const path = require('path');

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

const DATA_DIR = path.join(__dirname, process.env.DATA_DIR || 'data');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const CLUBS_FILE = path.join(DATA_DIR, 'clubs.json');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// Independent caches
let usersCache = null;
let sessionsCache = null;
let clubsCache = null;

function getBackupPath(filePath) {
  return `${filePath}.bak`;
}

function atomicWriteFileSync(targetPath, contents) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);

  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (typeof fd === 'number') {
      try {
        fs.closeSync(fd);
      } catch (err) {
        // ignore
      }
    }
  }

  fs.renameSync(tmpPath, targetPath);

  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    // Best effort only (not supported on all platforms/filesystems)
  }
}

// Generic read with cache, backup recovery, and default seed
function readFile(filePath, cache, setCache, seed) {
  if (cache !== null) {
    return cache;
  }

  if (!fs.existsSync(filePath)) {
    writeFile(filePath, seed, setCache);
    return seed;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : seed;
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid content in ${filePath}: expected array`);
    }
    setCache(parsed);
    return parsed;
  } catch (err) {
    const backupPath = getBackupPath(filePath);
    if (fs.existsSync(backupPath)) {
      try {
        const rawBackup = fs.readFileSync(backupPath, 'utf8');
        const parsedBackup = rawBackup.trim() ? JSON.parse(rawBackup) : seed;
        if (!Array.isArray(parsedBackup)) {
          throw new Error(`Invalid backup content in ${backupPath}`);
        }

        console.warn(`${path.basename(filePath)} invalide; restauration depuis ${path.basename(backupPath)}`);
        try {
          writeFile(filePath, parsedBackup, setCache);
        } catch (restoreErr) {
          debugError(`Failed to restore ${filePath} from backup:`, restoreErr);
        }

        setCache(parsedBackup);
        return parsedBackup;
      } catch (backupErr) {
        debugError(`Failed to read/parse backup ${backupPath}:`, backupErr);
      }
    }

    throw new Error(`Invalid content in ${filePath}`);
  }
}

// Generic write with atomic write + backup + cache update
function writeFile(filePath, data, setCache) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  atomicWriteFileSync(filePath, serialized);

  try {
    atomicWriteFileSync(getBackupPath(filePath), serialized);
  } catch (err) {
    debugError(`Failed to write ${path.basename(filePath)} backup:`, err);
  }

  setCache(data);
}

// --- Users ---
function readUsers() {
  return readFile(USERS_FILE, usersCache, (v) => { usersCache = v; }, []);
}

function writeUsers(users) {
  writeFile(USERS_FILE, users, (v) => { usersCache = v; });
}

// --- Sessions ---
function readSessions() {
  return readFile(SESSIONS_FILE, sessionsCache, (v) => { sessionsCache = v; }, []);
}

function writeSessions(sessions) {
  writeFile(SESSIONS_FILE, sessions, (v) => { sessionsCache = v; });
}

// --- Clubs ---
function readClubs() {
  return readFile(CLUBS_FILE, clubsCache, (v) => { clubsCache = v; }, []);
}

function writeClubs(clubs) {
  writeFile(CLUBS_FILE, clubs, (v) => { clubsCache = v; });
}

// --- Helper: collect push subscriptions from users ---
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

module.exports = {
  readUsers,
  writeUsers,
  readSessions,
  writeSessions,
  readClubs,
  writeClubs,
  getAllSubscriptions,
  getBackupPath,
  debugLog,
  debugError
};
