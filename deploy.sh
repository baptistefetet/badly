#!/bin/bash
# Script de déploiement automatique pour badly
# Appelé par le webhook /webhook/deploy
# Fonctionne pour dev (port 3002, branche dev) et prod (port 3001, branche main)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Détecter la branche et le service selon le port
PORT="${PORT:-3000}"
if [ "$PORT" = "3001" ]; then
  BRANCH="main"
  SERVICE="badly"
else
  BRANCH="dev"
  SERVICE="badly-dev"
fi

echo "📦 Git pull (branche $BRANCH)..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "📦 Installation des dépendances..."
npm install --production --silent

echo "🔄 Redémarrage du service $SERVICE..."
sudo /usr/bin/systemctl restart "$SERVICE"

echo "✅ Déploiement terminé (service $SERVICE, branche $BRANCH)"
