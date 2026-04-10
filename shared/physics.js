// HussBall Physics Engine
// 2D circle-based physics with collision groups (bitmasks), walls, damping, gravity.

'use strict';

// ============================================================
// Collision layers (bitmask)
// ============================================================
// Each disc/wall has cGroup (what it IS) and cMask (what it COLLIDES WITH).
// Two discs collide when: (a.cGroup & b.cMask) && (b.cGroup & a.cMask)
// A disc collides with a wall when: (disc.cMask & wall.cGroup) !== 0
const C = {
  BALL:     0x01,
  RED:      0x02,
  BLUE:     0x04,
  WALL:     0x08,   // field boundary walls (ball stops here)
  POST:     0x10,   // goalposts
  OUTER:    0x20,   // extended boundary (players stop here, further out than WALL)
  NET:      0x40,   // goal net walls
  RED_WALL: 0x80,   // walls that only block red team
  BLUE_WALL:0x100,  // walls that only block blue team
};
C.PLAYER = C.RED | C.BLUE;
C.ALL = 0xFFFF;

// ============================================================
// Vector helpers
// ============================================================
function dot(ax, ay, bx, by) { return ax * bx + ay * by; }
function len(x, y) { return Math.sqrt(x * x + y * y); }
function normalize(x, y) {
  const l = len(x, y);
  return l > 0 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

// ============================================================
// Disc
// ============================================================
function createDisc(opts) {
  return {
    x: opts.x || 0,
    y: opts.y || 0,
    vx: opts.vx || 0,
    vy: opts.vy || 0,
    radius: opts.radius || 10,
    mass: opts.mass || 1,
    damping: opts.damping || 0.99,
    bounce: opts.bounce || 0.5,
    isStatic: opts.isStatic || false,
    color: opts.color || '#ffffff',
    cGroup: opts.cGroup ?? C.ALL,
    cMask:  opts.cMask  ?? C.ALL,
    gravityScale: opts.gravityScale ?? 0, // 0 = unaffected, 1 = full gravity
  };
}

// ============================================================
// Collision: disc vs disc (with mask check)
// ============================================================
function collideDiscDisc(a, b) {
  // Mask check
  if (!(a.cGroup & b.cMask) || !(b.cGroup & a.cMask)) return false;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = len(dx, dy);
  const minDist = a.radius + b.radius;

  if (dist >= minDist || dist === 0) return false;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;

  if (a.isStatic && b.isStatic) return false;

  // Separate
  if (a.isStatic) {
    b.x += nx * overlap;
    b.y += ny * overlap;
  } else if (b.isStatic) {
    a.x -= nx * overlap;
    a.y -= ny * overlap;
  } else {
    const totalMass = a.mass + b.mass;
    a.x -= nx * overlap * (b.mass / totalMass);
    a.y -= ny * overlap * (b.mass / totalMass);
    b.x += nx * overlap * (a.mass / totalMass);
    b.y += ny * overlap * (a.mass / totalMass);
  }

  // Bounce
  const bounciness = (a.bounce + b.bounce) / 2;
  const dvx = a.vx - b.vx;
  const dvy = a.vy - b.vy;
  const relVelN = dot(dvx, dvy, nx, ny);

  if (relVelN <= 0) return true;

  if (a.isStatic) {
    const impulse = relVelN * (1 + bounciness);
    b.vx += nx * impulse;
    b.vy += ny * impulse;
  } else if (b.isStatic) {
    const impulse = relVelN * (1 + bounciness);
    a.vx -= nx * impulse;
    a.vy -= ny * impulse;
  } else {
    const totalMass = a.mass + b.mass;
    const impulse = relVelN * (1 + bounciness) / totalMass;
    a.vx -= nx * impulse * b.mass;
    a.vy -= ny * impulse * b.mass;
    b.vx += nx * impulse * a.mass;
    b.vy += ny * impulse * a.mass;
  }

  return true;
}

// ============================================================
// Collision: disc vs wall segment (with mask check)
// ============================================================
function collideDiscWall(disc, wall) {
  // Mask check: disc wants to collide with wall's group?
  if (!(disc.cMask & wall.cGroup)) return false;

  const ex = wall.x2 - wall.x1;
  const ey = wall.y2 - wall.y1;
  const segLenSq = ex * ex + ey * ey;
  if (segLenSq === 0) return false;

  const t = Math.max(0, Math.min(1,
    dot(disc.x - wall.x1, disc.y - wall.y1, ex, ey) / segLenSq
  ));

  const closestX = wall.x1 + t * ex;
  const closestY = wall.y1 + t * ey;
  const dx = disc.x - closestX;
  const dy = disc.y - closestY;
  const dist = len(dx, dy);

  if (dist >= disc.radius || dist === 0) return false;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = disc.radius - dist;
  disc.x += nx * overlap;
  disc.y += ny * overlap;

  const velDotN = dot(disc.vx, disc.vy, nx, ny);
  if (velDotN < 0) {
    const bounciness = (disc.bounce + (wall.bounce || 0.5)) / 2;
    disc.vx -= nx * velDotN * (1 + bounciness);
    disc.vy -= ny * velDotN * (1 + bounciness);
  }

  return true;
}

// ============================================================
// Kick
// ============================================================
function tryKick(player, ball, playerCfg) {
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const dist = len(dx, dy);
  const kickDist = player.radius + ball.radius + playerCfg.kickRadius;

  if (dist > kickDist || dist === 0) return false;

  const n = normalize(dx, dy);
  ball.vx += n.x * playerCfg.kickForce;
  ball.vy += n.y * playerCfg.kickForce;

  return true;
}

// ============================================================
// Apply player input
// ============================================================
function applyInput(disc, input, playerCfg) {
  let ax = 0, ay = 0;
  if (input.up)    ay -= 1;
  if (input.down)  ay += 1;
  if (input.left)  ax -= 1;
  if (input.right) ax += 1;

  const l = len(ax, ay);
  if (l > 0) {
    ax = (ax / l) * playerCfg.acceleration;
    ay = (ay / l) * playerCfg.acceleration;
  }

  disc.vx += ax;
  disc.vy += ay;

  const speed = len(disc.vx, disc.vy);
  if (speed > playerCfg.maxSpeed) {
    disc.vx = (disc.vx / speed) * playerCfg.maxSpeed;
    disc.vy = (disc.vy / speed) * playerCfg.maxSpeed;
  }
}

// ============================================================
// Check goals
// ============================================================
function checkGoals(ball, goals) {
  for (const goal of goals) {
    // Volleyball: ball touches floor → team on that side loses
    if (goal.isVolleyball) {
      if (ball.y + ball.radius >= goal.floorY) {
        return ball.x < 0 ? 'blue' : 'red';
      }
      continue;
    }
    if (goal.team === 'red') {
      if (ball.x <= goal.x && ball.y >= goal.y1 && ball.y <= goal.y2)
        return 'blue';
    } else {
      if (ball.x >= goal.x && ball.y >= goal.y1 && ball.y <= goal.y2)
        return 'red';
    }
  }
  return null;
}

// ============================================================
// Physics step (unified, mask-based)
// ============================================================
function stepPhysics(state, map) {
  const gravity = map.gravity || { x: 0, y: 0 };

  // All movable discs: balls + player discs
  // All static discs: posts
  // All walls: field walls + outer walls + net walls

  // 1. Integrate: gravity, damping, position update
  for (const ball of state.balls) {
    ball.vx += gravity.x * ball.gravityScale;
    ball.vy += gravity.y * ball.gravityScale;
    ball.vx *= ball.damping;
    ball.vy *= ball.damping;
    ball.x += ball.vx;
    ball.y += ball.vy;
  }

  for (const disc of state.discs) {
    if (disc.isStatic) continue;
    disc.vx *= disc.damping;
    disc.vy *= disc.damping;
    disc.x += disc.vx;
    disc.y += disc.vy;
  }

  // 2. Disc-wall collisions (all movable discs vs all walls, mask-filtered)
  const allMovable = [...state.balls, ...state.discs.filter(d => !d.isStatic)];
  const allWalls = state.walls;

  for (const disc of allMovable) {
    for (const wall of allWalls) {
      collideDiscWall(disc, wall);
    }
  }

  // 3. Disc-disc collisions (all discs including static posts, mask-filtered)
  const allDiscs = [...state.balls, ...state.discs, ...state.posts];
  for (let i = 0; i < allDiscs.length; i++) {
    for (let j = i + 1; j < allDiscs.length; j++) {
      collideDiscDisc(allDiscs[i], allDiscs[j]);
    }
  }
}

// ============================================================
// Exports
// ============================================================
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    C,
    createDisc, collideDiscDisc, collideDiscWall,
    tryKick, applyInput, checkGoals, stepPhysics,
    dot, len, normalize,
  };
}
