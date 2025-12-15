#!/bin/bash
# Script de déploiement automatique pour badly-dev
# Appelé par le webhook /webhook/deploy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 Git pull..."
git fetch origin dev
git reset --hard origin/dev

echo "📦 Installation des dépendances..."
npm install --production --silent

echo "🔄 Redémarrage du serveur..."
# Le serveur se relancera via le script principal
# On utilise un processus détaché pour éviter de bloquer
(
  sleep 2
  # Trouver et tuer le processus node sur ce répertoire
  # On utilise le port défini dans .env ou 3001 par défaut pour dev
  PORT="${PORT:-3001}"
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 1
  # Relancer le serveur en arrière-plan
  nohup /usr/bin/node server.js > /dev/null 2>&1 &
  echo "✅ Serveur redémarré sur le port $PORT"
) &

echo "✅ Déploiement initié"
