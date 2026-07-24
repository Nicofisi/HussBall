# HussBall

2D top-down multiplayer football game inspired by HaxBall. Runs on Node.js, playable in any browser — no installs, no accounts.

Built for fun during work breaks.

## Maps

- **Classic** — standard football, 5v5 vibes
- **Futsal** — smaller pitch, faster pace
- **Volleyball** — ball has gravity, kick it over the net, no body-blocking
- **Chaos** — classic pitch, with random modifiers cycling in and out through the match:
  - **Bumper Players** — players bounce hard off each other (not off the ball)
  - **Two Balls** — an extra ball joins the match
  - **Big Goals** — goals get a lot bigger
  - **Switch Sides** — goals now score for the other team
  - **Vertical Goals** — goals move to the top/bottom instead of left/right
  - **Bumpers** — random obstacle layouts appear on the pitch (bouncy teal walls, active-kick dark-green kickers) and the field walls turn bouncy too
  - **Magnetic Goals** — once the ball's been touched, it drifts gently toward whichever goal is nearest

  Admins can narrow which modifiers are eligible to appear for the current match.

## How to run

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

### Expose to the internet (Cloudflare Tunnel)

```bash
# Install cloudflared (macOS)
brew install cloudflared

# Quick tunnel (random URL, no account needed)
cloudflared tunnel --url http://localhost:3000
```

Share the generated URL with your friends.

## Controls

| Action | Keys |
|--------|------|
| Move | WASD / Arrow keys |
| Kick | Space, X, Ctrl, Shift, Numpad0 |
| Toggle lobby | ESC |
| Debug hitboxes | F3 |

## Features

- Lobby system with admin controls (move players, randomize teams, change map/settings)
- Circle-based 2D physics with bitmask collision groups
- Velocity extrapolation + smooth correction for fluid multiplayer
- HiDPI/Retina canvas rendering
- Sound effects (Web Audio API, no files)
- In-game chat
- Goal/assist/own-goal credit tracking, based on each ball's touch history
- Ping / FPS / server tick-rate display (optional %CPU too — see Performance below)
- Admin cheats: Numpad1 = extra ball, Numpad2 = speed boost, Numpad3 = skip to the next Chaos modifier

## Stack

Node.js + `ws` (WebSocket) server, vanilla JS + Canvas 2D client. No frameworks, no bundlers, no build step.

## Performance

The tick loop targets a locked 60Hz. Set `SHOW_CPU_STAT=1` to also broadcast
the server process's CPU usage (normalized to one core) alongside the
FPS/ping/tick-rate display — off by default so a normal deploy never reveals
host load to clients:

```bash
SHOW_CPU_STAT=1 npm start
```

## Deployment

- **Docker / prod VPS**: `Dockerfile` + `deploy.sh` build and rsync the app to
  a Docker Compose host.
- **Low-latency GCP throwaway box**: `warsaw-server.sh` spins up a cheap,
  disposable Compute Engine instance in Warsaw for low-ping testing, prints
  its IP, and tears it down on Ctrl+C (or automatically after 90 minutes,
  whichever comes first). Requires the `gcloud` CLI, `gcloud auth login`, and
  a project with billing enabled.

## Project structure

```
server.js               — HTTP + WebSocket server, game loop (60Hz), lobby/admin
shared/physics.js        — physics engine, bitmask collisions, kick mechanics
shared/maps.js           — map definitions (Classic, Futsal, Volleyball, Chaos)
shared/modifiers.js      — Chaos mode's random modifier effects
shared/bumperLayouts.js  — obstacle layouts used by the Bumpers modifier
public/index.html        — client: rendering, input, lobby UI, sound
warsaw-server.sh         — disposable low-latency GCP test server
Dockerfile, deploy.sh    — prod container build + deploy
```
