#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Crawlee Cloud - VPS Deployment Script
# ============================================

REPO_URL="https://github.com/crawlee-cloud/crawlee-cloud.git"
INSTALL_DIR="/opt/crawlee-cloud"

# -------------------------------------------
# Banner
# -------------------------------------------
echo ""
echo "=========================================="
echo "  Crawlee Cloud - VPS Deployment"
echo "=========================================="
echo ""

# -------------------------------------------
# Prompt for required configuration
# -------------------------------------------
read -rp "Enter your domain name (e.g. crawlee.example.com): " DOMAIN
if [[ -z "${DOMAIN}" ]]; then
    echo "Error: Domain name is required."
    exit 1
fi

read -rp "Enter admin email address: " ADMIN_EMAIL
if [[ -z "${ADMIN_EMAIL}" ]]; then
    echo "Error: Admin email is required."
    exit 1
fi

echo ""
echo "Generating secure credentials..."

# -------------------------------------------
# Generate secrets
# -------------------------------------------
API_SECRET=$(openssl rand -base64 48 | tr -d '\n/+=')
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=')
DB_USER="crawlee"
DB_NAME="crawlee_cloud"
REDIS_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=')
S3_ACCESS_KEY=$(openssl rand -hex 16)
S3_SECRET_KEY=$(openssl rand -base64 32 | tr -d '\n/+=')
ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '\n/+=')
# Shared by the API and the runner: both encrypt/decrypt the same proxy columns.
# Used only when .env has no key yet. It is held under a different name and
# PROXY_ENCRYPTION_KEY is unset, because Compose prefers a shell variable
# over .env: an exported or freshly assigned value here would override the
# key an existing install keeps in .env. A key the operator exported is
# honoured as the fallback instead of generating one.
NEW_PROXY_ENCRYPTION_KEY="${PROXY_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
unset PROXY_ENCRYPTION_KEY
# An assignment of the key in .env, in any spelling Compose accepts…
PROXY_KEY_ANY='^[[:space:]]*(export[[:space:]]+)?PROXY_ENCRYPTION_KEY[[:space:]]*='
# …and one whose value is what the API and runner require: 64 hex characters.
PROXY_KEY_VALID="${PROXY_KEY_ANY}[[:space:]]*[\"']?[0-9a-fA-F]{64}[\"']?[[:space:]]*\$"

echo "Credentials generated."
echo ""

# -------------------------------------------
# Install Docker if not present
# -------------------------------------------
if ! command -v docker &>/dev/null; then
    echo "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "Docker installed successfully."
else
    echo "Docker is already installed."
fi

# -------------------------------------------
# Verify docker compose is available
# -------------------------------------------
if ! docker compose version &>/dev/null; then
    echo "Error: 'docker compose' (v2) is required but not found."
    echo "Please install the Docker Compose plugin: https://docs.docker.com/compose/install/"
    exit 1
fi

echo "Docker Compose detected: $(docker compose version --short)"
echo ""

# -------------------------------------------
# Clone or update repository
# -------------------------------------------
if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo "Existing installation found at ${INSTALL_DIR}. Pulling latest changes..."
    git -C "${INSTALL_DIR}" pull
else
    echo "Cloning Crawlee Cloud to ${INSTALL_DIR}..."
    git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

echo ""

# -------------------------------------------
# Write .env file
# -------------------------------------------
cd "${INSTALL_DIR}/deploy/vps"

if [[ -f .env ]]; then
    # Re-run on an existing install. Regenerating secrets here would lock the
    # stack out of its own database (the postgres volume keeps the old
    # password) and make stored proxy credentials undecryptable.
    echo "Existing configuration found at ${INSTALL_DIR}/deploy/vps/.env - keeping it."
    echo "The domain and admin email entered above are ignored; edit .env to change them."
    if ! grep -Eq "${PROXY_KEY_ANY}" .env; then
        # Leading newline: a hand-edited .env may not end in one.
        printf '\nPROXY_ENCRYPTION_KEY=%s\n' "${NEW_PROXY_ENCRYPTION_KEY}" >> .env
        echo "Added PROXY_ENCRYPTION_KEY (the API and runner require it in production)."
    elif ! grep -Eq "${PROXY_KEY_VALID}" .env; then
        # Do not append a second assignment: the later one would win, and if
        # the first was ever in use its proxy credentials become undecryptable.
        echo "Error: PROXY_ENCRYPTION_KEY in ${INSTALL_DIR}/deploy/vps/.env is empty or is not"
        echo "exactly 64 hex characters. Fix that line by hand (openssl rand -hex 32 makes a"
        echo "new key; only use a new one if no proxy passwords are stored yet), then re-run."
        exit 1
    fi
    ADMIN_PASSWORD="(unchanged - see ${INSTALL_DIR}/deploy/vps/.env)"
else
    echo "Writing configuration to ${INSTALL_DIR}/deploy/vps/.env ..."

cat > .env <<EOF
# Crawlee Cloud - Production Configuration
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# WARNING: This file contains secrets. Do not commit to version control.

DOMAIN=${DOMAIN}
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}

API_SECRET=${API_SECRET}
PROXY_ENCRYPTION_KEY=${NEW_PROXY_ENCRYPTION_KEY}

DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}

REDIS_PASSWORD=${REDIS_PASSWORD}

S3_ACCESS_KEY=${S3_ACCESS_KEY}
S3_SECRET_KEY=${S3_SECRET_KEY}
EOF
fi

chmod 600 .env

echo "Configuration written and secured (chmod 600)."
echo ""

# -------------------------------------------
# Start services
# -------------------------------------------
echo "Running database migrations..."
# Migrations do not run on API startup. `run --build` rebuilds the image
# first (so a re-run migrates with the NEW code, not a stale image) and
# starts postgres, a healthchecked dependency, before the one-off container.
# stdin is detached so a piped install (`curl … | bash`) is not consumed.
docker compose -f docker-compose.prod.yml run --rm --build api node packages/api/dist/db/migrate.js </dev/null

echo "Starting Crawlee Cloud services..."
# --remove-orphans drops containers of services this file no longer defines,
# e.g. the old `scheduler`, which would otherwise restart-loop forever.
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

echo ""
echo "Waiting for services to initialize..."
sleep 10

# -------------------------------------------
# Deployment summary
# -------------------------------------------
echo ""
echo "=========================================="
echo "  Deployment Complete!"
echo "=========================================="
echo ""
echo "  API URL:        https://${DOMAIN}"
echo "  Dashboard URL:  https://dashboard.${DOMAIN}"
echo ""
echo "  Admin Email:    ${ADMIN_EMAIL}"
echo "  Admin Password: ${ADMIN_PASSWORD}"
echo ""
echo "  Install Dir:    ${INSTALL_DIR}"
echo "  Config File:    ${INSTALL_DIR}/deploy/vps/.env"
echo ""
echo "=========================================="
echo "  DNS Configuration"
echo "=========================================="
echo ""
echo "  Point both of the following DNS records"
echo "  to this server's IP address:"
echo ""
echo "    ${DOMAIN}            -> <YOUR_SERVER_IP>"
echo "    dashboard.${DOMAIN}  -> <YOUR_SERVER_IP>"
echo ""
echo "  Caddy will automatically provision HTTPS"
echo "  certificates via Let's Encrypt once DNS"
echo "  records are active."
echo ""
echo "=========================================="
echo "  Common Commands"
echo "=========================================="
echo ""
echo "  View logs:"
echo "    cd ${INSTALL_DIR}/deploy/vps && docker compose -f docker-compose.prod.yml logs -f"
echo ""
echo "  Stop all services:"
echo "    cd ${INSTALL_DIR}/deploy/vps && docker compose -f docker-compose.prod.yml down"
echo ""
echo "  Update to latest version:"
echo "    cd ${INSTALL_DIR} && git pull && cd deploy/vps \\"
echo "      && docker compose -f docker-compose.prod.yml run --rm --build api node packages/api/dist/db/migrate.js \\"
echo "      && docker compose -f docker-compose.prod.yml up -d --build --remove-orphans"
echo ""
echo "  Restart services:"
echo "    cd ${INSTALL_DIR}/deploy/vps && docker compose -f docker-compose.prod.yml restart"
echo ""
echo "=========================================="
echo ""
echo "  IMPORTANT: Save your admin password above"
echo "  in a safe place. It will not be shown again."
echo ""
echo "=========================================="
