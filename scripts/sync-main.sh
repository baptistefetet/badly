#!/bin/bash
# Synchronise la branche main avec dev en utilisant les worktrees
# Usage: ./scripts/sync-main.sh

set -e

DEV_DIR="/Volumes/WWWROOT/badly-dev"
MAIN_DIR="/Volumes/WWWROOT/badly"

echo "📦 Synchronisation de main avec dev..."

# Aller dans le worktree main
cd "$MAIN_DIR"

# S'assurer d'être à jour
git fetch origin

# Merger dev dans main (fast-forward si possible)
git merge origin/dev --ff-only 2>/dev/null || {
    echo "⚠️  Fast-forward impossible, merge classique..."
    git merge origin/dev -m "Merge dev into main"
}

# Pousser main
git push origin main

echo "✅ main synchronisé avec dev !"
