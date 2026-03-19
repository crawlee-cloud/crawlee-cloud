#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Crawlee Cloud - DigitalOcean Full Setup
# ============================================================
# Deploys the complete stack on DigitalOcean:
#   - API + Dashboard on App Platform
#   - Runner on a Droplet (needs Docker socket)
#   - Managed PostgreSQL + Redis (Valkey) clusters
#
# Prerequisites:
#   - doctl installed and authenticated (doctl auth init)
#   - SSH key added to your DO account
#
# Usage:
#   bash deploy/digitalocean/setup.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="https://github.com/crawlee-cloud/crawlee-cloud.git"
REGION="nyc1"
APP_REGION="nyc"

echo ""
echo "=========================================="
echo "  Crawlee Cloud - DigitalOcean Setup"
echo "=========================================="
echo ""

# -------------------------------------------
# Pre-flight checks
# -------------------------------------------
if ! command -v doctl &>/dev/null; then
    echo "Error: doctl is not installed."
    echo "Install it: https://docs.digitalocean.com/reference/doctl/how-to/install/"
    exit 1
fi

if ! doctl account get &>/dev/null 2>&1; then
    echo "Error: doctl is not authenticated."
    echo "Run: doctl auth init"
    exit 1
fi

echo "Authenticated as: $(doctl account get --format Email --no-header)"
echo ""

# -------------------------------------------
# Gather configuration
# -------------------------------------------
read -rp "Admin email [admin@crawlee.cloud]: " ADMIN_EMAIL
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@crawlee.cloud}"

ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '\n/+=')
API_SECRET=$(openssl rand -hex 32)

# Find SSH key
echo ""
echo "Available SSH keys:"
doctl compute ssh-key list --format ID,Name,FingerPrint
echo ""
read -rp "SSH key ID to use for the Runner Droplet: " SSH_KEY_ID
if [[ -z "${SSH_KEY_ID}" ]]; then
    echo "Error: SSH key ID is required."
    exit 1
fi

read -rp "SSH private key path [~/.ssh/id_rsa]: " SSH_KEY_PATH
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_rsa}"

read -rp "Max concurrent Actor runs on Runner [5]: " MAX_RUNS
MAX_RUNS="${MAX_RUNS:-5}"

echo ""
echo "Creating infrastructure..."

# -------------------------------------------
# Step 1: Create PostgreSQL cluster
# -------------------------------------------
echo ""
echo "[1/5] Creating PostgreSQL cluster..."

PG_EXISTS=$(doctl databases list -o json 2>/dev/null | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const found=d.find(x=>x.name==='crawlee-cloud-db');
  if(found) process.stdout.write(found.id);
" 2>/dev/null || true)

if [[ -n "${PG_EXISTS}" ]]; then
    echo "  PostgreSQL cluster already exists (${PG_EXISTS})"
    PG_ID="${PG_EXISTS}"
else
    PG_ID=$(doctl databases create crawlee-cloud-db \
        --engine pg --region "${REGION}" \
        --size db-s-1vcpu-1gb --num-nodes 1 --version 16 \
        --wait --format ID --no-header 2>/dev/null)
    echo "  Created: ${PG_ID}"
fi

PG_URI=$(doctl databases connection "${PG_ID}" --format URI --no-header)
echo "  Connection: ${PG_URI:0:50}..."

# -------------------------------------------
# Step 2: Create Redis (Valkey) cluster
# -------------------------------------------
echo ""
echo "[2/5] Creating Redis (Valkey) cluster..."

REDIS_EXISTS=$(doctl databases list -o json 2>/dev/null | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const found=d.find(x=>x.name==='crawlee-cloud-redis');
  if(found) process.stdout.write(found.id);
" 2>/dev/null || true)

if [[ -n "${REDIS_EXISTS}" ]]; then
    echo "  Redis cluster already exists (${REDIS_EXISTS})"
    REDIS_ID="${REDIS_EXISTS}"
else
    REDIS_ID=$(doctl databases create crawlee-cloud-redis \
        --engine valkey --region "${REGION}" \
        --size db-s-1vcpu-1gb --num-nodes 1 --version 8 \
        --wait --format ID --no-header 2>/dev/null)
    echo "  Created: ${REDIS_ID}"
fi

REDIS_URI=$(doctl databases connection "${REDIS_ID}" --format URI --no-header)
echo "  Connection: ${REDIS_URI:0:50}..."

# -------------------------------------------
# Step 3: Deploy App Platform (API + Dashboard)
# -------------------------------------------
echo ""
echo "[3/5] Deploying API + Dashboard on App Platform..."

# Generate the app spec with real values
cat > /tmp/crawlee-app-spec.yaml <<SPEC
name: crawlee-cloud
region: ${APP_REGION}

services:
  - name: api
    git:
      branch: main
      repo_clone_url: ${REPO_URL}
    dockerfile_path: docker/Dockerfile.api
    http_port: 3000
    instance_count: 1
    instance_size_slug: basic-s
    health_check:
      http_path: /health
    routes:
      - path: /
    run_command: sh -c "node packages/api/dist/db/migrate.js; node packages/api/dist/index.js"
    envs:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "3000"
      - key: DATABASE_URL
        scope: RUN_TIME
        value: ${PG_URI}
      - key: REDIS_URL
        scope: RUN_TIME
        value: ${REDIS_URI}
      - key: S3_ENDPOINT
        scope: RUN_TIME
        value: REPLACE_WITH_SPACES_ENDPOINT
      - key: S3_ACCESS_KEY
        type: SECRET
        value: REPLACE_ME
      - key: S3_SECRET_KEY
        type: SECRET
        value: REPLACE_ME
      - key: S3_BUCKET
        value: crawlee-cloud
      - key: S3_REGION
        value: ${REGION}
      - key: S3_FORCE_PATH_STYLE
        value: "false"
      - key: API_SECRET
        type: SECRET
        value: "${API_SECRET}"
      - key: ADMIN_EMAIL
        value: "${ADMIN_EMAIL}"
      - key: ADMIN_PASSWORD
        type: SECRET
        value: "${ADMIN_PASSWORD}"
      - key: LOG_LEVEL
        value: info
      - key: NODE_TLS_REJECT_UNAUTHORIZED
        scope: RUN_TIME
        value: "0"
      - key: CORS_ORIGINS
        value: \${APP_URL}

  - name: dashboard
    git:
      branch: main
      repo_clone_url: ${REPO_URL}
    dockerfile_path: docker/Dockerfile.dashboard
    http_port: 3001
    instance_count: 1
    instance_size_slug: basic-s
    routes:
      - path: /dashboard
    envs:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "3001"
      - key: NEXT_PUBLIC_API_URL
        value: \${APP_URL}
      - key: NEXT_PUBLIC_ASSET_PREFIX
        value: /dashboard
      - key: NEXT_PUBLIC_ROUTE_PREFIX
        value: /dashboard
SPEC

# Check if app already exists
APP_ID=$(doctl apps list -o json 2>/dev/null | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const found=d.find(x=>x.spec?.name==='crawlee-cloud');
  if(found) process.stdout.write(found.id);
" 2>/dev/null || true)

if [[ -n "${APP_ID}" ]]; then
    echo "  App already exists (${APP_ID}). Updating..."
    doctl apps update "${APP_ID}" --spec /tmp/crawlee-app-spec.yaml >/dev/null 2>&1
else
    echo "  Creating app..."
    APP_ID=$(doctl apps create --spec /tmp/crawlee-app-spec.yaml --format ID --no-header 2>/dev/null)
fi

echo "  App ID: ${APP_ID}"
echo "  Waiting for deployment..."

# Wait for deployment to complete
for i in $(seq 1 60); do
    STATUS=$(doctl apps list-deployments "${APP_ID}" --format Phase --no-header 2>/dev/null | head -1)
    if [[ "${STATUS}" == "ACTIVE" ]]; then
        break
    fi
    if [[ "${STATUS}" == "ERROR" ]]; then
        echo "  Deployment failed. Check logs with: doctl apps logs ${APP_ID} api --type run"
        exit 1
    fi
    sleep 10
done

APP_URL=$(doctl apps get "${APP_ID}" -o json 2>/dev/null | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))[0];
  process.stdout.write(d.default_ingress || 'unknown');
" 2>/dev/null || echo "unknown")

echo "  Deployed: ${APP_URL}"

# -------------------------------------------
# Step 4: Create Runner Droplet
# -------------------------------------------
echo ""
echo "[4/5] Creating Runner Droplet..."

DROPLET_EXISTS=$(doctl compute droplet list --format Name,ID --no-header 2>/dev/null | grep "^crawlee-runner " | awk '{print $2}' || true)

if [[ -n "${DROPLET_EXISTS}" ]]; then
    echo "  Droplet already exists (${DROPLET_EXISTS})"
    DROPLET_ID="${DROPLET_EXISTS}"
    DROPLET_IP=$(doctl compute droplet get "${DROPLET_ID}" --format PublicIPv4 --no-header)
else
    # Create cloud-init script
    cat > /tmp/crawlee-runner-init.sh <<'INITEOF'
#!/bin/bash
set -e
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
git clone https://github.com/crawlee-cloud/crawlee-cloud.git /opt/crawlee-cloud
cd /opt/crawlee-cloud
npm install
npm run build --workspace=@crawlee-cloud/api
npm run build --workspace=@crawlee-cloud/runner
cat > /etc/systemd/system/crawlee-runner.service << 'EOF'
[Unit]
Description=Crawlee Cloud Runner
After=docker.service
Requires=docker.service
[Service]
Type=simple
WorkingDirectory=/opt/crawlee-cloud
ExecStart=/usr/bin/node packages/runner/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=NODE_TLS_REJECT_UNAUTHORIZED=0
EnvironmentFile=/etc/crawlee-runner.env
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable crawlee-runner
INITEOF

    DROPLET_ID=$(doctl compute droplet create crawlee-runner \
        --image docker-20-04 \
        --size s-1vcpu-2gb \
        --region "${REGION}" \
        --ssh-keys "${SSH_KEY_ID}" \
        --user-data-file /tmp/crawlee-runner-init.sh \
        --wait --format ID --no-header 2>/dev/null)

    DROPLET_IP=$(doctl compute droplet get "${DROPLET_ID}" --format PublicIPv4 --no-header)
    echo "  Created: ${DROPLET_IP}"
fi

echo "  Droplet IP: ${DROPLET_IP}"

# -------------------------------------------
# Step 5: Configure and start Runner
# -------------------------------------------
echo ""
echo "[5/5] Configuring Runner..."

echo "  Waiting for cloud-init to finish..."
for i in $(seq 1 60); do
    CLOUD_STATUS=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "${SSH_KEY_PATH}" "root@${DROPLET_IP}" "cloud-init status 2>/dev/null | grep -o 'done\|running' || echo 'waiting'" 2>/dev/null || echo "waiting")
    if [[ "${CLOUD_STATUS}" == "done" ]]; then
        break
    fi
    sleep 10
done

# Push env file
ssh -o StrictHostKeyChecking=no -i "${SSH_KEY_PATH}" "root@${DROPLET_IP}" "cat > /etc/crawlee-runner.env << 'EOF'
DATABASE_URL=${PG_URI}
REDIS_URL=${REDIS_URI}
API_BASE_URL=${APP_URL}
DOCKER_NETWORK=bridge
MAX_CONCURRENT_RUNS=${MAX_RUNS}
DEFAULT_MEMORY_MB=1024
DEFAULT_TIMEOUT_SECS=3600
LOG_LEVEL=info
EOF
chmod 600 /etc/crawlee-runner.env" 2>/dev/null

# Run migrations on the production PG
echo "  Running database migrations..."
ssh -i "${SSH_KEY_PATH}" "root@${DROPLET_IP}" "cd /opt/crawlee-cloud && NODE_TLS_REJECT_UNAUTHORIZED=0 DATABASE_URL='${PG_URI}' node packages/api/dist/db/migrate.js 2>&1 | tail -2" 2>/dev/null || echo "  (migrations may have already run via App Platform)"

# Start the runner
ssh -i "${SSH_KEY_PATH}" "root@${DROPLET_IP}" "systemctl restart crawlee-runner" 2>/dev/null
sleep 3

RUNNER_STATUS=$(ssh -i "${SSH_KEY_PATH}" "root@${DROPLET_IP}" "systemctl is-active crawlee-runner 2>/dev/null" 2>/dev/null || echo "unknown")
echo "  Runner status: ${RUNNER_STATUS}"

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "=========================================="
echo "  Crawlee Cloud - Deployment Complete!"
echo "=========================================="
echo ""
echo "  API:        ${APP_URL}"
echo "  Dashboard:  ${APP_URL}/dashboard/login"
echo "  Runner:     ${DROPLET_IP} (Droplet)"
echo ""
echo "  Admin Email:    ${ADMIN_EMAIL}"
echo "  Admin Password: ${ADMIN_PASSWORD}"
echo ""
echo "=========================================="
echo "  Infrastructure"
echo "=========================================="
echo ""
echo "  App Platform:  ${APP_ID}"
echo "  PostgreSQL:    crawlee-cloud-db (${PG_ID})"
echo "  Redis/Valkey:  crawlee-cloud-redis (${REDIS_ID})"
echo "  Runner:        crawlee-runner (${DROPLET_ID})"
echo ""
echo "=========================================="
echo "  Common Commands"
echo "=========================================="
echo ""
echo "  View API logs:"
echo "    doctl apps logs ${APP_ID} api --type run --tail 50"
echo ""
echo "  View Runner logs:"
echo "    ssh -i ${SSH_KEY_PATH} root@${DROPLET_IP} journalctl -u crawlee-runner -f"
echo ""
echo "  Restart Runner:"
echo "    ssh -i ${SSH_KEY_PATH} root@${DROPLET_IP} systemctl restart crawlee-runner"
echo ""
echo "  Redeploy app (after git push):"
echo "    doctl apps create-deployment ${APP_ID} --force-rebuild"
echo ""
echo "  Update Runner code:"
echo "    ssh -i ${SSH_KEY_PATH} root@${DROPLET_IP} 'cd /opt/crawlee-cloud && git pull && npm install && npm run build --workspace=@crawlee-cloud/runner && systemctl restart crawlee-runner'"
echo ""
echo "=========================================="
echo ""
echo "  IMPORTANT: Save your admin password!"
echo "  It will not be shown again."
echo ""
echo "  NOTE: S3 storage is set to REPLACE_ME."
echo "  Create a DO Spaces bucket and update the"
echo "  S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY"
echo "  in the App Platform dashboard."
echo ""
echo "=========================================="
