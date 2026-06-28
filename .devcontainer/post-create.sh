#!/usr/bin/env bash
set -euo pipefail

# ====================================================================
# PaperMind — Post-Create Setup
# Runs after the dev container is created (Codespaces or local VS Code)
# ====================================================================

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║          📚 PaperMind — Dev Environment Setup           ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ------------------------------------------------------------------
# 1. Install Node.js dependencies (pnpm workspace)
# ------------------------------------------------------------------
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Step 1/4: Installing project dependencies (pnpm install)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
pnpm install --registry=https://registry.npmmirror.com
echo ""

# ------------------------------------------------------------------
# 2. Create .env from example if missing
# ------------------------------------------------------------------
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔑 Step 2/4: Checking environment configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "✅ Created .env from .env.example"
    echo "⚠️  Please edit .env with your real credentials before running the app."
  else
    echo "⚠️  No .env.example found — you'll need to create .env manually."
  fi
else
  echo "✅ .env already exists"
fi
echo ""

# ------------------------------------------------------------------
# 3. Verify tooling
# ------------------------------------------------------------------
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔧 Step 3/4: Verifying tooling"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "node : $(node --version)"
echo "pnpm : $(pnpm --version)"
echo "psql : $(psql --version 2>&1 | head -1 || echo 'not found')"
echo "lsof : $(lsof -v 2>&1 | head -1 || echo 'present')"
echo "nc   : $(nc -h 2>&1 | head -1 || echo 'present')"
echo ""

# ------------------------------------------------------------------
# 4. Ready
# ------------------------------------------------------------------
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Step 4/4: Environment ready!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  🚀 Start the server:   cd server && pnpm dev"
echo "  🌐 Start Expo web:     cd client && npx expo start --web"
echo "  🔍 Lint everything:    pnpm lint:all"
echo ""
echo "  📖 Server runs on http://localhost:9091"
echo "  📖 Expo web runs on http://localhost:5000"
echo ""
echo "  💡 Tip: Codespaces auto-forwards ports 9091 and 5000."
echo "     Click 'Open in Browser' on the Ports tab when ready."
echo ""
