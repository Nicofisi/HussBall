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
    maxFallSpeed: opts.maxFallSpeed ?? null, // null = no cap on gravity-driven fall speed (never touches kicks)
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

  if (dist >= minDist) return false;
  if (a.isStatic && b.isStatic) return false;

  let nx, ny, overlap;
  if (dist === 0) {
    // Exactly concentric (e.g. the ball respawning exactly on top of a
    // bumper) — there's no direction to derive from zero separation, so
    // without a fallback this collision would never resolve and the two
    // would stay permanently stuck inside each other. Push apart along an
    // arbitrary fixed axis instead.
    nx = 1; ny = 0;
    overlap = minDist;
  } else {
    nx = dx / dist;
    ny = dy / dist;
    overlap = minDist - dist;
  }

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

  // Bounce. bounceOverride lets two discs bounce harder against EACH OTHER
  // specifically, without changing how bouncy either one is against anything
  // else — only used when BOTH sides have it set (e.g. the playerBounce
  // modifier tags every player disc, so player-vs-player hits use it, but
  // player-vs-ball still falls through to the normal .bounce average since
  // the ball never has bounceOverride set).
  const bounciness = (a.bounceOverride != null && b.bounceOverride != null)
    ? (a.bounceOverride + b.bounceOverride) / 2
    : (a.bounce + b.bounce) / 2;
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
// Static rounded-rectangle obstacle (for bumpers with non-circular shapes)
// ============================================================
function createRectObstacle(opts) {
  return {
    x: opts.x || 0,
    y: opts.y || 0,
    halfW: (opts.w || 20) / 2,
    halfH: (opts.h || 20) / 2,
    cornerRadius: opts.cornerRadius ?? 8,
    bounce: opts.bounce ?? 0.5,
    color: opts.color || '#ffffff',
    isStatic: true,
    isRect: true,
    cGroup: opts.cGroup ?? C.POST,
    cMask: opts.cMask ?? (C.BALL | C.PLAYER),
  };
}

// Collision: disc vs static rounded rect. Clamps the disc's center to the
// rect shrunk by cornerRadius on each axis, then treats the clamped point as
// a circle of radius cornerRadius for the distance test — the standard
// rounded-box/capsule-vs-circle technique. Always static (bumpers never
// move), so only `disc` gets pushed out/bounced, mirroring collideDiscWall.
function collideDiscRoundedRect(disc, rect) {
  if (!(disc.cGroup & rect.cMask) || !(rect.cGroup & disc.cMask)) return false;

  const halfW = rect.halfW - rect.cornerRadius;
  const halfH = rect.halfH - rect.cornerRadius;
  const dx0 = disc.x - rect.x;
  const dy0 = disc.y - rect.y;
  const cx = Math.max(-halfW, Math.min(halfW, dx0));
  const cy = Math.max(-halfH, Math.min(halfH, dy0));
  const dx = dx0 - cx;
  const dy = dy0 - cy;
  const dist = len(dx, dy);
  const minDist = disc.radius + rect.cornerRadius;

  if (dist >= minDist && dist > 0) return false;

  let nx, ny, overlap;
  if (dist === 0) {
    // dx===0 && dy===0 means the disc's center is inside the rect's flat
    // core (cx===dx0 and cy===dy0), not just a single exact point like the
    // circle-circle case — this can happen if a fast disc tunnels past the
    // rounded edge in one substep, or spawns embedded in the rect. Push out
    // toward whichever edge is closest instead of an arbitrary fixed axis,
    // so it always exits the short way rather than potentially crossing
    // back through more of the rect.
    const distRight = halfW - dx0, distLeft = halfW + dx0;
    const distDown = halfH - dy0, distUp = halfH + dy0;
    const minPen = Math.min(distRight, distLeft, distDown, distUp);
    if (minPen === distRight) { nx = 1; ny = 0; }
    else if (minPen === distLeft) { nx = -1; ny = 0; }
    else if (minPen === distDown) { nx = 0; ny = 1; }
    else { nx = 0; ny = -1; }
    overlap = minPen + rect.cornerRadius;
  } else {
    nx = dx / dist;
    ny = dy / dist;
    overlap = minDist - dist;
  }
  disc.x += nx * overlap;
  disc.y += ny * overlap;

  const velDotN = dot(disc.vx, disc.vy, nx, ny);
  if (velDotN < 0) {
    const bounciness = (disc.bounce + rect.bounce) / 2;
    disc.vx -= nx * velDotN * (1 + bounciness);
    disc.vy -= ny * velDotN * (1 + bounciness);
  }

  return true;
}

// ============================================================
// Static convex-polygon obstacle (triangles, diamonds, trapezoids, ...)
// ============================================================
function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const ex = x2 - x1, ey = y2 - y1;
  const segLenSq = ex * ex + ey * ey;
  if (segLenSq === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, ((px - x1) * ex + (py - y1) * ey) / segLenSq));
  return { x: x1 + t * ex, y: y1 + t * ey };
}

// Assumes a convex polygon with consistently-wound vertices (all cross
// products the same sign) — true for every shape shared/bumperLayouts.js
// generates, since each is built by sweeping around its own center in one
// direction.
function pointInConvexPolygon(px, py, verts) {
  let sign = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

// `points` are LOCAL offsets from (x,y) — baked into absolute worldPoints up
// front since bumper obstacles are always static (never need recomputing).
// cornerRadius is rendering-only here (see collideDiscConvexPolygon) — kept
// on the object purely so it can flow through to the client payload.
function createPolygonObstacle(opts) {
  const x = opts.x || 0, y = opts.y || 0;
  return {
    x, y,
    worldPoints: opts.points.map(p => ({ x: x + p.x, y: y + p.y })),
    cornerRadius: opts.cornerRadius ?? 8,
    bounce: opts.bounce ?? 0.5,
    color: opts.color || '#ffffff',
    isStatic: true,
    isPoly: true,
    cGroup: opts.cGroup ?? C.POST,
    cMask: opts.cMask ?? (C.BALL | C.PLAYER),
  };
}

// Collision: disc vs static convex polygon. Finds the closest point on the
// polygon's boundary (looping every edge's closest-point-on-segment, exactly
// like collideDiscWall does for one edge — this naturally handles vertex
// regions too, no separate case needed) and whether the disc's center is
// inside or outside the polygon.
//
// Deliberately does NOT offset the polygon inward by cornerRadius the way
// collideDiscRoundedRect does for rects (that requires shrinking an
// arbitrary convex polygon, real extra work) — the physics boundary is the
// polygon's raw vertices; cornerRadius only rounds the *drawn* shape on the
// client. In practice this doesn't feel any less "rounded" in play, because
// a circular disc already smoothly rolls around a sharp geometric vertex on
// its own — the same reason corners of the field boundary already feel fine.
function collideDiscConvexPolygon(disc, poly) {
  if (!(disc.cGroup & poly.cMask) || !(poly.cGroup & disc.cMask)) return false;

  const verts = poly.worldPoints;
  const n = verts.length;
  let minDist = Infinity, closestX = 0, closestY = 0;
  for (let i = 0; i < n; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    const cp = closestPointOnSegment(disc.x, disc.y, a.x, a.y, b.x, b.y);
    const d = len(disc.x - cp.x, disc.y - cp.y);
    if (d < minDist) { minDist = d; closestX = cp.x; closestY = cp.y; }
  }

  const inside = pointInConvexPolygon(disc.x, disc.y, verts);

  let nx, ny, overlap;
  if (inside) {
    // Embedded (e.g. spawned inside) — push OUT toward the nearest boundary
    // point, plus the disc's own radius so it fully clears it.
    if (minDist === 0) { nx = 1; ny = 0; }
    else { nx = (closestX - disc.x) / minDist; ny = (closestY - disc.y) / minDist; }
    overlap = minDist + disc.radius;
  } else {
    if (minDist >= disc.radius) return false;
    if (minDist === 0) { nx = 1; ny = 0; }
    else { nx = (disc.x - closestX) / minDist; ny = (disc.y - closestY) / minDist; }
    overlap = disc.radius - minDist;
  }

  disc.x += nx * overlap;
  disc.y += ny * overlap;

  const velDotN = dot(disc.vx, disc.vy, nx, ny);
  if (velDotN < 0) {
    const bounciness = (disc.bounce + poly.bounce) / 2;
    disc.vx -= nx * velDotN * (1 + bounciness);
    disc.vy -= ny * velDotN * (1 + bounciness);
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

  // kickForceY defaults to kickForce (identical to before) for any map that
  // doesn't set it. Volleyball sets it higher: gravity constantly fights
  // vertical motion but nothing opposes horizontal, so the same force reads
  // as "flies across the court" sideways and "barely rises" upward — a
  // separate, stronger vertical constant fixes that without touching
  // horizontal kicks at all.
  const n = normalize(dx, dy);
  ball.vx += n.x * playerCfg.kickForce;
  ball.vy += n.y * (playerCfg.kickForceY ?? playerCfg.kickForce);

  return true;
}

// ============================================================
// Apply player input
// ============================================================
// Reverted to the original model after two attempts at a "more directly
// tunable" replacement both regressed real gameplay feel (a target-seeking
// version caused an unnatural instant snap on diagonal input; a fixed-nudge
// version removed the continuous resistance that gives short taps fine
// control). The key property this restores: damping resists velocity build-up
// on EVERY tick, including while accelerating — not just after releasing
// input — so a brief tap only reaches a small fraction of top speed, and only
// holding a direction for a while approaches the full cruising speed. That
// resistance-while-building-up is what makes small, precise movements
// possible; a model that lets accel add unopposed until a hard cap does not
// have an equivalent.
//
// Tuning note: holding a direction settles at an equilibrium speed of
// acceleration*damping/(1-damping) — maxSpeed is a hard safety clamp (used by
// boosts/collisions that can exceed the equilibrium), not the practical top
// speed, so raising maxSpeed alone does nothing unless it's still above that
// equilibrium. To raise practical top speed, raise acceleration and/or
// damping (both push the equilibrium up); to change responsiveness/tap
// precision without changing top speed, adjust both together to keep the
// equilibrium constant.
// input.mx/my is an analog movement vector, magnitude in [0,1] (server.js's
// handleInput clamps it there before it ever reaches here). Keyboard sends a
// unit-length vector in one of 8 directions (full acceleration always, same
// as the old boolean model); a gamepad stick can send any magnitude in
// between, giving finer low-speed control that a digital key can't.
function applyInput(disc, input, playerCfg) {
  const mx = input.mx || 0;
  const my = input.my || 0;
  const ax = mx * playerCfg.acceleration;
  const ay = my * playerCfg.acceleration;

  disc.vx = (disc.vx + ax) * playerCfg.damping;
  disc.vy = (disc.vy + ay) * playerCfg.damping;

  const speed = len(disc.vx, disc.vy);
  if (speed > playerCfg.maxSpeed) {
    disc.vx = (disc.vx / speed) * playerCfg.maxSpeed;
    disc.vy = (disc.vy / speed) * playerCfg.maxSpeed;
  }
}

// ============================================================
// Check goals
// ============================================================
// Constraint future modifiers must respect: on the default (axis:'x') goals,
// team:'red' must sit at negative x (checked via ball.x <= goal.x) and
// team:'blue' at positive x (ball.x >= goal.x) — the branch below keys off
// goal.team, not an explicit left/right check, so swapping either the team
// label or the x-position alone breaks detection. The same rule applies to
// axis:'y' goals: 'red' must be the negative-y (top) one, 'blue' the
// positive-y (bottom) one. A modifier that wants to relabel which team
// scores (without moving geometry) should use transformScorer instead — see
// switchSides in shared/modifiers.js.
function checkGoals(ball, goals) {
  for (const goal of goals) {
    // Volleyball: ball touches floor → team on that side loses
    if (goal.isVolleyball) {
      if (ball.y + ball.radius >= goal.floorY) {
        return ball.x < 0 ? 'blue' : 'red';
      }
      continue;
    }
    if (goal.axis === 'y') {
      // Goals on the top/bottom edges instead of left/right (e.g. the
      // verticalGoals modifier) — same red=negative/blue=positive pairing,
      // just checked against y (position) + x (range) instead of the reverse.
      if (goal.team === 'red') {
        if (ball.y <= goal.y && ball.x >= goal.x1 && ball.x <= goal.x2)
          return 'blue';
      } else {
        if (ball.y >= goal.y && ball.x >= goal.x1 && ball.x <= goal.x2)
          return 'red';
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
// Hard safety ceiling on ball speed. Normal play (kicks, ordinary wall
// bounces) never gets remotely close to this — it exists purely to bound the
// otherwise-unbounded compounding from bounciness > 1 bumper/wall hits (each
// hit multiplies outgoing speed, so a few hits in a row can blow up
// explosively) so the ball can never build up enough speed to tunnel through
// obstacles or the map boundary within the physics engine's fixed 8-substep
// resolution. Deliberately generous (well above any speed normal play
// reaches) so it doesn't cap the "fun fast" feel, just the runaway case.
const BALL_SPEED_CAP = 90;

function stepPhysics(state, map) {
  const gravity = map.gravity || { x: 0, y: 0 };
  // Collected fresh each call: ball-vs-player-disc contacts, for goal/assist attribution.
  state.ballHits = [];

  // 1. Apply gravity & damping once per tick (before substeps)
  for (const ball of state.balls) {
    ball.vx += gravity.x * ball.gravityScale;
    const fallAccel = gravity.y * ball.gravityScale;
    // maxFallSpeed only limits gravity's own contribution (positive vy,
    // since +y is down here) — once gravity has built the fall up to the
    // cap, gravity stops adding more, same idea as real-world terminal
    // velocity, just without modeling drag. It never touches vy directly, so
    // a kick or spike that launches the ball downward faster than the cap is
    // completely unaffected — gravity just contributes nothing further that
    // tick, and the kick's speed decays normally via damping like always.
    if (ball.maxFallSpeed != null && fallAccel > 0) {
      if (ball.vy < ball.maxFallSpeed) {
        ball.vy = Math.min(ball.vy + fallAccel, ball.maxFallSpeed);
      }
    } else {
      ball.vy += fallAccel;
    }
    ball.vx *= ball.damping;
    ball.vy *= ball.damping;
  }

  // Player discs don't get a damping multiply here — applyInput() already
  // folds acceleration + damping together for them once per tick (see its
  // comment), so this loop only ever needs to handle the ball.

  // 2. Calculate substeps: if any disc moves more than its radius per tick, subdivide
  const allMovable = [...state.balls, ...state.discs.filter(d => !d.isStatic)];
  let maxRatio = 0;
  for (const d of allMovable) {
    const speed = len(d.vx, d.vy);
    const ratio = speed / d.radius;
    if (ratio > maxRatio) maxRatio = ratio;
  }
  // Cap raised from 8 to 16: at BALL_SPEED_CAP (90) with the smallest bumper
  // obstacles in play, 8 substeps left displacement-per-substep large enough
  // to occasionally hop clean over a thin obstacle between two discrete
  // position samples (no bounce *or* flash, since both come from the same
  // collision check) — 16 halves that gap for a comfortable safety margin.
  const substeps = Math.min(16, Math.max(1, Math.ceil(maxRatio)));
  const dt = 1 / substeps;

  // 3. Substep loop: integrate position fractionally, then resolve collisions
  const allWalls = state.walls;
  const allDiscs = [...state.balls, ...state.discs, ...state.posts];

  for (let step = 0; step < substeps; step++) {
    // Position integration (fractional)
    for (const d of allMovable) {
      d.x += d.vx * dt;
      d.y += d.vy * dt;
    }

    // Disc-wall collisions
    for (const disc of allMovable) {
      for (const wall of allWalls) {
        collideDiscWall(disc, wall);
      }
    }

    // Disc-disc collisions
    const numBalls = state.balls.length;
    for (let i = 0; i < allDiscs.length; i++) {
      for (let j = i + 1; j < allDiscs.length; j++) {
        const a = allDiscs[i], b = allDiscs[j];
        // Rect/polygon obstacles are always static, so only the plain-disc
        // side of a pair can ever be the moving one; a static-vs-static
        // pairing (two obstacles) is a no-op just like it already is in
        // collideDiscDisc.
        const hit = (!a.isStatic && b.isRect) ? collideDiscRoundedRect(a, b)
          : (!b.isStatic && a.isRect) ? collideDiscRoundedRect(b, a)
          : (!a.isStatic && b.isPoly) ? collideDiscConvexPolygon(a, b)
          : (!b.isStatic && a.isPoly) ? collideDiscConvexPolygon(b, a)
          : (!a.isRect && !b.isRect && !a.isPoly && !b.isPoly) ? collideDiscDisc(a, b)
          : false;
        // Ball-vs-(player-disc-or-post) contact (i is a ball): record it. Consumers
        // that only care about player touches (goal/assist attribution) already
        // guard on the disc having an ownerId, so posts here are a harmless no-op
        // for them — this is what lets a bumper-hit-flash effect reuse the same list.
        if (hit && i < numBalls && j >= numBalls) {
          state.ballHits.push({ ball: a, disc: b });
        }
      }
    }

    // Cap ball speed after every substep's collisions, not just once at the
    // end of the tick. Bounce impulses use bounciness > 1 on purpose (that's
    // the whole point of Bouncy Walls/Bumpers), which multiplies outgoing
    // speed on every hit — a ball ping-ponging between two close bumpers can
    // compound that multiple times within a single tick's substeps, so only
    // clamping once per tick would let it blow past the cap (and the fixed
    // 8-substep resolution) before that end-of-tick clamp ever saw it.
    for (const ball of state.balls) {
      const s = len(ball.vx, ball.vy);
      if (s > BALL_SPEED_CAP) {
        ball.vx = (ball.vx / s) * BALL_SPEED_CAP;
        ball.vy = (ball.vy / s) * BALL_SPEED_CAP;
      }
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
    createRectObstacle, collideDiscRoundedRect,
    createPolygonObstacle, collideDiscConvexPolygon,
    tryKick, applyInput, checkGoals, stepPhysics,
    dot, len, normalize,
  };
}
