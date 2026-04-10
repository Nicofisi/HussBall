// HussBall Maps
// Each map defines arena geometry, physics params, and collision groups.
//
// Collision layers (from physics.js):
//   BALL=0x01 RED=0x02 BLUE=0x04 WALL=0x08 POST=0x10 OUTER=0x20 NET=0x40
//   PLAYER = RED|BLUE

'use strict';

const { C } = (typeof require !== 'undefined') ? require('./physics') : { C: window.C };

// Helper: generate standard walls for a rectangular pitch with goals
function makeWalls(w, h, goalY, netDepth, playerBorder) {
  const hw = w / 2, hh = h / 2, pb = playerBorder;
  const gy = goalY; // half-height of goal opening

  return [
    // === Field boundary walls (WALL = ball collides, players pass through) ===
    // Top
    { x1: -hw, y1: -hh, x2: hw, y2: -hh, bounce: 0.5, cGroup: C.WALL },
    // Bottom
    { x1: -hw, y1: hh, x2: hw, y2: hh, bounce: 0.5, cGroup: C.WALL },
    // Left side - above goal
    { x1: -hw, y1: -hh, x2: -hw, y2: -gy, bounce: 0.5, cGroup: C.WALL },
    // Left side - below goal
    { x1: -hw, y1: gy, x2: -hw, y2: hh, bounce: 0.5, cGroup: C.WALL },
    // Right side - above goal
    { x1: hw, y1: -hh, x2: hw, y2: -gy, bounce: 0.5, cGroup: C.WALL },
    // Right side - below goal
    { x1: hw, y1: gy, x2: hw, y2: hh, bounce: 0.5, cGroup: C.WALL },

    // === Goal nets (NET = ball bounces inside net) ===
    // Red goal (left)
    { x1: -hw - netDepth, y1: -gy, x2: -hw - netDepth, y2: gy, bounce: 0.2, cGroup: C.NET },
    { x1: -hw - netDepth, y1: -gy, x2: -hw, y2: -gy, bounce: 0.2, cGroup: C.NET },
    { x1: -hw - netDepth, y1: gy, x2: -hw, y2: gy, bounce: 0.2, cGroup: C.NET },
    // Blue goal (right)
    { x1: hw + netDepth, y1: -gy, x2: hw + netDepth, y2: gy, bounce: 0.2, cGroup: C.NET },
    { x1: hw + netDepth, y1: -gy, x2: hw, y2: -gy, bounce: 0.2, cGroup: C.NET },
    { x1: hw + netDepth, y1: gy, x2: hw, y2: gy, bounce: 0.2, cGroup: C.NET },

    // === Outer boundary (OUTER = players stop here, ball ignores) ===
    // Top
    { x1: -(hw + pb), y1: -(hh + pb), x2: (hw + pb), y2: -(hh + pb), bounce: 0.3, cGroup: C.OUTER },
    // Bottom
    { x1: -(hw + pb), y1: (hh + pb), x2: (hw + pb), y2: (hh + pb), bounce: 0.3, cGroup: C.OUTER },
    // Left
    { x1: -(hw + pb), y1: -(hh + pb), x2: -(hw + pb), y2: (hh + pb), bounce: 0.3, cGroup: C.OUTER },
    // Right
    { x1: (hw + pb), y1: -(hh + pb), x2: (hw + pb), y2: (hh + pb), bounce: 0.3, cGroup: C.OUTER },
  ];
}

// ============================================================
// CLASSIC
// ============================================================
const CLASSIC = {
  name: 'Classic',
  width: 840,
  height: 400,
  spawnDistance: 170,
  playerBorder: 50,

  ball: {
    x: 0, y: 0,
    radius: 10,
    mass: 1,
    damping: 0.99,
    bounce: 0.5,
    color: '#ffffff',
    gravityScale: 0,
    cGroup: C.BALL,
    cMask: C.PLAYER | C.WALL | C.POST | C.NET,
  },

  player: {
    radius: 15,
    mass: 2,
    damping: 0.96,
    acceleration: 0.12,
    maxSpeed: 3.2,
    kickForce: 5,
    kickRadius: 4,
    kickCooldown: 100,
    // cGroup is set per-team by server (C.RED or C.BLUE)
    cMask: C.BALL | C.PLAYER | C.OUTER | C.POST,
  },

  goals: [
    { team: 'red',  x: -840 / 2, y1: -80, y2: 80 },
    { team: 'blue', x:  840 / 2, y1: -80, y2: 80 },
  ],

  posts: [
    { x: -840 / 2, y: -80, radius: 8, bounce: 0.5, color: '#dc3545',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x: -840 / 2, y:  80, radius: 8, bounce: 0.5, color: '#dc3545',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x:  840 / 2, y: -80, radius: 8, bounce: 0.5, color: '#3b82f6',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x:  840 / 2, y:  80, radius: 8, bounce: 0.5, color: '#3b82f6',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
  ],

  walls: makeWalls(840, 400, 80, 30, 50),

  bg: '#718C5A',
  gravity: { x: 0, y: 0 },
  scoreLimit: 3,
  timeLimit: 180,

  // Visual decorations (pure rendering, no game logic)
  visual: {
    lines: [
      // Center line
      { x1: 0, y1: -200, x2: 0, y2: 200, color: 'rgba(255,255,255,0.25)', width: 4 },
      // Left goal net (U-shape)
      { x1: -420, y1: -80, x2: -450, y2: -80, color: 'rgba(231,76,60,0.5)', width: 4 },
      { x1: -450, y1: -80, x2: -450, y2:  80, color: 'rgba(231,76,60,0.5)', width: 4 },
      { x1: -450, y1:  80, x2: -420, y2:  80, color: 'rgba(231,76,60,0.5)', width: 4 },
      // Right goal net (U-shape)
      { x1: 420, y1: -80, x2: 450, y2: -80, color: 'rgba(52,152,219,0.5)', width: 4 },
      { x1: 450, y1: -80, x2: 450, y2:  80, color: 'rgba(52,152,219,0.5)', width: 4 },
      { x1: 450, y1:  80, x2: 420, y2:  80, color: 'rgba(52,152,219,0.5)', width: 4 },
    ],
    circles: [
      // Center circle
      { x: 0, y: 0, radius: 60, color: 'rgba(255,255,255,0.25)', width: 4 },
    ],
  },
};

// ============================================================
// FUTSAL
// ============================================================
const FUTSAL = {
  name: 'Futsal',
  width: 620,
  height: 310,
  spawnDistance: 140,
  playerBorder: 45,

  ball: {
    x: 0, y: 0,
    radius: 8,
    mass: 0.7,
    damping: 0.985,
    bounce: 0.6,
    color: '#ffffcc',
    gravityScale: 0,
    cGroup: C.BALL,
    cMask: C.PLAYER | C.WALL | C.POST | C.NET,
  },

  player: {
    radius: 15,
    mass: 1.5,
    damping: 0.95,
    acceleration: 0.16,
    maxSpeed: 4.0,
    kickForce: 5.5,
    kickRadius: 4,
    kickCooldown: 80,
    cMask: C.BALL | C.PLAYER | C.OUTER | C.POST,
  },

  goals: [
    { team: 'red',  x: -620 / 2, y1: -60, y2: 60 },
    { team: 'blue', x:  620 / 2, y1: -60, y2: 60 },
  ],

  posts: [
    { x: -620 / 2, y: -60, radius: 6, bounce: 0.5, color: '#dc3545',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x: -620 / 2, y:  60, radius: 6, bounce: 0.5, color: '#dc3545',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x:  620 / 2, y: -60, radius: 6, bounce: 0.5, color: '#3b82f6',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x:  620 / 2, y:  60, radius: 6, bounce: 0.5, color: '#3b82f6',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
  ],

  walls: makeWalls(620, 310, 60, 25, 45),

  bg: '#5B8C3E',
  gravity: { x: 0, y: 0 },
  scoreLimit: 5,
  timeLimit: 180,

  visual: {
    lines: [
      // Center line
      { x1: 0, y1: -155, x2: 0, y2: 155, color: 'rgba(255,255,255,0.25)', width: 4 },
      // Left goal net
      { x1: -310, y1: -60, x2: -335, y2: -60, color: 'rgba(231,76,60,0.5)', width: 4 },
      { x1: -335, y1: -60, x2: -335, y2:  60, color: 'rgba(231,76,60,0.5)', width: 4 },
      { x1: -335, y1:  60, x2: -310, y2:  60, color: 'rgba(231,76,60,0.5)', width: 4 },
      // Right goal net
      { x1: 310, y1: -60, x2: 335, y2: -60, color: 'rgba(52,152,219,0.5)', width: 4 },
      { x1: 335, y1: -60, x2: 335, y2:  60, color: 'rgba(52,152,219,0.5)', width: 4 },
      { x1: 335, y1:  60, x2: 310, y2:  60, color: 'rgba(52,152,219,0.5)', width: 4 },
    ],
    circles: [
      { x: 0, y: 0, radius: 50, color: 'rgba(255,255,255,0.25)', width: 4 },
    ],
  },
};

// ============================================================
// VOLLEYBALL
// ============================================================
// Ball has gravity, players DON'T physically push ball (only kick).
// Net blocks both ball and players.
const VOLLEYBALL = {
  name: 'Volleyball',
  width: 600,
  height: 350,
  spawnDistance: 150,
  spawnLayout: 'horizontal',
  spawnY: 130,
  playerBorder: 40,

  ball: {
    x: 0, y: -100,
    radius: 10,
    mass: 0.5,
    damping: 0.995,
    bounce: 0.75,
    color: '#ffdd44',
    gravityScale: 2,
    cGroup: C.BALL,
    // NO C.PLAYER here: ball passes through players (only kick moves it)
    cMask: C.WALL | C.POST | C.NET,
  },

  player: {
    radius: 15,
    mass: 2,
    damping: 0.96,
    acceleration: 0.2,
    maxSpeed: 3.2,
    kickForce: 10,
    kickRadius: 5,
    kickCooldown: 100,
    // No C.BALL: players don't physically collide with ball
    cMask: C.PLAYER | C.OUTER | C.POST | C.WALL,
    // Per-team overrides (team walls keep players on their side)
    redCMask:  C.PLAYER | C.OUTER | C.POST | C.WALL | C.RED_WALL,
    blueCMask: C.PLAYER | C.OUTER | C.POST | C.WALL | C.BLUE_WALL,
  },

  goals: [
    { isVolleyball: true, floorY: 175 },
  ],

  posts: [
    // Net top
    { x: 0, y: 0, radius: 4, bounce: 0.3, color: '#ffffff',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
  ],

  walls: [
    // Floor (ball + players)
    { x1: -300, y1: 175, x2: 300, y2: 175, bounce: 0.3, cGroup: C.WALL },
    // Side walls — extend far up so ball can't escape (no ceiling for ball!)
    { x1: -300, y1: -5000, x2: -300, y2: 175, bounce: 0.5, cGroup: C.WALL },
    { x1: 300, y1: -5000, x2: 300, y2: 175, bounce: 0.5, cGroup: C.WALL },
    // Net (floor up to center only — ball arcs OVER it)
    { x1: 0, y1: 175, x2: 0, y2: 0, bounce: 0.3, cGroup: C.WALL },
    // Invisible team barriers above net (players only — ball ignores RED_WALL/BLUE_WALL)
    { x1: 0, y1: 0, x2: 0, y2: -5000, bounce: 0.3, cGroup: C.RED_WALL },
    { x1: 0, y1: 0, x2: 0, y2: -5000, bounce: 0.3, cGroup: C.BLUE_WALL },
    // Player ceiling (OUTER — only players stop here, ball passes through)
    { x1: -300, y1: -175, x2: 300, y2: -175, bounce: 0.5, cGroup: C.OUTER },
    // Outer boundary (players)
    { x1: -340, y1: -215, x2: 340, y2: -215, bounce: 0.3, cGroup: C.OUTER },
    { x1: -340, y1: 215, x2: 340, y2: 215, bounce: 0.3, cGroup: C.OUTER },
    { x1: -340, y1: -215, x2: -340, y2: 215, bounce: 0.3, cGroup: C.OUTER },
    { x1: 340, y1: -215, x2: 340, y2: 215, bounce: 0.3, cGroup: C.OUTER },
  ],

  bg: '#D4A44C',
  gravity: { x: 0, y: 0.05 },
  scoreLimit: 14,
  timeLimit: 180,

  visual: {
    lines: [
      // Net
      { x1: 0, y1: 175, x2: 0, y2: 0, color: 'rgba(255,255,255,0.6)', width: 5 },
    ],
    circles: [
      // Net post cap
      { x: 0, y: 0, radius: 4, fill: '#fff' },
    ],
  },
};

// ============================================================
// CHAOS  (Classic pitch + random events)
// ============================================================
const CHAOS = {
  name: 'Chaos',
  width: 840,
  height: 400,
  spawnDistance: 170,
  playerBorder: 50,

  ball: {
    x: 0, y: 0,
    radius: 10,
    mass: 1,
    damping: 0.99,
    bounce: 0.5,
    color: '#ffffff',
    gravityScale: 0,
    cGroup: C.BALL,
    cMask: C.PLAYER | C.WALL | C.POST | C.NET,
  },

  player: {
    radius: 15,
    mass: 2,
    damping: 0.96,
    acceleration: 0.12,
    maxSpeed: 3.2,
    kickForce: 5,
    kickRadius: 4,
    kickCooldown: 100,
    cMask: C.BALL | C.PLAYER | C.OUTER | C.POST,
  },

  goals: [
    { team: 'red',  x: -840 / 2, y1: -80, y2: 80 },
    { team: 'blue', x:  840 / 2, y1: -80, y2: 80 },
  ],

  posts: [
    { x: -840 / 2, y: -80, radius: 8, bounce: 0.5, color: '#dc3545',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x: -840 / 2, y:  80, radius: 8, bounce: 0.5, color: '#dc3545',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x:  840 / 2, y: -80, radius: 8, bounce: 0.5, color: '#3b82f6',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
    { x:  840 / 2, y:  80, radius: 8, bounce: 0.5, color: '#3b82f6',
      cGroup: C.POST, cMask: C.BALL | C.PLAYER },
  ],

  walls: makeWalls(840, 400, 80, 30, 50),

  bg: '#718C5A',
  gravity: { x: 0, y: 0 },
  scoreLimit: 3,
  timeLimit: 300,

  // --- Chaos event system ---
  chaosEvents: [
    { id: 'bouncyWalls',  name: 'Bouncy Walls',  desc: 'Walls accelerate the ball!' },
    { id: 'playerBounce', name: 'Bumper Players', desc: 'Players bounce off each other!' },
  ],
  chaosEventDuration: 20 * 60,   // 20 s in ticks (60 Hz)
  chaosPauseDuration: 20 * 60,   // 20 s pause between events

  visual: {
    lines: [
      // Center line
      { x1: 0, y1: -200, x2: 0, y2: 200, color: 'rgba(255,255,255,0.25)', width: 4 },
      // Left goal net (U-shape)
      { x1: -420, y1: -80, x2: -450, y2: -80, color: 'rgba(231,76,60,0.5)', width: 4 },
      { x1: -450, y1: -80, x2: -450, y2:  80, color: 'rgba(231,76,60,0.5)', width: 4 },
      { x1: -450, y1:  80, x2: -420, y2:  80, color: 'rgba(231,76,60,0.5)', width: 4 },
      // Right goal net (U-shape)
      { x1: 420, y1: -80, x2: 450, y2: -80, color: 'rgba(52,152,219,0.5)', width: 4 },
      { x1: 450, y1: -80, x2: 450, y2:  80, color: 'rgba(52,152,219,0.5)', width: 4 },
      { x1: 450, y1:  80, x2: 420, y2:  80, color: 'rgba(52,152,219,0.5)', width: 4 },
    ],
    circles: [
      // Center circle
      { x: 0, y: 0, radius: 60, color: 'rgba(255,255,255,0.25)', width: 4 },
    ],
  },
};

// ============================================================
const ALL_MAPS = { CLASSIC, FUTSAL, VOLLEYBALL, CHAOS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ALL_MAPS, CLASSIC, FUTSAL, VOLLEYBALL, CHAOS, C };
}
