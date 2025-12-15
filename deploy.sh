#!/bin/bash
# Script de déploiement automatique pour badly
# Appelé par le webhook /webhook/deploy
# Fonctionne pour dev (port 3002, branche dev) et prod (port 3001, branche main)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Détecter la branche selon le port (3001 = prod/main, 3002 = dev)
PORT="${PORT:-3000}"
if [ "$PORT" = "3001" ]; then
  BRANCH="main"
else
  BRANCH="dev"
fi

echo "📦 Git pull (branche $BRANCH)..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "📦 Installation des dépendances..."
npm install --production --silent

echo "🔄 Redémarrage du serveur..."
(
  sleep 2
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
  nohup /usr/bin/node server.js > /dev/null 2>&1 &
  echo "✅ Serveur redémarré sur le port $PORT (branche $BRANCH)"
) &

echo "✅ Déploiement initié"
