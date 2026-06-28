# PaperMind DevContainer — Node.js 24 + PostgreSQL client + pnpm
# Base: Node 24 LTS on Debian Bookworm (slim)
FROM node:24-bookworm-slim

# ------------------------------------------------------------------
# System packages
# ------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Required by dev_run.sh & server_dev_run.sh
    lsof \
    netcat-openbsd \
    # Python 3 (supabase-client.ts calls python3 + Coze preview scripts call python)
    python3 \
    python3-pip \
    python-is-python3 \
    # PostgreSQL client (psql, pg_isready, pg_dump) for drizzle-kit & db inspection
    postgresql-client \
    # General utilities
    curl \
    wget \
    git \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------------
# pnpm (version 9, as specified in package.json)
# ------------------------------------------------------------------
RUN corepack enable && corepack prepare pnpm@9 --activate

# ------------------------------------------------------------------
# Environment variables for Expo + Node
# ------------------------------------------------------------------
ENV NODE_ENV=development \
    PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"

# Allow running as non-root user for VS Code / Codespaces
RUN mkdir -p /pnpm && chmod -R 777 /pnpm

# ------------------------------------------------------------------
# Pre-create workspace directory
# ------------------------------------------------------------------
WORKDIR /workspace

# Make bash the default (already is, but explicit)
SHELL ["/bin/bash", "-c"]

CMD ["sleep", "infinity"]
