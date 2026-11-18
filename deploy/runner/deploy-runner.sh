#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Crawlee Cloud - Runner Deployment Script
# ============================================
# Use this to connect a Runner to a PaaS-hosted
# Crawlee Cloud instance (Railway, Render, DO).
# Run on any VPS with Docker support.

REPO_URL="https://github.com/crawlee-cloud/crawlee-cloud.git"
INSTALL_DIR="/opt/crawlee-cloud-runner"

echo ""
echo "=========================================="
echo "  Crawlee Cloud - Runner Setup"
echo "=========================================="
echo ""
echo "  This script connects a Runner to your"
echo "  Crawlee Cloud API so Actors can execute."
echo ""

# -------------------------------------------
# Gather connection details
# -------------------------------------------
read -rp "Crawlee Cloud API URL (e.g. https://crawlee-api.up.railway.app): " API_BASE_URL
if [[ -z "${API_BASE_URL}" ]]; then
    echo "Error: API URL is required."
    exit 1
fi

read -rp "API Secret (from your PaaS environment variables): " API_TOKEN
if [[ -z "${API_TOKEN}" ]]; then
    echo "Error: API Secret is required."
    exit 1
fi

read -rp "Database URL (from your PaaS database addon): " DATABASE_URL
if [[ -z "${DATABASE_URL}" ]]; then
    echo "Error: Database URL is required."
    exit 1
fi

read -rp "Redis URL (from your PaaS Redis addon): " REDIS_URL
if [[ -z "${REDIS_URL}" ]]; then
    echo "Error: Redis URL is required."
    exit 1
fi

read -rp "Proxy encryption key (PROXY_ENCRYPTION_KEY from your API service): " PROXY_ENCRYPTION_KEY
if [[ -z "${PROXY_ENCRYPTION_KEY}" ]]; then
    echo "Error: PROXY_ENCRYPTION_KEY is required. It must be the same 64-hex-character value the API uses."
    exit 1
fi

read -rp "Max concurrent Actor runs [5]: " MAX_CONCURRENT_RUNS
MAX_CONCURRENT_RUNS="${MAX_CONCURRENT_RUNS:-5}"

# -------------------------------------------
# Install Docker if not present
# -------------------------------------------
if ! command -v docker &>/dev/null; then
    echo ""
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "Docker installed successfully."
else
    echo ""
    echo "Docker is already installed."
fi

# -------------------------------------------
# Clone repo and build Runner
# -------------------------------------------
echo ""
echo "Setting up Runner in ${INSTALL_DIR}..."

if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo "Existing installation found. Pulling latest..."
    git -C "${INSTALL_DIR}" pull
else
    git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

# -------------------------------------------
# Create Runner compose file
# -------------------------------------------
mkdir -p deploy/runner

cat > deploy/runner/docker-compose.runner.yml <<COMPOSE
# Pins the project name: DOCKER_NETWORK below is this project's default
# network, which Compose names <project>_default.
name: crawlee-runner
services:
  runner:
    build:
      context: ../../
      dockerfile: docker/Dockerfile.runner
    environment:
      - NODE_ENV=production
      - API_BASE_URL=\${API_BASE_URL}
      - API_TOKEN=\${API_TOKEN}
      - DATABASE_URL=\${DATABASE_URL}
      - REDIS_URL=\${REDIS_URL}
      - PROXY_ENCRYPTION_KEY=\${PROXY_ENCRYPTION_KEY}
      - DOCKER_SOCKET=/var/run/docker.sock
      - DOCKER_NETWORK=crawlee-runner_default
      - MAX_CONCURRENT_RUNS=\${MAX_CONCURRENT_RUNS:-5}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    restart: unless-stopped
COMPOSE

# -------------------------------------------
# Write .env file
# -------------------------------------------
cat > deploy/runner/.env <<EOF
# Crawlee Cloud Runner Configuration
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

API_BASE_URL=${API_BASE_URL}
API_TOKEN=${API_TOKEN}
DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}
PROXY_ENCRYPTION_KEY=${PROXY_ENCRYPTION_KEY}
MAX_CONCURRENT_RUNS=${MAX_CONCURRENT_RUNS}
EOF

chmod 600 deploy/runner/.env

# -------------------------------------------
# Start Runner
# -------------------------------------------
echo ""
echo "Building and starting Runner..."
cd deploy/runner
# Earlier versions of this script ran the stack as Compose project `runner`
# (the directory name). Remove that runner first, or it keeps claiming runs
# on its old image next to the new one. A no-op on a fresh install.
docker compose -p runner -f docker-compose.runner.yml down 2>/dev/null || true
docker compose -f docker-compose.runner.yml up -d --build

echo ""
echo "=========================================="
echo "  Runner is starting!"
echo "=========================================="
echo ""
echo "  Connected to: ${API_BASE_URL}"
echo "  Max concurrent runs: ${MAX_CONCURRENT_RUNS}"
echo ""
echo "  Config: ${INSTALL_DIR}/deploy/runner/.env"
echo ""
echo "  View logs:"
echo "    cd ${INSTALL_DIR}/deploy/runner && docker compose -f docker-compose.runner.yml logs -f"
echo ""
echo "  Stop:"
echo "    cd ${INSTALL_DIR}/deploy/runner && docker compose -f docker-compose.runner.yml down"
echo ""
echo "  Update:"
echo "    cd ${INSTALL_DIR} && git pull"
echo "    cd deploy/runner && docker compose -f docker-compose.runner.yml up -d --build"
echo ""
echo "=========================================="
