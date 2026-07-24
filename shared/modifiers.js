// HussBall Chaos Modifiers
// Each modifier is a self-contained effect the game loop can randomly activate
// while playing on a map that lists its id in `map.modifiers`. Only one is ever
// active at a time (server.js owns that scheduling); a modifier just needs to
// describe what happens when it turns on, what (if anything) it does every
// tick while active, and how to clean up when it turns off.
//
// Two effect styles:
//  - `tick` only: continuous/idempotent (safe to re-apply every tick, and to
//    keep re-establishing an invariant across goal resets — e.g. twoBalls
//    re-spawning the extra ball if a goal reset truncated it away).
//  - `activate`/`deactivate` + geometry: writes into state.modifierExtras,
//    which server.js's rebuildGeometry() merges with the map's base
//    walls/goals/posts. Geometry lives in gameState, so it survives goal
//    resets automatically (resetPositionsAfterGoal never touches it).
//
// server.js is the only place that ever requires this file — the client is a
// self-contained single HTML file with no <script src>, so modifier
// names/descriptions reach it the same way map names already do: through the
// lobby/gameState broadcast payloads, not by loading this module directly.

'use strict';

const physics = require('./physics');
const { makeWalls, makeGoalNetLines } = require('./maps');

// Reads the red/blue net-outline colors straight out of the map's own base
// visual data (rather than hardcoding the same hex/rgba strings a second
// time), so a modifier's regenerated outline always matches the map's palette.
function baseNetColors(state) {
  const lines = (state.baseVisual && state.baseVisual.goalNetLines) || [];
  return { red: lines[0] ? lines[0].color : '#dc3545', blue: lines[3] ? lines[3].color : '#3b82f6' };
}

function spawnExtraBall(state, map) {
  const base = state.balls[0];
  const bx = base ? base.x : map.ball.x;
  const by = base ? base.y : map.ball.y;
  const ball = physics.createDisc({
    x: bx + (Math.random() - 0.5) * 80,
    y: by + (Math.random() - 0.5) * 80,
    radius: map.ball.radius,
    mass: map.ball.mass,
    damping: map.ball.damping,
    bounce: map.ball.bounce,
    color: map.ball.color,
    cGroup: map.ball.cGroup,
    cMask: map.ball.cMask,
    gravityScale: map.ball.gravityScale ?? 0,
  });
  state.balls.push(ball);
}

const MODIFIERS = [
  {
    id: 'bouncyWalls',
    name: 'Bouncy Walls',
    desc: 'Walls accelerate the ball!',
    icon: '🧱',
    // Applied every tick (not just on activate) so a ball that spawns mid-event
    // (e.g. via the extraBall admin cheat) still picks up the effect.
    tick(state) {
      for (const ball of state.balls) ball.bounce = 2.2;
    },
    deactivate(state, map) {
      for (const ball of state.balls) ball.bounce = map.ball.bounce;
    },
  },
  {
    id: 'playerBounce',
    name: 'Bumper Players',
    desc: 'Players bounce off each other!',
    icon: '💥',
    tick(state) {
      for (const disc of state.discs) if (!disc.isStatic) disc.bounce = 2.5;
    },
    deactivate(state) {
      for (const disc of state.discs) if (!disc.isStatic) disc.bounce = 0.5;
    },
  },
  {
    id: 'twoBalls',
    name: 'Two Balls',
    desc: 'An extra ball joins the match!',
    icon: '⚽',
    activate(state, map) {
      spawnExtraBall(state, map);
    },
    // Idempotent: if a goal reset (resetPositionsAfterGoal truncates to 1 ball)
    // happened while this was active, put the second ball back.
    tick(state, map) {
      if (state.balls.length < 2) spawnExtraBall(state, map);
    },
    deactivate(state) {
      state.balls.length = Math.min(state.balls.length, 1);
    },
  },
  {
    id: 'bigGoals',
    name: 'Big Goals',
    desc: 'The goals just got a lot bigger!',
    icon: '🥅',
    activate(state, map) {
      const scale = 1.7;
      const newGoalY = map.goalY * scale;
      // Regenerate the physical wall boundary too — the goal.y1/y2 scoring
      // zone alone doesn't matter if the WALL segments still block the ball
      // at the original (smaller) gap.
      state.modifierExtras.walls = makeWalls(
        map.width, map.height, newGoalY, map.netDepth, map.playerBorder
      );
      state.modifierExtras.goals = state.baseGoals.map(g => g.isVolleyball
        ? { ...g }
        : { ...g, y1: g.y1 * scale, y2: g.y2 * scale });
      state.modifierExtras.postSpecs = state.basePostSpecs.map(p => ({ ...p, y: p.y * scale }));
      const colors = baseNetColors(state);
      state.modifierExtras.visual = {
        goalNetLines: makeGoalNetLines(map.width / 2, map.netDepth, newGoalY, colors.red, colors.blue),
      };
    },
    deactivate(state) {
      state.modifierExtras.walls = null;
      state.modifierExtras.goals = null;
      state.modifierExtras.postSpecs = null;
      state.modifierExtras.visual = null;
    },
  },
  {
    id: 'switchSides',
    name: 'Switch Sides',
    desc: 'Goals now score for the OTHER team!',
    icon: '🔄',
    // Deliberately does NOT touch goal/wall geometry or move anyone: physics
    // checkGoals() hardcodes that the team:'red' entry sits at negative x and
    // team:'blue' at positive x (its branch logic depends on that pairing,
    // not on any explicit left/right check) — relabeling or repositioning the
    // goal data either breaks detection (constant false goals) or is a no-op
    // (swapping both team+x together just reproduces the original pairing).
    // So instead: the ball still goes in through the exact same gaps as
    // always, and only which team gets *credited* flips, via transformScorer
    // below. Goalpost recoloring is purely cosmetic (color has no effect on
    // physics/scoring) so it's a safe visual cue with none of the same risk.
    activate(state, map) {
      state.modifierExtras.postSpecs = state.basePostSpecs.map(p => ({
        ...p,
        color: p.color === '#dc3545' ? '#3b82f6' : (p.color === '#3b82f6' ? '#dc3545' : p.color),
      }));
      const colors = baseNetColors(state);
      state.modifierExtras.visual = {
        // Swapped: red net now on the physical right, blue on the left.
        goalNetLines: makeGoalNetLines(map.width / 2, map.netDepth, map.goalY, colors.blue, colors.red),
      };
    },
    deactivate(state) {
      state.modifierExtras.postSpecs = null;
      state.modifierExtras.visual = null;
    },
    transformScorer(state, scorer) {
      return scorer === 'red' ? 'blue' : 'red';
    },
  },
  {
    id: 'bumpers',
    name: 'Bumpers',
    desc: 'Obstacles appear on the pitch!',
    icon: '🟣',
    activate(state, map) {
      const layouts = map.bumperLayouts || [];
      const layout = layouts.length ? layouts[Math.floor(Math.random() * layouts.length)] : [];
      state.modifierExtras.postSpecs = [...state.basePostSpecs, ...layout];
    },
    deactivate(state) {
      state.modifierExtras.postSpecs = null;
    },
  },
];

const MODIFIERS_BY_ID = Object.fromEntries(MODIFIERS.map(m => [m.id, m]));

module.exports = { MODIFIERS, MODIFIERS_BY_ID };
