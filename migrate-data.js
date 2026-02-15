#!/usr/bin/env node

// Migration script: split data.json into data/users.json, data/sessions.json, data/clubs.json
// Usage: node migrate-data.js [data-file]
// Default data-file: data.json

const fs = require('fs');
const path = require('path');

const dataFile = process.argv[2] || 'data.json';
const dataPath = path.join(__dirname, dataFile);

if (!fs.existsSync(dataPath)) {
  console.error(`Fichier introuvable: ${dataPath}`);
  process.exit(1);
}

console.log(`Lecture de ${dataFile}...`);
const raw = fs.readFileSync(dataPath, 'utf8');
const data = JSON.parse(raw);

const users = data.users || [];
const sessions = data.sessions || [];
const clubs = data.clubs || [];
const pushSubscriptions = data.pushSubscriptions || [];

// Integrate push subscriptions into users
let mappedCount = 0;
for (const user of users) {
  const userSubs = pushSubscriptions.filter(sub => sub.user === user.name);
  user.pushSubscriptions = userSubs.map(({ user: _u, ...rest }) => rest);
  mappedCount += userSubs.length;
}

// Check for orphaned subscriptions
const orphaned = pushSubscriptions.filter(
  sub => !users.some(u => u.name === sub.user)
);
if (orphaned.length > 0) {
  console.warn(`ATTENTION: ${orphaned.length} souscription(s) orpheline(s) (utilisateur introuvable):`);
  orphaned.forEach(sub => console.warn(`  - endpoint: ${sub.endpoint.substring(0, 60)}... (user: ${sub.user})`));
}

// Create data directory
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Write files
const writeJson = (filePath, content) => {
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  fs.writeFileSync(filePath, serialized, 'utf8');
  console.log(`  ${path.basename(filePath)} (${serialized.length} octets)`);
};

console.log('\nEcriture des fichiers:');
writeJson(path.join(dataDir, 'users.json'), users);
writeJson(path.join(dataDir, 'sessions.json'), sessions);
writeJson(path.join(dataDir, 'clubs.json'), clubs);

// Summary
console.log('\nResume:');
console.log(`  Users:              ${users.length}`);
console.log(`  Sessions:           ${sessions.length}`);
console.log(`  Clubs:              ${clubs.length}`);
console.log(`  Push subscriptions: ${pushSubscriptions.length} -> ${mappedCount} integrees dans les users`);

const usersWithSubs = users.filter(u => u.pushSubscriptions.length > 0);
if (usersWithSubs.length > 0) {
  console.log(`  Users avec push:    ${usersWithSubs.map(u => `${u.name} (${u.pushSubscriptions.length})`).join(', ')}`);
}

console.log('\nMigration terminee.');
