// HussBall Bumper Layouts
// Obstacle presets for the Chaos 'bumpers' modifier, split out from maps.js
// so this list can grow a lot without bloating the map definition. No
// dependency on maps.js/physics.js (plain data only) to keep this a leaf
// module — safe to require from anywhere without circular-require risk.

'use strict';

// ---- The two obstacle "kinds" ----
// (there used to be a third, violet, strong-bounce-with-flash kind — removed
// entirely; teal now covers that "bouncy obstacle" role on its own)

// 1. Teal bumper: bouncy, passive, does NOT flash. Same bounce tier as the
// walls get boosted to during this modifier (WALL_TIER_BOUNCE, shared with
// shared/modifiers.js) — walls and this obstacle are meant to read as the
// same phenomenon, which is also why the field border glows this same teal
// while Bumpers is active (see public/index.html).
const WALL_TIER_COLOR = '#1abc9c';
const WALL_TIER_BOUNCE = 2.2;

// 2. Kicker (dark green, like a player): not bouncy by itself (normal
// bounce) — instead it actively kicks the ball with the same force as a
// player's kick on contact. Flashes white on contact (unlike the teal kind).
const KICKER_COLOR = '#1b5e20';
const KICKER_DEFAULT_RADIUS = 20;

function softBumper(x, y, radius) {
  return { x, y, radius, bounce: WALL_TIER_BOUNCE, color: WALL_TIER_COLOR, isBumper: false };
}
function softBumperRect(x, y, w, h, cornerRadius) {
  return { shape: 'rect', x, y, w, h, cornerRadius, bounce: WALL_TIER_BOUNCE, color: WALL_TIER_COLOR, isBumper: false };
}
function kicker(x, y, radius) {
  return {
    x, y, radius: radius || KICKER_DEFAULT_RADIUS,
    bounce: 0.5, color: KICKER_COLOR,
    isBumper: true, isKicker: true,
  };
}

// ---- Polygon shapes (triangle/diamond/trapezoid, teal or kicker) ----
// `points` are LOCAL (relative to the shape's own x,y) — physics.js bakes
// them into absolute world coordinates once at creation. cornerRadius here
// only rounds the *drawn* shape (see collideDiscConvexPolygon's comment).
function polyShape(x, y, points, cornerRadius, kind) {
  return kind === 'kicker'
    ? { shape: 'poly', x, y, points, cornerRadius, bounce: 0.5, color: KICKER_COLOR, isBumper: true, isKicker: true }
    : { shape: 'poly', x, y, points, cornerRadius, bounce: WALL_TIER_BOUNCE, color: WALL_TIER_COLOR, isBumper: false };
}
function trianglePoints(size) {
  // Equilateral, apex pointing up. `size` is the circumradius.
  return [0, 1, 2].map(i => {
    const angle = -Math.PI / 2 + i * (2 * Math.PI / 3);
    return { x: size * Math.cos(angle), y: size * Math.sin(angle) };
  });
}
function diamondPoints(w, h) {
  return [{ x: 0, y: -h / 2 }, { x: w / 2, y: 0 }, { x: 0, y: h / 2 }, { x: -w / 2, y: 0 }];
}
function trapezoidPoints(topW, bottomW, height) {
  return [
    { x: -topW / 2, y: -height / 2 }, { x: topW / 2, y: -height / 2 },
    { x: bottomW / 2, y: height / 2 }, { x: -bottomW / 2, y: height / 2 },
  ];
}
function triangle(x, y, size, cornerRadius, kind) {
  return polyShape(x, y, trianglePoints(size), cornerRadius, kind);
}
function diamond(x, y, w, h, cornerRadius, kind) {
  return polyShape(x, y, diamondPoints(w, h), cornerRadius, kind);
}
function trapezoid(x, y, topW, bottomW, height, cornerRadius, kind) {
  return polyShape(x, y, trapezoidPoints(topW, bottomW, height), cornerRadius, kind);
}

// Each layout is symmetric (mirrored and/or point-symmetric about the
// center) and stays clear of (0,0) — the ball's respawn point after every
// goal — with at least ball-radius clearance from every obstacle. Most mix
// the two kinds together; a couple are deliberately single-kind.
const LAYOUTS = [
  // Diagonal teal pair + a smaller counter-diagonal kicker pair
  [
    softBumper(-150, -100, 34), softBumper(150, 100, 34),
    kicker(-70, 70, 20), kicker(70, -70, 20),
  ],
  // Vertical kicker pair + a smaller horizontal teal pair
  [
    kicker(0, -120, 24), kicker(0, 120, 24),
    softBumper(-90, 0, 22), softBumper(90, 0, 22),
  ],
  // Four circles in a row: teal on the outside, kicker inside
  [
    softBumper(-200, 0, 28), kicker(-70, 0, 28),
    kicker(70, 0, 28), softBumper(200, 0, 28),
  ],
  // Diamond: kickers top/bottom, teal left/right
  [
    kicker(0, -140, 22), kicker(0, 140, 22),
    softBumper(-220, 0, 30), softBumper(220, 0, 30),
  ],
  // Two long teal pill-bars (top/bottom) + a small kicker pair
  [
    softBumperRect(0, -110, 220, 34, 16), softBumperRect(0, 110, 220, 34, 16),
    kicker(-70, 0, 22), kicker(70, 0, 22),
  ],
  // Two vertical teal pill-bars (left/right) + two kicker circles (top/bottom)
  [
    softBumperRect(-140, 0, 34, 200, 16), softBumperRect(140, 0, 34, 200, 16),
    kicker(0, -130, 26), kicker(0, 130, 26),
  ],
  // Two short teal bars (top/bottom, off-center) + kicker top corners, teal bottom corners
  [
    softBumperRect(0, -90, 160, 26, 13), softBumperRect(0, 90, 160, 26, 13),
    kicker(-260, -110, 24), kicker(260, -110, 24),
    softBumper(-260, 110, 26), softBumper(260, 110, 26),
  ],
  // All-kicker diamond (single kind)
  [
    kicker(0, -140, 20), kicker(0, 140, 20),
    kicker(-220, 0, 20), kicker(220, 0, 20),
  ],
  // All-teal triangle (single kind)
  [
    softBumper(0, -130, 26), softBumper(-140, 90, 26), softBumper(140, 90, 26),
  ],
  // Two big teal triangles (diagonal) + a smaller counter-diagonal kicker pair
  [
    triangle(-160, -110, 55, 16, 'teal'), triangle(160, 110, 55, 16, 'teal'),
    kicker(-60, 60, 18), kicker(60, -60, 18),
  ],
  // Diamond quad, different sizes: big kickers top/bottom, smaller teal left/right
  [
    diamond(0, -140, 80, 100, 16, 'kicker'), diamond(0, 140, 80, 100, 16, 'kicker'),
    diamond(-190, 0, 40, 55, 10, 'teal'), diamond(190, 0, 40, 55, 10, 'teal'),
  ],
  // Two flared teal trapezoid pillars (left/right) + small kicker pair (top/bottom)
  [
    trapezoid(-130, 0, 40, 90, 70, 14, 'teal'), trapezoid(130, 0, 40, 90, 70, 14, 'teal'),
    kicker(0, -110, 20), kicker(0, 110, 20),
  ],
  // All-kicker triangle ring (4 corners, single kind)
  [
    triangle(-200, -100, 35, 10, 'kicker'), triangle(200, -100, 35, 10, 'kicker'),
    triangle(-200, 100, 35, 10, 'kicker'), triangle(200, 100, 35, 10, 'kicker'),
  ],
  // Mixed-shape showcase: teal trapezoids (diagonal) + kicker triangles (counter-diagonal)
  [
    trapezoid(-170, -60, 50, 80, 60, 12, 'teal'), trapezoid(170, 60, 50, 80, 60, 12, 'teal'),
    triangle(-70, 90, 30, 10, 'kicker'), triangle(70, -90, 30, 10, 'kicker'),
  ],
  // Two large teal diamonds (diagonal) + small kicker accents (counter-diagonal)
  [
    diamond(-150, -100, 90, 110, 18, 'teal'), diamond(150, 100, 90, 110, 18, 'teal'),
    kicker(150, -100, 20), kicker(-150, 100, 20),
  ],
];

module.exports = {
  WALL_TIER_COLOR, WALL_TIER_BOUNCE,
  KICKER_COLOR,
  softBumper, softBumperRect, kicker,
  triangle, diamond, trapezoid,
  LAYOUTS,
};
