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
const { MODIFIERS, MODIFIERS_BY_ID } = require('./shared/modifiers');

// ============================================================
// Config
// ============================================================
const PORT = process.env.PORT || 3000;
// Off by default so a normal deploy never broadcasts host CPU load to every
// client — only set this on throwaway boxes (e.g. warsaw-server.sh) where
// there's no private VPS info to leak.
const SHOW_CPU_STAT = process.env.SHOW_CPU_STAT === '1';
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const MOD_DURATION_TICKS = 20 * TICK_RATE;  // how long a modifier stays active
const MOD_PAUSE_TICKS = 5 * TICK_RATE;      // quiet period between modifiers

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
// Relative pick weight per modifier id for the current map — the modifier
// loop draws from these (weight 0 = never picked), not a plain on/off toggle,
// so the admin can make some modifiers rarer/commoner instead of just
// enabled/disabled. Reset to "3 for everything available" on map change.
const DEFAULT_MODIFIER_WEIGHT = 3;
function defaultModifierWeights(map) {
  return Object.fromEntries((map.modifiers || []).map(id => [id, DEFAULT_MODIFIER_WEIGHT]));
}
let roomModifierWeights = defaultModifierWeights(CLASSIC);

// Measures the actual setInterval firing rate (Hz) — if the Node event loop
// falls behind (GC pauses, CPU contention), this drops below TICK_RATE and
// movement/physics slow down in real time even though velocities are unchanged.
let measuredTickRate = TICK_RATE;
let tickRateWindowStart = Date.now();
let tickRateWindowCount = 0;

// Opt-in only (SHOW_CPU_STAT=1) — process CPU time used since the last perf
// window, normalized to one core (spikes over 100% would mean >1 core busy).
let measuredCpuPercent = 0;
let lastCpuUsage = SHOW_CPU_STAT ? process.cpuUsage() : null;

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
      goals: p.goals || 0,
      assists: p.assists || 0,
      ownGoals: p.ownGoals || 0,
      ping: p.ping || 0,
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
    availableModifiers: (currentMap.modifiers || []).map(id => {
      const m = MODIFIERS_BY_ID[id];
      return { id, name: m.name, desc: m.desc, icon: m.icon };
    }),
    modifierWeights: { ...roomModifierWeights },
  };
  broadcast(msg);
}

function broadcastChatSystem(text) {
  broadcast({ type: 'chat', system: true, text });
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

function randomizeTeams(includeSpectators) {
  const ids = includeSpectators
    ? [...players.keys()]
    : [...players.keys()].filter(id => players.get(id).team !== 'spec');
  // Shuffle
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  // Split evenly, coin-flipping which team gets the "first" slot each time —
  // otherwise index 0 always lands on red, so a lone player (or anyone who
  // happens to shuffle into slot 0) never actually had a chance at blue.
  const evenSlotIsRed = Math.random() < 0.5;
  ids.forEach((id, idx) => {
    const p = players.get(id);
    if (!p) return;
    const evenSlot = idx % 2 === 0;
    p.team = (evenSlot === evenSlotIsRed) ? 'red' : 'blue';
  });
}

// ============================================================
// Game State
// ============================================================
// Builds static goalpost/obstacle physics objects from plain specs — a
// circle ({x,y,radius,bounce,color,cGroup,cMask}), a rounded rectangle
// (spec.shape 'rect': {x,y,w,h,cornerRadius,...}), or a convex polygon
// (spec.shape 'poly': {x,y,points,cornerRadius,...}). Used both for the
// map's own posts and for modifier-contributed obstacles (e.g. bumpers).
function buildPostDiscs(specs) {
  return specs.map(p => {
    const obj = (p.shape === 'rect')
      ? physics.createRectObstacle({
          x: p.x, y: p.y, w: p.w, h: p.h, cornerRadius: p.cornerRadius,
          bounce: p.bounce, color: p.color,
          cGroup: p.cGroup, cMask: p.cMask,
        })
      : (p.shape === 'poly')
      ? physics.createPolygonObstacle({
          x: p.x, y: p.y, points: p.points, cornerRadius: p.cornerRadius,
          bounce: p.bounce, color: p.color,
          cGroup: p.cGroup, cMask: p.cMask,
        })
      : physics.createDisc({
          x: p.x, y: p.y,
          radius: p.radius,
          bounce: p.bounce,
          color: p.color,
          isStatic: true,
          mass: 999,
          cGroup: p.cGroup ?? C.POST,
          cMask: p.cMask ?? (C.BALL | C.PLAYER),
        });
    obj.isBumper = !!p.isBumper; // tags obstacle objects so the client can flash them on impact
    obj.isKicker = !!p.isKicker; // tags "kicker" obstacles that actively kick the ball on contact
    return obj;
  });
}

// Recomputes the effective walls/goals/posts/bg/visual from the map's base
// geometry plus whatever the currently active modifier has declared in
// gameState.modifierExtras. Only one modifier is active at a time, so each
// modifier's activate() can just declare full replacement arrays (derived
// from gameState.baseWalls/basePostSpecs/baseGoals) rather than needing to
// merge with anyone else's contribution. Called on resetGame() and on every
// modifier activate/deactivate transition — never every tick.
function rebuildGeometry() {
  if (!gameState) return;
  const extras = gameState.modifierExtras || {};
  gameState.walls = extras.walls || gameState.baseWalls;
  gameState.goals = extras.goals || gameState.baseGoals;
  gameState.posts = buildPostDiscs(extras.postSpecs || gameState.basePostSpecs);
  gameState.bg = extras.bg || gameState.baseBg;
  const baseVisual = gameState.baseVisual || {};
  const goalNetLines = (extras.visual && extras.visual.goalNetLines) || baseVisual.goalNetLines || [];
  gameState.visual = {
    ...baseVisual,
    lines: [...(baseVisual.lines || []), ...goalNetLines],
  };
}

function resetGame() {
  const map = currentMap;
  for (const p of players.values()) { p.goals = 0; p.assists = 0; p.ownGoals = 0; }
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
    maxFallSpeed: map.ball.maxFallSpeed ?? null,
  });

  gameState = {
    balls: [ball],
    discs: [],
    score: { red: 0, blue: 0 },
    phase: 'playing', // playing | goal | ended
    timer: roomTimeLimit > 0 ? roomTimeLimit * TICK_RATE : 0,
    goalTimer: 0,
    lastScorer: null,
    goalInfo: null,
    // Base (map-default) geometry — never mutated, modifiers derive from these.
    baseWalls: map.walls,
    baseGoals: map.goals,
    basePostSpecs: map.posts,
    baseBg: map.bg,
    baseVisual: map.visual,
    // Active modifier's geometry contribution (if any); consumed by rebuildGeometry().
    modifierExtras: {},
    // Modifier system (only if map declares an available pool)
    modifier: (map.modifiers && map.modifiers.length) ? {
      active: null,
      timer: MOD_PAUSE_TICKS,  // start with a pause before the first modifier
    } : null,
  };

  rebuildGeometry();
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
          bounce: 0.5,
          color: p.team === 'red' ? '#e74c3c' : '#3498db',
          cGroup: p.team === 'red' ? C.RED : C.BLUE,
          cMask: (p.team === 'red' ? map.player.redCMask : map.player.blueCMask) || map.player.cMask,
        });
        disc.ownerId = p.id;
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
          bounce: 0.5,
          color: p.team === 'red' ? '#e74c3c' : '#3498db',
          cGroup: p.team === 'red' ? C.RED : C.BLUE,
          cMask: (p.team === 'red' ? map.player.redCMask : map.player.blueCMask) || map.player.cMask,
        });
        disc.ownerId = p.id;
        p.disc = disc;
        gameState.discs.push(disc);
      });
    }
  };

  placeTeam(redPlayers, -1);
  placeTeam(bluePlayers, 1);
}

// ---- Single-player spawn/remove (used mid-game so joins/leaves/team-swaps
// don't reposition anyone else — only resetGame()/resetPositionsAfterGoal()
// and an explicit admin randomize are allowed to reposition everybody) ----
function spawnDiscForPlayer(p) {
  const map = currentMap;
  const cfg = map.player;
  const teammates = [...players.values()].filter(pl => pl.team === p.team && pl.disc);
  const side = p.team === 'red' ? -1 : 1;
  const horizontal = map.spawnLayout === 'horizontal';
  const baseY = map.spawnY ?? 0;
  let x, y;

  if (horizontal) {
    const halfW = (map.width / 2) * 0.6;
    const spacing = Math.min(50, halfW * 2 / Math.max(teammates.length + 1, 1));
    x = side * map.spawnDistance + (Math.random() - 0.5) * spacing;
    y = baseY;
  } else {
    const spacing = Math.min(50, (map.height - 60) / Math.max(teammates.length + 1, 1));
    x = side * map.spawnDistance;
    y = baseY + (Math.random() - 0.5) * spacing * (teammates.length + 1);
  }

  const disc = physics.createDisc({
    x, y,
    radius: cfg.radius,
    mass: cfg.mass,
    bounce: 0.5,
    color: p.team === 'red' ? '#e74c3c' : '#3498db',
    cGroup: p.team === 'red' ? C.RED : C.BLUE,
    cMask: (p.team === 'red' ? cfg.redCMask : cfg.blueCMask) || cfg.cMask,
  });
  disc.ownerId = p.id;
  p.disc = disc;
  gameState.discs.push(disc);
}

function removeDiscForPlayer(p) {
  if (!p.disc || !gameState) return;
  const idx = gameState.discs.indexOf(p.disc);
  if (idx !== -1) gameState.discs.splice(idx, 1);
  p.disc = null;
}

// Handles a team change (or leaving to spec) for one player mid-game, without
// touching any other player's disc/position.
function assignPlayerToTeamLive(p, newTeam) {
  removeDiscForPlayer(p);
  p.team = newTeam;
  if (newTeam === 'red' || newTeam === 'blue') spawnDiscForPlayer(p);
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
  ball.touches = [];
  gameState.goalInfo = null;
  repositionPlayers();
  for (const p of players.values()) {
    if (p.disc) { p.disc.vx = 0; p.disc.vy = 0; }
  }
}

// ============================================================
// Modifier system — weighted-random-picks a modifier from shared/modifiers.js,
// runs it for MOD_DURATION_TICKS, then pauses MOD_PAUSE_TICKS before the next.
// ============================================================
// Weighted random pick over the map's modifier pool. Higher roomModifierWeights
// entries come up more often; weight 0 (or missing) means "never picked" —
// returns null only when every eligible modifier is at weight 0.
function pickWeightedModifier(map) {
  const entries = (map.modifiers || [])
    .map(id => ({ weight: roomModifierWeights[id] ?? 0, mod: MODIFIERS_BY_ID[id] }))
    .filter(e => e.mod && e.weight > 0);
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) return null;
  let r = Math.random() * totalWeight;
  for (const e of entries) {
    r -= e.weight;
    if (r < 0) return e.mod;
  }
  return entries[entries.length - 1].mod; // floating-point rounding fallback
}

// Ends whatever modifier is active (if any) and immediately activates a new
// weighted-random pick, skipping the pause — shared by the natural
// end-of-pause transition and the admin "skip to next modifier" cheat.
function endActiveAndStartNext(state, map) {
  const m = state.modifier;
  if (!m) return;
  if (m.active) {
    if (m.active.deactivate) m.active.deactivate(state, map);
    m.active = null;
    rebuildGeometry();
  }
  const chosen = pickWeightedModifier(map);
  if (chosen) {
    m.active = chosen;
    if (chosen.activate) chosen.activate(state, map);
    rebuildGeometry();
    m.timer = MOD_DURATION_TICKS;
  } else {
    m.timer = MOD_PAUSE_TICKS; // every weight is 0 — stay idle, check again later
  }
}

function runModifierStep(state, map) {
  const m = state.modifier;
  if (!m) return;
  m.timer--;
  if (m.timer <= 0) {
    if (m.active) {
      if (m.active.deactivate) m.active.deactivate(state, map);
      m.active = null;
      rebuildGeometry();
      m.timer = MOD_PAUSE_TICKS;
    } else {
      endActiveAndStartNext(state, map);
    }
  }
  if (m.active && m.active.tick) m.active.tick(state, map);
}

// ============================================================
// Goal / assist attribution
// ============================================================
const ASSIST_WINDOW_MS = 8000; // how far back a prior touch can still count as an assist
const TOUCH_DEDUPE_MS = 250;   // ignore repeat passive-touch spam from the same player/tick

function recordTouch(ball, player, kind) {
  if (!ball.touches) ball.touches = [];
  const touches = ball.touches;
  const last = touches[touches.length - 1];
  const now = Date.now();
  if (last && last.playerId === player.id && last.kind === kind && (now - last.time) < TOUCH_DEDUPE_MS) return;
  touches.push({ playerId: player.id, name: player.name, team: player.team, kind, time: now });
  if (touches.length > 8) touches.shift();
}

// Who gets credit for a goal, based on the scoring ball's touch history.
// Walking/dribbling the ball in via plain body contact counts as a real goal,
// same as an active kick. Own goal only applies when the scoring team never
// touched the ball at all — otherwise we anchor on the scoring team's own
// last touch: if it was a passive deflection off a teammate's more recent
// shot, the shooter keeps the goal and the deflector gets a real assist; if
// an opponent's touch happens to land AFTER the scoring team's decisive
// touch (didn't change the outcome), it's a funny footnote, never a real
// stat or an own goal.
function attributeGoal(ball, scoringTeam) {
  const touches = ball.touches || [];
  if (touches.length === 0) {
    return { scorer: null, ownGoal: null, assist: null, funnyAssist: null };
  }

  let finalIdx = -1;
  for (let i = touches.length - 1; i >= 0; i--) {
    if (touches[i].team === scoringTeam) { finalIdx = i; break; }
  }

  if (finalIdx === -1) {
    // The scoring team never touched this ball — entirely the conceding
    // team's doing, credited to whoever touched it last.
    return { scorer: null, ownGoal: touches[touches.length - 1], assist: null, funnyAssist: null };
  }

  const scoringTouch = touches[finalIdx];
  let scorer = scoringTouch;
  let deflector = null;
  let funnyAssist = finalIdx < touches.length - 1 ? touches[touches.length - 1] : null;

  if (scoringTouch.kind === 'touch') {
    // See if this passive touch deflected a more recent teammate's shot.
    for (let i = finalIdx - 1; i >= 0; i--) {
      const t = touches[i];
      if (t.kind === 'kick') {
        if (t.team === scoringTeam && t.playerId !== scoringTouch.playerId) {
          scorer = t;
          deflector = scoringTouch;
        }
        break;
      }
    }
  }

  let assist = deflector;
  if (!assist) {
    for (let i = touches.indexOf(scorer) - 1; i >= 0; i--) {
      const t = touches[i];
      if (t.team !== scoringTeam) break; // possession chain broken by an opponent touch
      if (t.playerId !== scorer.playerId && (scorer.time - t.time) < ASSIST_WINDOW_MS) {
        assist = t;
        break;
      }
    }
  }

  return { scorer, ownGoal: null, assist, funnyAssist };
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

  // ---- Modifier system ----
  runModifierStep(gameState, map);

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
          recordTouch(ball, p, 'kick');
        }
      }
    }
  }

  physics.stepPhysics(gameState, map);

  // Passive ball-vs-player contacts detected during physics resolution — feed
  // them into the same touch history used for goal/assist attribution. Also
  // apply an active kick impulse for "kicker" bumper obstacles (dark green,
  // Bumpers modifier) — they don't have an ownerId so they never earn touch
  // credit, they just shove the ball like a player's kick would.
  const kickedPairs = new Set();
  for (const hit of gameState.ballHits) {
    const owner = hit.disc.ownerId != null ? players.get(hit.disc.ownerId) : null;
    if (owner) recordTouch(hit.ball, owner, 'touch');

    if (hit.disc.isKicker) {
      // Dedupe per (ball, kicker) per tick — a slow graze can register a hit
      // on more than one substep within the same tick, and without this a
      // single contact could apply the kick force multiple times over.
      const key = gameState.balls.indexOf(hit.ball) + ':' + gameState.posts.indexOf(hit.disc);
      if (!kickedPairs.has(key)) {
        kickedPairs.add(key);
        const n = physics.normalize(hit.ball.x - hit.disc.x, hit.ball.y - hit.disc.y);
        hit.ball.vx += n.x * map.player.kickForce;
        hit.ball.vy += n.y * map.player.kickForce;
        gameState.kicked = true;
      }
    }
  }

  // Only check goals during normal play (not during goal celebration)
  if (gameState.phase === 'playing') {
    let scorer = null;
    let scoringBall = null;
    for (const ball of gameState.balls) {
      scorer = physics.checkGoals(ball, gameState.goals);
      if (scorer) { scoringBall = ball; break; }
    }
    if (scorer) {
      const activeMod = gameState.modifier && gameState.modifier.active;
      if (activeMod && activeMod.transformScorer) scorer = activeMod.transformScorer(gameState, scorer);
      gameState.score[scorer]++;
      gameState.phase = 'goal';
      gameState.goalTimer = TICK_RATE * 2;
      gameState.lastScorer = scorer;

      const credit = attributeGoal(scoringBall, scorer);
      gameState.goalInfo = credit;
      scoringBall.touches = [];

      if (credit.scorer) {
        const p = players.get(credit.scorer.playerId);
        if (p) p.goals++;
      } else if (credit.ownGoal) {
        const p = players.get(credit.ownGoal.playerId);
        if (p) p.ownGoals++;
      }
      if (credit.assist) {
        const p = players.get(credit.assist.playerId);
        if (p) p.assists++;
      }
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

  const hitBumpers = new Set(
    (gameState.ballHits || []).filter(h => h.disc.isBumper).map(h => h.disc)
  );

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
    goalInfo: gameState.goalInfo || null,
    tickRate: Math.round(measuredTickRate * 10) / 10,
    cpu: SHOW_CPU_STAT ? Math.round(measuredCpuPercent * 10) / 10 : undefined,
    map: currentMap.name,
    mapInfo: {
      w: currentMap.width,
      h: currentMap.height,
      bg: gameState.bg,
      goals: gameState.goals,
      visual: gameState.visual,
      posts: gameState.posts.map(p => p.isRect ? {
        shape: 'rect',
        x: p.x, y: p.y, w: p.halfW * 2, h: p.halfH * 2, cornerRadius: p.cornerRadius,
        color: p.color,
        flash: hitBumpers.has(p),
      } : p.isPoly ? {
        shape: 'poly',
        points: p.worldPoints, cornerRadius: p.cornerRadius,
        color: p.color,
        flash: hitBumpers.has(p),
      } : {
        shape: 'circle',
        x: p.x, y: p.y, radius: p.radius, color: p.color,
        flash: hitBumpers.has(p),
      }),
      walls: gameState.walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, cGroup: w.cGroup })),
      kickRadius: currentMap.player.kickRadius,
    },
    modifier: gameState.modifier ? {
      active: gameState.modifier.active ? {
        id: gameState.modifier.active.id,
        name: gameState.modifier.active.name,
        desc: gameState.modifier.active.desc,
      } : null,
      timer: gameState.modifier.timer,   // ticks remaining
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
    goals: 0,
    assists: 0,
    ownGoals: 0,
    ping: 0,
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
  broadcastChatSystem(`${name} joined`);

  // New players always start as spectators — joining the lobby never
  // touches gameplay, so no repositioning happens here.
  broadcastLobby();

  return id;
}

function handleSelfTeam(playerId, data) {
  const player = players.get(playerId);
  if (!player) return;
  if (!freeJoin && !isAdmin(playerId)) return; // locked
  const team = data.team;
  if (team !== 'red' && team !== 'blue' && team !== 'spec') return;

  if (roomPhase === 'playing' && gameState) {
    assignPlayerToTeamLive(player, team);
  } else {
    player.team = team;
  }
  broadcastLobby();
}

function handleAdminMovePlayer(playerId, data) {
  if (!isAdmin(playerId)) return;
  const target = players.get(data.targetId);
  if (!target) return;
  const team = data.team;
  if (team !== 'red' && team !== 'blue' && team !== 'spec') return;

  if (roomPhase === 'playing' && gameState) {
    assignPlayerToTeamLive(target, team);
  } else {
    target.team = team;
  }
  broadcastLobby();
}

function handleAdminRandomize(playerId, data) {
  if (!isAdmin(playerId)) return;
  randomizeTeams(!!(data && data.includeSpectators));
  // Randomize reassigns everyone's team at once — repositioning the whole
  // field here is the intended, admin-initiated exception to the
  // "don't teleport everyone" rule.
  if (roomPhase === 'playing' && gameState) {
    repositionPlayers();
  }
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
  roomModifierWeights = defaultModifierWeights(currentMap);
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
  if (isNaN(val) || val < 0 || val > 1800) return;
  roomTimeLimit = val;
  broadcastLobby();
}

function handleSetModifierWeight(playerId, data) {
  if (!isAdmin(playerId)) return;
  const id = data.id;
  if (!MODIFIERS_BY_ID[id] || !(currentMap.modifiers || []).includes(id)) return;
  const weight = Number(data.weight);
  if (!Number.isFinite(weight)) return;
  roomModifierWeights[id] = Math.max(0, Math.min(99, Math.round(weight)));
  broadcastLobby();
}

function handlePing(playerId, data) {
  const player = players.get(playerId);
  if (!player) return;
  if (typeof data.lastPing === 'number' && isFinite(data.lastPing)) {
    player.ping = Math.max(0, Math.min(9999, Math.round(data.lastPing)));
    // Deliberately NOT broadcastLobby() here — this fires ~once/sec per player,
    // and a full lobby rebuild closes any open <select> (e.g. the map picker)
    // since the browser drops a native dropdown's open state when its DOM node
    // is replaced. Ping is cosmetic, so it gets its own tiny targeted message
    // instead of forcing a structural admin-bar re-render.
    broadcast({ type: 'pingUpdate', id: playerId, ping: player.ping });
  }
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

const CHAT_COOLDOWN_MS = 300;

function handleChat(playerId, data) {
  const player = players.get(playerId);
  if (!player) return;
  const text = String(data.text || '').trim().substring(0, 200);
  if (!text) return;
  const now = Date.now();
  if (player.lastChatTime && (now - player.lastChatTime) < CHAT_COOLDOWN_MS) return;
  player.lastChatTime = now;
  broadcast({
    type: 'chat',
    id: player.id,
    name: player.name,
    team: player.team,
    text,
  });
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
      maxFallSpeed: map.ball.maxFallSpeed ?? null,
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

  if (data.cheat === 'skipModifier') {
    // Ends the current modifier (if any) and immediately starts the next
    // enabled one, skipping the pause — only meaningful on a map that has a
    // modifier pool at all.
    if (gameState.modifier) {
      endActiveAndStartNext(gameState, map);
      console.log(`[CHEAT] ${player.name} skipped to next modifier`);
    }
  }
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case 'join':           playerId = handleJoin(ws, data); break;
      case 'ping':           if (playerId) handlePing(playerId, data); ws.send(JSON.stringify({ type: 'pong', t: data.t })); break;
      case 'input':          handleInput(playerId, data); break;
      case 'chat':           if (playerId) handleChat(playerId, data); break;
      case 'cheat':          if (playerId) handleCheat(playerId, data); break;
      case 'selfTeam':       if (playerId) handleSelfTeam(playerId, data); break;
      case 'adminMove':      if (playerId) handleAdminMovePlayer(playerId, data); break;
      case 'adminRandomize': if (playerId) handleAdminRandomize(playerId, data); break;
      case 'adminToggleFJ':  if (playerId) handleAdminToggleFreeJoin(playerId); break;
      case 'adminTransfer':  if (playerId) handleAdminTransfer(playerId, data); break;
      case 'startGame':      if (playerId) handleStartGame(playerId); break;
      case 'pauseGame':      if (playerId) handlePauseGame(playerId); break;
      case 'resumeGame':     if (playerId) handleResumeGame(playerId); break;
      case 'stopGame':       if (playerId) handleStopGame(playerId); break;
      case 'changeMap':      if (playerId) handleChangeMap(playerId, data); break;
      case 'changeScoreLimit': if (playerId) handleChangeScoreLimit(playerId, data); break;
      case 'changeTimeLimit':  if (playerId) handleChangeTimeLimit(playerId, data); break;
      case 'setModifierWeight': if (playerId) handleSetModifierWeight(playerId, data); break;
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

      if (player && roomPhase === 'playing' && gameState) {
        removeDiscForPlayer(player);
      }

      broadcastLobby();
      broadcastChatSystem(`${name} left`);
      console.log(`[-] ${name} left (${players.size} players)`);
    }
  });
});

// ============================================================
// Start
// ============================================================
// ---- Perf instrumentation: find out where tick time actually goes ----
let perfTickSum = 0, perfTickMax = 0;
let perfSendSum = 0, perfSendMax = 0;
const SLOW_TICK_MS = 30; // log immediately if a single iteration blows past this

function runTick() {
  const t0 = process.hrtime.bigint();
  gameTick();
  const t1 = process.hrtime.bigint();
  sendGameState();
  const t2 = process.hrtime.bigint();

  const tickMs = Number(t1 - t0) / 1e6;
  const sendMs = Number(t2 - t1) / 1e6;
  perfTickSum += tickMs; if (tickMs > perfTickMax) perfTickMax = tickMs;
  perfSendSum += sendMs; if (sendMs > perfSendMax) perfSendMax = sendMs;
  if (tickMs + sendMs > SLOW_TICK_MS) {
    console.log(`[perf] SLOW TICK: total=${(tickMs + sendMs).toFixed(1)}ms gameTick=${tickMs.toFixed(1)}ms sendGameState=${sendMs.toFixed(1)}ms`);
  }

  tickSeq++;
  tickRateWindowCount++;
  const now = Date.now();
  const windowElapsed = now - tickRateWindowStart;
  if (windowElapsed >= 1000) {
    measuredTickRate = tickRateWindowCount * 1000 / windowElapsed;
    let cpuLog = '';
    if (SHOW_CPU_STAT) {
      const cpuDiff = process.cpuUsage(lastCpuUsage);
      lastCpuUsage = process.cpuUsage();
      measuredCpuPercent = (cpuDiff.user + cpuDiff.system) / 1000 / windowElapsed * 100;
      cpuLog = ` | cpu=${measuredCpuPercent.toFixed(1)}%`;
    }
    console.log(
      `[perf] ${measuredTickRate.toFixed(1)} ticks/s | gameTick avg=${(perfTickSum / tickRateWindowCount).toFixed(2)}ms max=${perfTickMax.toFixed(2)}ms | ` +
      `sendGameState avg=${(perfSendSum / tickRateWindowCount).toFixed(2)}ms max=${perfSendMax.toFixed(2)}ms | players=${players.size}${cpuLog}`
    );
    tickRateWindowCount = 0;
    tickRateWindowStart = now;
    perfTickSum = 0; perfTickMax = 0;
    perfSendSum = 0; perfSendMax = 0;
  }
}

// Self-correcting tick loop. `setInterval`/`setTimeout` are bound to the OS's
// timer resolution — Windows defaults to ~15.6ms ticks, which doesn't divide
// evenly into our 16.67ms budget and can silently halve the real rate.
// `setImmediate` isn't subject to that floor — it fires as soon as the event
// loop is free — so on Windows we poll with it and only do real work once
// enough time has actually elapsed, per process.hrtime(). Bounded catch-up
// avoids a death-spiral if something genuinely stalls the loop.
//
// That polling is a busy-spin: it pins a core near 100% permanently, which is
// wasted cost/heat on a real server and (on cheap cloud VMs) reads as
// constant load that drains burst-credit CPU quotas. Linux/macOS don't have
// Windows' coarse timer floor — `setTimeout` there is accurate to ~1ms — so
// elsewhere we sleep through most of the tick budget and only spin-correct
// the last ~1-2ms, for the same precision at a small fraction of the CPU use.
const IS_WINDOWS = process.platform === 'win32';
const TICK_NS = BigInt(Math.round(TICK_MS * 1e6));
let nextTickTime = process.hrtime.bigint();

function tickLoop() {
  const now = process.hrtime.bigint();
  let ranTicks = 0;
  while (now >= nextTickTime && ranTicks < 5) {
    runTick();
    nextTickTime += TICK_NS;
    ranTicks++;
  }
  if (ranTicks >= 5) {
    // Fell too far behind to catch up — resync instead of spiraling.
    nextTickTime = now + TICK_NS;
  }

  if (!IS_WINDOWS) {
    const remainingMs = Number(nextTickTime - process.hrtime.bigint()) / 1e6;
    if (remainingMs > 2) {
      setTimeout(tickLoop, remainingMs - 1);
      return;
    }
  }
  setImmediate(tickLoop);
}
setImmediate(tickLoop);

httpServer.listen(PORT, () => {
  console.log(`HussBall server running on http://localhost:${PORT}`);
});
