#!/bin/bash
# Spins up a cheap, throwaway GCP instance in Warsaw (europe-central2) running
# HussBall, prints its IP, and tears it down on Ctrl+C.
#
# Hard failsafe: the instance is created with GCP's native max-run-duration,
# so it self-deletes after 90 minutes no matter what happens to this script,
# your network connection, or your laptop. A second, independent timer is
# also set inside the VM itself as a backstop in case that flag isn't
# supported by your gcloud/API version.
#
# One-time setup before running this (see README section below):
#   1. Install the Google Cloud SDK (gcloud CLI)
#   2. gcloud auth login
#   3. gcloud config set project YOUR_PROJECT_ID   (with billing enabled)

set -e

ZONE="europe-central2-a"   # Warsaw
# e2-micro/e2-small/e2-medium are all "shared-core" — burstable, credit-based
# CPU with different baseline fractions (0.25/0.5/1 vCPU). That USED to be a
# problem here because the tick loop was a tight setImmediate spin (see
# server.js tickLoop) that pinned a core near 100% permanently — not "bursty"
# at all, so it drained burst credit at a steady rate and settled into a flat,
# throttled ceiling once the credit ran out. The tick loop is now sleep-based
# on Linux (only Windows still spins), so real CPU use is ~10% instead of
# ~100% — comfortably under even e2-small's ~50% baseline, so it never touches
# the credit ceiling. e2-small is the cheap shared-core tier with enough
# headroom for real gameplay spikes above that baseline.
MACHINE_TYPE="e2-small"
PORT=3000
MAX_RUN_SECONDS=5400       # 90 minutes
REPO_URL="https://github.com/Nicofisi/HussBall.git"
INSTANCE="hussball-temp-$(date +%s)"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI not found. Install the Google Cloud SDK first:"
  echo "  https://cloud.google.com/sdk/docs/install"
  exit 1
fi

PROJECT="$(gcloud config get-value project 2>/dev/null)"
if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "No default GCP project set. Run:"
  echo "  gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)"
if [ -z "$ACTIVE_ACCOUNT" ]; then
  echo "Not logged in. Run:"
  echo "  gcloud auth login"
  exit 1
fi

echo "Project: $PROJECT"
echo "Zone:    $ZONE"
echo ""

# Firewall rule to let the game port through — created once, reused after that.
if ! gcloud compute firewall-rules describe allow-hussball --project "$PROJECT" >/dev/null 2>&1; then
  echo "Creating firewall rule allow-hussball (TCP $PORT, tag: hussball)..."
  gcloud compute firewall-rules create allow-hussball \
    --project "$PROJECT" \
    --direction=INGRESS \
    --action=ALLOW \
    --rules="tcp:$PORT" \
    --target-tags=hussball \
    --description="HussBall game server port" \
    --quiet
fi

STARTUP_SCRIPT=$(cat <<EOF
#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
git clone --depth 1 "$REPO_URL" /opt/hussball
cd /opt/hussball
npm install --omit=dev
# SHOW_CPU_STAT is opt-in and off by default (it'd leak host load on a real
# deploy) — safe to always enable here since this box is a disposable GCP
# throwaway with no private VPS info to expose.
PORT=$PORT SHOW_CPU_STAT=1 nohup node server.js > /var/log/hussball.log 2>&1 &
# Backstop failsafe in case --max-run-duration isn't honored: hard self-shutdown.
(sleep $MAX_RUN_SECONDS && shutdown -h now) &
EOF
)

echo "Creating instance $INSTANCE ($MACHINE_TYPE)..."
gcloud compute instances create "$INSTANCE" \
  --project "$PROJECT" \
  --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=10GB \
  --boot-disk-type=pd-standard \
  --tags=hussball \
  --max-run-duration="${MAX_RUN_SECONDS}s" \
  --instance-termination-action=DELETE \
  --metadata=startup-script="$STARTUP_SCRIPT" \
  --quiet

cleanup() {
  echo ""
  echo "Deleting instance $INSTANCE..."
  gcloud compute instances delete "$INSTANCE" --project "$PROJECT" --zone "$ZONE" --quiet
  echo "Done."
  exit 0
}
trap cleanup INT TERM

echo "Waiting for external IP..."
IP=""
while [ -z "$IP" ]; do
  IP=$(gcloud compute instances describe "$INSTANCE" --project "$PROJECT" --zone "$ZONE" \
        --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null)
  [ -z "$IP" ] && sleep 2
done

echo ""
echo "=========================================="
echo " HussBall booting at: $IP:$PORT"
echo " (give it ~60-90s after this to finish npm install and start)"
echo " Self-destructs after 90 minutes no matter what."
echo " Press Ctrl+C here to stop and delete it right now."
echo "=========================================="
echo ""

# Stay alive so Ctrl+C can be caught, and notice if GCP's own max-run-duration
# already tore the instance down for us.
while true; do
  sleep 60
  STATUS=$(gcloud compute instances describe "$INSTANCE" --project "$PROJECT" --zone "$ZONE" \
            --format='get(status)' 2>/dev/null || echo "GONE")
  if [ "$STATUS" != "RUNNING" ]; then
    echo "Instance no longer running (status: $STATUS) — exiting."
    exit 0
  fi
done
