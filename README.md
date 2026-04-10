# HussBall

2D top-down multiplayer football game inspired by HaxBall. Runs on Node.js, playable in any browser — no installs, no accounts.

Built for fun during work breaks.

## Maps

- **Classic** — standard football, 5v5 vibes
- **Futsal** — smaller pitch, faster pace
- **Volleyball** — ball has gravity, kick it over the net, no body-blocking
- **Chaos** — classic pitch with random events (bouncy walls, bumper players)

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
- Ping display
- Admin cheats: Numpad1 = extra ball, Numpad2 = speed boost

## Stack

Node.js + `ws` (WebSocket) server, vanilla JS + Canvas 2D client. No frameworks, no bundlers, no build step.

## Project structure

```
server.js          — HTTP + WebSocket server, game loop (60Hz), lobby/admin
shared/physics.js  — physics engine, bitmask collisions, kick mechanics
shared/maps.js     — map definitions (Classic, Futsal, Volleyball, Chaos)
public/index.html  — client: rendering, input, lobby UI, sound
```
