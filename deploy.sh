#!/bin/bash
# Deploy HussBall to Mikrus VPS
set -e

REMOTE="mikrus:/root/apps/apps/hussball/"
SSH_PORT=10231

rsync -az \
  --exclude node_modules \
  --exclude .git \
  --exclude .idea \
  --exclude .env \
  --exclude data \
  -e "ssh -p $SSH_PORT" \
  ./ "$REMOTE"

ssh -p $SSH_PORT mikrus "cd /root/apps && docker compose up -d --build --quiet-pull hussball 2>&1 | tail -3"
