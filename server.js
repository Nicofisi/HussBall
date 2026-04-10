// HussBall Server
// HTTP static server + WebSocket game server
// Lobby with admin system, team management, then gameplay

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const physics = require('./shared/physics');
const { C } = physics;
const { ALL_MAPS, CLASSIC } = require('./shared/maps');

// ============================================================
// Config
// ============================================================
const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

// ============================================================
// Static file server
// ============================================================
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveStatic(req, res) {
  let filePath;
  const url = req.url.split('?')[0]; // strip query string
  if (url === '/' || url === '/index.html') {
    filePath = path.join(__dirname, 'public', 'index.html');
  } else if (url.startsWith('/shared/')) {
    filePath = path.join(__dirname, url);
  } else {
    filePath = path.join(__dirname, 'public', url);
  }

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const httpServer = http.createServer(serveStatic);

// ============================================================
// Room State
// ============================================================
let currentMap = CLASSIC;
let players = new Map();   // id -> player object
let nextPlayerId = 1;
let adminId = null;        // id of the admin player
let freeJoin = true;       // can players pick their own team?
let roomPhase = 'lobby';   // 'lobby' | 'playing' | 'paused'
let gameState = null;
let tickSeq = 0;           // monotonic tick counter, sent with each gameState
let roomScoreLimit = CLASSIC.scoreLimit;  // admin-overridable, reset on map change
let roomTimeLimit = CLASSIC.timeLimit;    // admin-overridable, reset on map change

// ============================================================
// Lobby helpers
// ============================================================
function getPlayerList() {
  const list = [];
  for (const p of players.values()) {
    list.push({
      id: p.id,
      name: p.name,
      team: p.team, // 'red' | 'blue' | 'spec' (spectator/unassigned)
      isAdmin: p.id === adminId,
    });
  }
  return list;
}

function broadcastLobby() {
  const msg = {
    type: 'lobby',
    players: getPlayerList(),
    adminId,
    freeJoin,
    currentMap: currentMap.name,
    maps: Object.keys(ALL_MAPS).map(k => ALL_MAPS[k].name),
    roomPhase,
    scoreLimit: roomScoreLimit,
    timeLimit: roomTimeLimit,
  };
  broadcast(msg);
}

function assignAdmin() {
  // If no admin, assign first player
  if (adminId && players.has(adminId)) return;
  const first = players.values().next().value;
  adminId = first ? first.id : null;
}

function isAdmin(playerId) {
  return playerId === adminId;
}

function randomizeTeams() {
  const ids = [...players.keys()];
  // Shuffle
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  // Split evenly
  ids.forEach((id, idx) => {
    const p = players.get(id);
    if (p) p.team = idx % 2 === 0 ? 'red' : 'blue';
  });
}

// ============================================================
// Game State
// ============================================================
function resetGame() {
  const map = currentMap;
  const ball = physics.createDisc({
    x: map.ball.x,
    y: map.ball.y,
    radius: map.ball.radius,
    mass: map.ball.mass,
    damping: map.ball.damping,
    bounce: map.ball.bounce,
    color: map.ball.color,
    cGroup: map.ball.cGroup,
    cMask: map.ball.cMask,
    gravityScale: map.ball.gravityScale ?? 0,
  });

  const posts = map.posts.map(p => physics.createDisc({
    x: p.x, y: p.y,
    radius: p.radius,
    bounce: p.bounce,
    color: p.color,
    isStatic: true,
    mass: 999,
    cGroup: p.cGroup ?? C.POST,
    cMask: p.cMask ?? (C.BALL | C.PLAYER),
  }));

  gameState = {
    balls: [ball],
    discs: [],
    posts,
    walls: map.walls,
    score: { red: 0, blue: 0 },
    phase: 'playing', // playing | goal | ended
    timer: roomTimeLimit > 0 ? roomTimeLimit * TICK_RATE : 0,
    goalTimer: 0,
    lastScorer: null,
    // Chaos event system (only if map defines chaosEvents)
    chaos: map.chaosEvents ? {
      active: null,
      timer: map.chaosPauseDuration,  // start with a pause before first event
    } : null,
  };

  repositionPlayers();
}

function repositionPlayers() {
  if (!gameState) return;
  const map = currentMap;
  const redPlayers = [];
  const bluePlayers = [];

  for (const p of players.values()) {
    if (p.team === 'red') redPlayers.push(p);
    else if (p.team === 'blue') bluePlayers.push(p);
    else p.disc = null; // spectators have no disc
  }

  gameState.discs = [];

  const placeTeam = (teamPlayers, side) => {
    const count = teamPlayers.length;
    if (count === 0) return;

    const horizontal = map.spawnLayout === 'horizontal';
    const baseY = map.spawnY ?? 0;

    if (horizontal) {
      // Spread players along X axis, fixed Y
      const halfW = (map.width / 2) * 0.6; // use 60% of half-field width
      const spacing = Math.min(50, halfW * 2 / Math.max(count, 1));
      const xCenter = side * map.spawnDistance;
      const startX = xCenter - (count - 1) * spacing / 2;

      teamPlayers.forEach((p, i) => {
        const disc = physics.createDisc({
          x: startX + i * spacing,
          y: baseY,
          radius: map.player.radius,
          mass: map.player.mass,
          damping: map.player.damping,
          bounce: 0.5,
          color: p.team === 'red' ? '#e74c3c' : '#3498db',
          cGroup: p.team === 'red' ? C.RED : C.BLUE,
          cMask: (p.team === 'red' ? map.player.redCMask : map.player.blueCMask) || map.player.cMask,
        });
        p.disc = disc;
        gameState.discs.push(disc);
      });
    } else {
      // Default: spread players along Y axis, fixed X
      const xBase = side * map.spawnDistance;
      const spacing = Math.min(50, (map.height - 60) / Math.max(count, 1));
      const startY = baseY - (count - 1) * spacing / 2;

      teamPlayers.forEach((p, i) => {
        const disc = physics.createDisc({
          x: xBase,
          y: startY + i * spacing,
          radius: map.player.radius,
          mass: map.player.mass,
          damping: map.player.damping,
          bounce: 0.5,
          color: p.team === 'red' ? '#e74c3c' : '#3498db',
          cGroup: p.team === 'red' ? C.RED : C.BLUE,
          cMask: (p.team === 'red' ? map.player.redCMask : map.player.blueCMask) || map.player.cMask,
        });
        p.disc = disc;
        gameState.discs.push(disc);
      });
    }
  };

  placeTeam(redPlayers, -1);
  placeTeam(bluePlayers, 1);
}

function resetPositionsAfterGoal() {
  const map = currentMap;
  // Remove extra balls, keep only the first one
  gameState.balls.length = 1;
  const ball = gameState.balls[0];
  ball.x = map.ball.x;
  ball.y = map.ball.y;
  ball.vx = 0;
  ball.vy = 0;
  repositionPlayers();
  for (const p of players.values()) {
    if (p.disc) { p.disc.vx = 0; p.disc.vy = 0; }
  }
}

// ============================================================
// Chaos event effects
// ============================================================
function applyChaosEffects(state, map) {
  const ev = state.chaos.active;
  if (ev && ev.id === 'bouncyWalls') {
    // Ball bounce > 1.0 → walls ADD energy to ball on each hit
    for (const ball of state.balls) ball.bounce = 2.0;
  } else {
    // Reset to map default
    for (const ball of state.balls) ball.bounce = map.ball.bounce;
  }

  if (ev && ev.id === 'playerBounce') {
    // Huge bounce on player-player collisions
    for (const disc of state.discs) if (!disc.isStatic) disc.bounce = 2.5;
  } else {
    for (const disc of state.discs) if (!disc.isStatic) disc.bounce = 0.5;
  }
}

// ============================================================
// Game Loop
// ============================================================
function gameTick() {
  if (roomPhase !== 'playing' || !gameState) return;

  const map = currentMap;
  const playerCfg = map.player;
  gameState.kicked = false;

  // Phase: goal scored, brief pause — players can still move & kick, just no new goals
  if (gameState.phase === 'goal') {
    gameState.goalTimer--;
    if (gameState.goalTimer <= 0) {
      if (roomScoreLimit > 0 &&
        (gameState.score.red >= roomScoreLimit || gameState.score.blue >= roomScoreLimit)) {
        // Score limit reached — transition to ended celebration (3s of physics)
        gameState.phase = 'ended';
        gameState.endedTimer = TICK_RATE * 3;
        // Fall through to physics below
      } else {
        gameState.phase = 'playing';
        resetPositionsAfterGoal();
        return; // skip the rest this tick so positions are clean
      }
    }
    // Fall through to input/physics below (but skip goal check at the end)
  }

  // Phase: game ended celebration — players can still move for 3s, then transition to lobby
  if (gameState.phase === 'ended') {
    gameState.endedTimer--;
    if (gameState.endedTimer <= 0) {
      roomPhase = 'lobby';
      broadcastLobby();
      return;
    }
    // Fall through to input/physics below
  }

  // ---- Chaos event system ----
  if (gameState.chaos) {
    const ch = gameState.chaos;
    ch.timer--;
    if (ch.timer <= 0) {
      if (ch.active) {
        // Event ended → start pause
        ch.active = null;
        ch.timer = map.chaosPauseDuration;
      } else {
        // Pause ended → pick random event
        const pool = map.chaosEvents;
        ch.active = pool[Math.floor(Math.random() * pool.length)];
        ch.timer = map.chaosEventDuration;
      }
    }
    // Apply event effects every tick (handles player join/leave cleanly)
    applyChaosEffects(gameState, map);
  }

  // Phase: playing (or goal celebration) - apply inputs
  for (const p of players.values()) {
    if (!p.disc || !p.input) continue;
    physics.applyInput(p.disc, p.input, playerCfg);

    // Admin boost: applied AFTER applyInput so it bypasses the speed cap, decays each tick
    if (p.boostVx || p.boostVy) {
      p.disc.vx += p.boostVx;
      p.disc.vy += p.boostVy;
      p.boostVx *= 0.85;
      p.boostVy *= 0.85;
      if (Math.abs(p.boostVx) < 0.1 && Math.abs(p.boostVy) < 0.1) {
        p.boostVx = 0;
        p.boostVy = 0;
      }
    }

    const now = Date.now();
    if (p.input.kick && (now - p.lastKickTime) >= playerCfg.kickCooldown) {
      for (const ball of gameState.balls) {
        if (physics.tryKick(p.disc, ball, playerCfg)) {
          p.lastKickTime = now;
          gameState.kicked = true;
        }
      }
    }
  }

  physics.stepPhysics(gameState, map);

  // Only check goals during normal play (not during goal celebration)
  if (gameState.phase === 'playing') {
    let scorer = null;
    for (const ball of gameState.balls) {
      scorer = physics.checkGoals(ball, map.goals);
      if (scorer) break;
    }
    if (scorer) {
      gameState.score[scorer]++;
      gameState.phase = 'goal';
      gameState.goalTimer = TICK_RATE * 2;
      gameState.lastScorer = scorer;
    }
  }

  if (gameState.phase === 'playing' && gameState.timer > 0) {
    gameState.timer--;
    if (gameState.timer <= 0) {
      // Time's up — transition to ended celebration (3s of physics)
      gameState.phase = 'ended';
      gameState.endedTimer = TICK_RATE * 3;
    }
  }
}

// ============================================================
// WebSocket
// ============================================================
const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [, player] of players) {
    if (player.ws.readyState === 1) player.ws.send(data);
  }
}

function sendGameState() {
  if (!gameState || (roomPhase !== 'playing' && roomPhase !== 'paused')) return;

  const playerList = [];
  for (const p of players.values()) {
    playerList.push({
      id: p.id,
      name: p.name,
      team: p.team,
      isAdmin: p.id === adminId,
      kicking: !!(p.input && p.input.kick),
      disc: p.disc ? {
        x: p.disc.x, y: p.disc.y,
        vx: p.disc.vx, vy: p.disc.vy,
        radius: p.disc.radius,
        color: p.disc.color,
      } : null,
    });
  }

  broadcast({
    type: 'gameState',
    seq: tickSeq,
    balls: gameState.balls.map(b => ({
      x: b.x, y: b.y, vx: b.vx, vy: b.vy,
      radius: b.radius, color: b.color,
    })),
    players: playerList,
    score: gameState.score,
    phase: gameState.phase,
    timer: gameState.timer,
    kicked: gameState.kicked || false,
    lastScorer: gameState.lastScorer,
    map: currentMap.name,
    mapInfo: {
      w: currentMap.width,
      h: currentMap.height,
      bg: currentMap.bg,
      goals: currentMap.goals,
      visual: currentMap.visual,
      posts: currentMap.posts.map(p => ({ x: p.x, y: p.y, radius: p.radius, color: p.color })),
      walls: currentMap.walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, cGroup: w.cGroup })),
      kickRadius: currentMap.player.kickRadius,
    },
    chaos: gameState.chaos ? {
      active: gameState.chaos.active,   // null or { id, name, desc }
      timer: gameState.chaos.timer,     // ticks remaining
    } : null,
  });
}

// ---- Message handlers ----

function handleJoin(ws, data) {
  const id = nextPlayerId++;
  const name = (data.name || 'Player').substring(0, 16);

  const player = {
    id, name,
    team: 'spec', // start as spectator in lobby
    ws,
    disc: null,
    input: { up: false, down: false, left: false, right: false, kick: false },
    lastKickTime: 0,
  };
  players.set(id, player);

  // Assign admin if first player
  assignAdmin();

  // Send welcome
  ws.send(JSON.stringify({
    type: 'welcome',
    id, name,
    team: player.team,
    isAdmin: id === adminId,
  }));

  console.log(`[+] ${name} joined (${players.size} players)${id === adminId ? ' [ADMIN]' : ''}`);

  // If we're in lobby, broadcast lobby state
  // If game is in progress, put them in spec and broadcast
  broadcastLobby();
  if (roomPhase === 'playing') {
    repositionPlayers();
  }

  return id;
}

function handleSelfTeam(playerId, data) {
  const player = players.get(playerId);
  if (!player) return;
  if (!freeJoin && !isAdmin(playerId)) return; // locked
  const team = data.team;
  if (team !== 'red' && team !== 'blue' && team !== 'spec') return;
  player.team = team;

  if (roomPhase === 'playing') {
    repositionPlayers();
  }
  broadcastLobby();
}

function handleAdminMovePlayer(playerId, data) {
  if (!isAdmin(playerId)) return;
  const target = players.get(data.targetId);
  if (!target) return;
  const team = data.team;
  if (team !== 'red' && team !== 'blue' && team !== 'spec') return;
  target.team = team;

  if (roomPhase === 'playing') {
    repositionPlayers();
  }
  broadcastLobby();
}

function handleAdminRandomize(playerId) {
  if (!isAdmin(playerId)) return;
  randomizeTeams();
  broadcastLobby();
}

function handleAdminToggleFreeJoin(playerId) {
  if (!isAdmin(playerId)) return;
  freeJoin = !freeJoin;
  broadcastLobby();
}

function handleAdminTransfer(playerId, data) {
  if (!isAdmin(playerId)) return;
  const target = players.get(data.targetId);
  if (!target) return;
  adminId = target.id;
  console.log(`[*] Admin transferred to ${target.name}`);
  broadcastLobby();
}

function handleStartGame(playerId) {
  if (!isAdmin(playerId)) return;
  if (roomPhase !== 'lobby') return;
  // Allow starting with any team composition (even 1 person in 1 team for testing)
  let hasAnyTeamPlayer = false;
  for (const p of players.values()) {
    if (p.team === 'red' || p.team === 'blue') { hasAnyTeamPlayer = true; break; }
  }
  if (!hasAnyTeamPlayer) return; // need at least 1 player in a team

  roomPhase = 'playing';
  tickSeq = 0;
  resetGame();
  broadcastLobby();
  broadcast({ type: 'gameStarted', map: currentMap.name });
  console.log(`[*] Game started on ${currentMap.name}`);
}

function handlePauseGame(playerId) {
  if (!isAdmin(playerId)) return;
  if (roomPhase !== 'playing') return;
  roomPhase = 'paused';
  broadcast({ type: 'gamePaused' });
  broadcastLobby();
  console.log('[*] Game paused');
}

function handleResumeGame(playerId) {
  if (!isAdmin(playerId)) return;
  if (roomPhase !== 'paused') return;
  roomPhase = 'playing';
  broadcast({ type: 'gameResumed' });
  broadcastLobby();
  console.log('[*] Game resumed');
}

function handleStopGame(playerId) {
  if (!isAdmin(playerId)) return;
  roomPhase = 'lobby';
  gameState = null;
  broadcast({ type: 'gameStopped' });
  broadcastLobby();
  console.log('[*] Game stopped, back to lobby');
}

function handleChangeMap(playerId, data) {
  if (!isAdmin(playerId)) return;
  const mapKey = Object.keys(ALL_MAPS).find(
    k => ALL_MAPS[k].name === data.map || k === data.map
  );
  if (!mapKey) return;
  currentMap = ALL_MAPS[mapKey];
  // Reset overrides to new map's defaults
  roomScoreLimit = currentMap.scoreLimit;
  roomTimeLimit = currentMap.timeLimit;
  if (roomPhase === 'playing' || roomPhase === 'paused') {
    roomPhase = 'lobby';
    gameState = null;
    broadcast({ type: 'gameStopped' });
  }
  broadcastLobby();
  broadcast({ type: 'mapChanged', map: currentMap.name });
  console.log(`[*] Map changed to ${currentMap.name}`);
}

function handleChangeScoreLimit(playerId, data) {
  if (!isAdmin(playerId)) return;
  const val = parseInt(data.value, 10);
  if (isNaN(val) || val < 0 || val > 99) return;
  roomScoreLimit = val;
  broadcastLobby();
}

function handleChangeTimeLimit(playerId, data) {
  if (!isAdmin(playerId)) return;
  const val = parseInt(data.value, 10);
  if (isNaN(val) || val < 0 || val > 999) return;
  roomTimeLimit = val;
  broadcastLobby();
}

function handleRestart(playerId) {
  if (!isAdmin(playerId)) return;
  if (roomPhase !== 'playing') return;
  resetGame();
  broadcast({ type: 'restart' });
  console.log('[*] Game restarted');
}

function handleInput(playerId, data) {
  if (roomPhase !== 'playing') return;
  const player = players.get(playerId);
  if (!player) return;
  player.input = {
    up: !!data.up,
    down: !!data.down,
    left: !!data.left,
    right: !!data.right,
    kick: !!data.kick,
  };
}

function handleCheat(playerId, data) {
  if (!isAdmin(playerId)) return;
  if (roomPhase !== 'playing' || !gameState) return;
  const player = players.get(playerId);
  if (!player || !player.disc) return;

  const map = currentMap;

  if (data.cheat === 'extraBall') {
    // Spawn an extra ball near the admin player
    const ball = physics.createDisc({
      x: player.disc.x + (Math.random() - 0.5) * 30,
      y: player.disc.y + (Math.random() - 0.5) * 30,
      radius: map.ball.radius,
      mass: map.ball.mass,
      damping: map.ball.damping,
      bounce: map.ball.bounce,
      color: map.ball.color,
      cGroup: map.ball.cGroup,
      cMask: map.ball.cMask,
      gravityScale: map.ball.gravityScale ?? 0,
    });
    gameState.balls.push(ball);
    console.log(`[CHEAT] ${player.name} spawned extra ball`);
  }

  if (data.cheat === 'boost') {
    // Boost admin in their current movement direction (decays over ~15 ticks)
    const d = player.disc;
    const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
    if (speed > 0.1) {
      const nx = d.vx / speed;
      const ny = d.vy / speed;
      player.boostVx = nx * 12;
      player.boostVy = ny * 12;
    }
    console.log(`[CHEAT] ${player.name} boosted`);
  }
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case 'join':           playerId = handleJoin(ws, data); break;
      case 'ping':           ws.send(JSON.stringify({ type: 'pong', t: data.t })); break;
      case 'input':          handleInput(playerId, data); break;
      case 'cheat':          if (playerId) handleCheat(playerId, data); break;
      case 'selfTeam':       if (playerId) handleSelfTeam(playerId, data); break;
      case 'adminMove':      if (playerId) handleAdminMovePlayer(playerId, data); break;
      case 'adminRandomize': if (playerId) handleAdminRandomize(playerId); break;
      case 'adminToggleFJ':  if (playerId) handleAdminToggleFreeJoin(playerId); break;
      case 'adminTransfer':  if (playerId) handleAdminTransfer(playerId, data); break;
      case 'startGame':      if (playerId) handleStartGame(playerId); break;
      case 'pauseGame':      if (playerId) handlePauseGame(playerId); break;
      case 'resumeGame':     if (playerId) handleResumeGame(playerId); break;
      case 'stopGame':       if (playerId) handleStopGame(playerId); break;
      case 'changeMap':      if (playerId) handleChangeMap(playerId, data); break;
      case 'changeScoreLimit': if (playerId) handleChangeScoreLimit(playerId, data); break;
      case 'changeTimeLimit':  if (playerId) handleChangeTimeLimit(playerId, data); break;
      case 'restart':        if (playerId) handleRestart(playerId); break;
    }
  });

  ws.on('close', () => {
    if (playerId) {
      const player = players.get(playerId);
      const name = player ? player.name : '?';
      players.delete(playerId);

      // Reassign admin
      if (playerId === adminId) {
        adminId = null;
        assignAdmin();
        if (adminId) {
          const newAdmin = players.get(adminId);
          console.log(`[*] Admin auto-assigned to ${newAdmin.name}`);
        }
      }

      if (roomPhase === 'playing' && gameState) {
        repositionPlayers();
      }

      broadcastLobby();
      console.log(`[-] ${name} left (${players.size} players)`);
    }
  });
});

// ============================================================
// Start
// ============================================================
setInterval(() => {
  gameTick();
  tickSeq++;
  sendGameState();
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`HussBall server running on http://localhost:${PORT}`);
});
