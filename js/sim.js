// sim.js — pure physics: ball, walls, bumpers, flippers, plunger, capture holes.
// Coordinate system: canvas (0,0) is top-left, +X right, +Y down. Gravity is +Y.
// Length unit: pixels. Time unit: seconds.

// ===== Table dimensions / global tuning =====
const TABLE_W = 600;
const TABLE_H = 900;

const BALL_R = 11;
const GRAVITY = 1800;            // px/s²; pinball tables are tilted ~6–7°, this fakes it
const AIR_DRAG = 0.00015;        // per-substep velocity damping (very mild)
const SUBSTEPS = 6;              // physics substeps per rendered frame (anti-tunneling)
const MAX_SPEED = 2400;          // cap ball speed (px/s)
const ROLLING_VN_THRESHOLD = 80; // |normal velocity| below this is treated as rolling contact (no bounce)

const WALL_RESTITUTION = 0.55;
const BUMPER_RESTITUTION = 1.05; // pop bumpers add energy
const BUMPER_KICK = 380;         // minimum velocity imparted on bumper hit
const SLINGSHOT_KICK = 360;
const DROP_TARGET_RESTITUTION = 0.7;
const FLIPPER_RESTITUTION = 0.55;

// ===== Flipper geometry =====
const FLIPPER_LEN = 76;
const FLIPPER_BASE_R = 10;
const FLIPPER_TIP_R = 6;
const FLIPPER_REST_ANGLE_L = 0.48;       // left flipper rest angle (down-right from pivot)
const FLIPPER_UP_ANGLE_L = -0.52;        // left flipper active angle (up-right from pivot)
const FLIPPER_RAISE_SPEED = 26;          // rad/s when raising
const FLIPPER_LOWER_SPEED = 14;          // rad/s when lowering

// ===== Plunger =====
const PLUNGER_MAX_CHARGE = 1.0;          // seconds to reach full power
const PLUNGER_MIN_POWER = 600;           // launch velocity floor (just a tap)
const PLUNGER_MAX_POWER = 2050;          // full charge

// ===== Score values =====
const SCORE_BUMPER = 100;
const SCORE_SLINGSHOT = 25;
const SCORE_DROP_TARGET = 250;
const SCORE_DROP_ALL_BONUS = 2000;
const SCORE_WORMHOLE = 500;
const SCORE_WORMHOLE_JACKPOT = 5000;
const SCORE_BLACK_HOLE = 750;
const SCORE_ENGINEER_BONUS = 10000;
const SCORE_LANE_LETTER = 150;
const SCORE_HYPERSPACE = 3000;

// ===== Helpers =====
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function len(x, y) { return Math.sqrt(x * x + y * y); }

function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return { x: x1, y: y1, t: 0 };
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return { x: x1 + t * dx, y: y1 + t * dy, t };
}

// Generate an arc as a sequence of line segments.
// startAng → endAng (in screen-coord radians, since cos/sin still work the same; +Y is down).
function arcSegments(cx, cy, r, startAng, endAng, n, opts = {}) {
  const segs = [];
  for (let i = 0; i < n; i++) {
    const a1 = startAng + (endAng - startAng) * (i / n);
    const a2 = startAng + (endAng - startAng) * ((i + 1) / n);
    segs.push({
      x1: cx + r * Math.cos(a1), y1: cy + r * Math.sin(a1),
      x2: cx + r * Math.cos(a2), y2: cy + r * Math.sin(a2),
      ...opts,
    });
  }
  return segs;
}

// ===== Table construction =====
// Static geometry is rebuilt fresh each match (drop targets reset).
function buildTable() {
  const walls = [];

  // -- Top arc: connects left outer wall to right outer wall, looping over the top.
  // Arc center (300, 400), radius 282. Sweep from angle π (left) to 0 (right), going UP (negative Y),
  // which in screen coords is the "upper" half — use angles π → 2π going through 3π/2.
  // We want ball INSIDE the arc, so we trace the inner curve.
  const ARC_CX = 300, ARC_CY = 400, ARC_R = 282;
  walls.push(...arcSegments(ARC_CX, ARC_CY, ARC_R, Math.PI, 2 * Math.PI, 36));

  // -- Outer side walls (from arc endpoints downward).
  walls.push({ x1: ARC_CX - ARC_R, y1: ARC_CY, x2: ARC_CX - ARC_R, y2: 870 });        // left
  walls.push({ x1: ARC_CX + ARC_R, y1: ARC_CY, x2: ARC_CX + ARC_R, y2: 870 });        // right outer

  // -- Plunger lane divider (separates plunger lane on right from main playfield).
  // Top of divider at y=470 so the ball can curve over from arc into main field.
  // Bottom open so drained-from-plunger balls fall through.
  walls.push({ x1: 540, y1: 470, x2: 540, y2: 810 });

  // -- One-way deflector above plunger lane: blocks main-field balls from re-entering
  // the plunger lane from above. Allows ball going UP (vy < 0) to pass through.
  walls.push({ x1: 540, y1: 470, x2: 500, y2: 430, oneWay: 'down' });

  // -- Bottom slanted walls converging toward flippers (the inlanes).
  // Straight diagonal each side, passing UNDER the slingshots with clearance.
  // NB: no extra back-wall behind the pivot — three walls meeting at the same
  // point creates a wedge where a slow ball gets bounced between all three.
  // The outlane area is open by design; the stuck-ball safety net (game.js)
  // catches anything that crawls there.
  walls.push({ x1: 18, y1: 760, x2: 200, y2: 825 });   // left inlane (outer wall → flipper pivot)
  walls.push({ x1: 540, y1: 760, x2: 400, y2: 825 });  // right inlane (divider → flipper pivot)

  // ===== Bumpers (planet pop-bumpers) =====
  const bumpers = [
    { x: 175, y: 460, r: 32, hits: 0 },
    { x: 425, y: 460, r: 32, hits: 0 },
    { x: 300, y: 360, r: 32, hits: 0 },
  ];

  // ===== Slingshots (triangular kickers above flippers) =====
  // The "front" edge is the kicker (faces the upper playfield where balls fall from).
  // Slingshots sit clear of the inlane corner (~30px gap) so the ball isn't wedged.
  const slingshots = [
    {
      // Left slingshot: vertices (90, 630), (160, 690), (90, 730)
      // Kicker faces UP-RIGHT (normal ≈ (0.65, -0.76)) — bounces incoming balls back toward upper playfield.
      front: { x1: 90, y1: 630, x2: 160, y2: 690 },
      back: [
        { x1: 160, y1: 690, x2: 90, y2: 730 },   // lower edge (facing flipper)
        { x1: 90, y1: 630, x2: 90, y2: 730 },    // back-vertical
      ],
      lit: 0,
    },
    {
      // Right slingshot: mirror — vertices (510, 630), (440, 690), (510, 730)
      front: { x1: 510, y1: 630, x2: 440, y2: 690 },
      back: [
        { x1: 440, y1: 690, x2: 510, y2: 730 },  // lower edge
        { x1: 510, y1: 630, x2: 510, y2: 730 },  // back-vertical
      ],
      lit: 0,
    },
  ];
  for (const s of slingshots) {
    for (const b of s.back) walls.push(b);
  }

  // ===== Drop targets (row of 3, left side mid-field) =====
  // Each modeled as a small rectangle (4 segs) that becomes inactive when struck.
  const dropTargets = [];
  const DROP_Y = 600, DROP_W = 38, DROP_H = 12;
  const dropXs = [120, 175, 230];
  for (let i = 0; i < dropXs.length; i++) {
    const x = dropXs[i];
    dropTargets.push({
      x, y: DROP_Y, w: DROP_W, h: DROP_H,
      down: false, downTimer: 0,
      i,
    });
  }

  // ===== S-P-A-C-E rollover lanes (top of field, just below top arc) =====
  // These are detection regions, not collision walls. Ball rolling through lights a letter.
  const laneY = 230;
  const laneSpacing = 70;
  const laneStartX = 300 - 2 * laneSpacing;
  const laneLetters = ['S', 'P', 'A', 'C', 'E'];
  const lanes = laneLetters.map((letter, i) => ({
    letter,
    x: laneStartX + i * laneSpacing,
    y: laneY,
    w: 32, h: 24,
    lit: false,
  }));

  // ===== Wormhole kicker (small saucer left side) =====
  const wormhole = { x: 80, y: 310, r: 18, captureTime: 0.65, hits: 0, captured: false, captureTimer: 0, cooldownTimer: 0 };

  // ===== Black hole saucer (center, between bumpers) =====
  const blackHole = { x: 300, y: 540, r: 19, captureTime: 0.85, hits: 0, captured: false, captureTimer: 0, cooldownTimer: 0 };

  // ===== Flippers =====
  // Pivots spread wide enough that, at rest, the tips leave a clear drain channel
  // (>= 50px between tip surfaces) so a ball naturally falls through instead of
  // balancing on the V between the tips.
  const flippers = {
    left: {
      pivot: { x: 200, y: 825 },
      restAngle: FLIPPER_REST_ANGLE_L,
      upAngle: FLIPPER_UP_ANGLE_L,
      angle: FLIPPER_REST_ANGLE_L,
      angVel: 0,
      pressed: false,
      side: 'left',
    },
    right: {
      pivot: { x: 400, y: 825 },
      restAngle: Math.PI - FLIPPER_REST_ANGLE_L,
      upAngle: Math.PI - FLIPPER_UP_ANGLE_L,
      angle: Math.PI - FLIPPER_REST_ANGLE_L,
      angVel: 0,
      pressed: false,
      side: 'right',
    },
  };

  // ===== Plunger =====
  const plunger = {
    x: 560, y: 770,           // resting tip position
    restY: 770,
    maxPullDist: 60,
    pullDist: 0,
    charging: false,
    chargeStart: 0,
  };
  // Top of plunger acts as a movable floor for the ball when at rest in the plunger lane.
  // Updated each frame based on pullDist.
  const plungerWall = { x1: 541, y1: plunger.restY, x2: 580, y2: plunger.restY, isPlunger: true };
  walls.push(plungerWall);

  // -- Bottom edge of plunger lane: a hard floor below the plunger's max pull so
  // a fully-pulled ball can't escape. Set just below the deepest plunger position.
  walls.push({ x1: 541, y1: plunger.restY + plunger.maxPullDist + 8, x2: 580, y2: plunger.restY + plunger.maxPullDist + 8 });

  // ===== Drain boundary =====
  // Below this line (and between the flippers), the ball is lost.
  const drain = { y: 880 };

  return { walls, bumpers, slingshots, dropTargets, lanes, wormhole, blackHole, flippers, plunger, plungerWall, drain };
}

// ===== Ball factory =====
function createBall(x, y) {
  return { x, y, vx: 0, vy: 0, captured: null, alive: true };
}

// Place a fresh ball in the plunger lane, resting on the plunger top.
function spawnBallInPlunger(table) {
  return createBall(560, table.plunger.restY - BALL_R - 1);
}

// ===== Flipper helpers =====
function flipperSegment(f) {
  return {
    x1: f.pivot.x,
    y1: f.pivot.y,
    x2: f.pivot.x + FLIPPER_LEN * Math.cos(f.angle),
    y2: f.pivot.y + FLIPPER_LEN * Math.sin(f.angle),
  };
}

// Returns the flipper's swept tangential velocity at point (px, py).
function flipperPointVelocity(f, px, py) {
  const rx = px - f.pivot.x;
  const ry = py - f.pivot.y;
  // ω × r in 2D: (-ry*ω, rx*ω)
  return { vx: -ry * f.angVel, vy: rx * f.angVel };
}

function stepFlipper(f, dt) {
  // Direction depends on which side: left flipper goes from restAngle (positive) to upAngle (negative),
  // right flipper goes from restAngle (~π-0.48) to upAngle (~π+0.52), both via decreasing angle for left
  // and increasing for right. We resolve direction by comparing rest/up.
  let target = f.pressed ? f.upAngle : f.restAngle;
  const dir = Math.sign(target - f.angle) || 0;
  const speed = f.pressed ? FLIPPER_RAISE_SPEED : FLIPPER_LOWER_SPEED;
  const delta = dir * speed * dt;
  const next = f.angle + delta;
  // Don't overshoot target.
  if ((delta > 0 && next > target) || (delta < 0 && next < target)) {
    f.angVel = (target - f.angle) / dt;
    f.angle = target;
  } else {
    f.angVel = dir * speed;
    f.angle = next;
  }
}

// ===== Collision: ball vs line segment =====
// `restitution` overrides default. Returns {hit: bool, normal: {nx,ny}}.
function ballSegmentCollide(ball, seg, restitution = WALL_RESTITUTION) {
  // One-way walls: skip collision based on ball velocity direction.
  // 'down' = wall only collides when ball is moving DOWN (vy > 0), letting up-moving balls pass.
  if (seg.oneWay === 'down' && ball.vy < 0) return { hit: false };

  // Plunger top: only collide when the ball is ABOVE the wall (so the wall acts as a floor,
  // not a ceiling that the freshly-launched ball would slap into).
  if (seg.isPlunger && ball.y > (seg.y1 + seg.y2) / 2) return { hit: false };

  const c = closestPointOnSegment(ball.x, ball.y, seg.x1, seg.y1, seg.x2, seg.y2);
  const dx = ball.x - c.x;
  const dy = ball.y - c.y;
  const distSq = dx * dx + dy * dy;
  if (distSq > BALL_R * BALL_R) return { hit: false };
  const dist = Math.sqrt(distSq) || 0.0001;
  const nx = dx / dist;
  const ny = dy / dist;
  // Push ball out
  const overlap = BALL_R - dist + 0.1;
  ball.x += nx * overlap;
  ball.y += ny * overlap;
  // Reflect velocity
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < 0) {
    // For slow approach, treat as rolling contact: zero out normal velocity, preserve tangent.
    // Prevents the ball from oscillating in corners and lets gravity roll it along the slope.
    const e = (-vn < ROLLING_VN_THRESHOLD) ? 0 : restitution;
    const j = -(1 + e) * vn;
    ball.vx += j * nx;
    ball.vy += j * ny;
  }
  return { hit: true, nx, ny };
}

// ===== Collision: ball vs circle (bumper) =====
function ballCircleCollide(ball, circle, restitution = WALL_RESTITUTION, kick = 0) {
  const dx = ball.x - circle.x;
  const dy = ball.y - circle.y;
  const rSum = BALL_R + circle.r;
  const distSq = dx * dx + dy * dy;
  if (distSq > rSum * rSum) return { hit: false };
  const dist = Math.sqrt(distSq) || 0.0001;
  const nx = dx / dist, ny = dy / dist;
  const overlap = rSum - dist + 0.1;
  ball.x += nx * overlap;
  ball.y += ny * overlap;
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < 0) {
    const j = -(1 + restitution) * vn;
    ball.vx += j * nx;
    ball.vy += j * ny;
  }
  // Minimum exit velocity (bumper "pop")
  if (kick > 0) {
    const speed = len(ball.vx, ball.vy);
    if (speed < kick) {
      ball.vx = nx * kick;
      ball.vy = ny * kick;
    }
  }
  return { hit: true, nx, ny };
}

// ===== Collision: ball vs flipper =====
// The flipper line extends INFINITELY past the pivot (no clamp at t=0).
// That way a ball directly above the pivot still gets pushed perpendicular to
// the *flipper slope* (up and outward), not straight up — gravity's tangent
// component along the slope then slides the ball off toward the tip instead of
// pinning it at the pivot endpoint. The tip end (t=1) still caps normally.
function ballFlipperCollide(ball, f) {
  const seg = flipperSegment(f);
  const ddx = seg.x2 - seg.x1, ddy = seg.y2 - seg.y1;
  const lenSq = ddx * ddx + ddy * ddy;
  if (lenSq < 1e-9) return { hit: false };
  let t = ((ball.x - seg.x1) * ddx + (ball.y - seg.y1) * ddy) / lenSq;
  if (t > 1) t = 1; // clamp at the tip
  // Extension past the pivot (t<0) is only used when the ball is actually
  // near the pivot — otherwise the infinite line would catch balls far away
  // that happen to lie close to it (e.g. a ball in the plunger lane sits
  // perpendicular-close to the right flipper's line and was getting pushed
  // back down when fired).
  if (t < 0) {
    const dPivotSq = (ball.x - seg.x1) * (ball.x - seg.x1) +
                     (ball.y - seg.y1) * (ball.y - seg.y1);
    if (dPivotSq > 900) t = 0; // > 30px from the pivot → use endpoint
  }
  const cx = seg.x1 + t * ddx;
  const cy = seg.y1 + t * ddy;
  const flipperCapR = 7;
  const dx = ball.x - cx;
  const dy = ball.y - cy;
  const rSum = BALL_R + flipperCapR;
  const distSq = dx * dx + dy * dy;
  if (distSq > rSum * rSum) return { hit: false };
  const dist = Math.sqrt(distSq);
  // Degenerate case: ball exactly on the line. Pick "outward" (perpendicular to
  // the line, on the playfield-facing side) so we still get a sensible push.
  let nx, ny;
  if (dist < 0.01) {
    const ux = ddx / Math.sqrt(lenSq), uy = ddy / Math.sqrt(lenSq);
    // Perpendicular pointing up-outward (rotate tangent -90° in screen coords)
    nx = uy; ny = -ux;
  } else {
    nx = dx / dist; ny = dy / dist;
  }
  const overlap = rSum - dist + 0.1;
  ball.x += nx * overlap;
  ball.y += ny * overlap;
  // Angular velocity: use the clamped-at-pivot position so we don't pretend the
  // flipper extends backward physically (it doesn't — the line extension is just
  // a collision-normal trick).
  const angT = t < 0 ? 0 : t;
  const angX = seg.x1 + angT * ddx;
  const angY = seg.y1 + angT * ddy;
  const surf = flipperPointVelocity(f, angX, angY);
  const relVx = ball.vx - surf.vx;
  const relVy = ball.vy - surf.vy;
  const vn = relVx * nx + relVy * ny;
  if (vn < 0) {
    const j = -(1 + FLIPPER_RESTITUTION) * vn;
    ball.vx += j * nx;
    ball.vy += j * ny;
  }
  return { hit: true, nx, ny };
}

// ===== Drop target collision (rectangle as 4 segments) =====
function ballDropTargetCollide(ball, dt) {
  if (dt.down) return { hit: false };
  // Treat as a rectangle. Build 4 edges and use segment collide on the closest.
  const x0 = dt.x, y0 = dt.y, x1 = dt.x + dt.w, y1 = dt.y + dt.h;
  const edges = [
    { x1: x0, y1: y0, x2: x1, y2: y0 }, // top
    { x1: x1, y1: y0, x2: x1, y2: y1 }, // right
    { x1: x1, y1: y1, x2: x0, y2: y1 }, // bottom
    { x1: x0, y1: y1, x2: x0, y2: y0 }, // left
  ];
  let bestDist = Infinity, bestSeg = null;
  for (const e of edges) {
    const c = closestPointOnSegment(ball.x, ball.y, e.x1, e.y1, e.x2, e.y2);
    const d = (ball.x - c.x) ** 2 + (ball.y - c.y) ** 2;
    if (d < bestDist) { bestDist = d; bestSeg = e; }
  }
  if (bestDist > BALL_R * BALL_R) return { hit: false };
  const r = ballSegmentCollide(ball, bestSeg, DROP_TARGET_RESTITUTION);
  if (r.hit) {
    dt.down = true;
    dt.downTimer = 0;
    return { hit: true, dropped: true };
  }
  return { hit: false };
}

// ===== Lane (rollover) detection — not a collision, just region overlap =====
function ballLaneOverlap(ball, lane) {
  return (ball.x > lane.x - lane.w / 2 &&
          ball.x < lane.x + lane.w / 2 &&
          ball.y > lane.y - lane.h / 2 &&
          ball.y < lane.y + lane.h / 2);
}

// ===== Capture saucer (wormhole/black hole) =====
// If ball center is inside the saucer radius, it gets captured.
// A cooldown timer (set on eject) blocks immediate re-capture so a ball that's
// been kicked out has time to clear the area before being eligible again.
function trySaucerCapture(ball, saucer) {
  if (saucer.captured) return false;
  if (saucer.cooldownTimer > 0) return false;
  const dx = ball.x - saucer.x;
  const dy = ball.y - saucer.y;
  const d2 = dx * dx + dy * dy;
  if (d2 < saucer.r * saucer.r) {
    saucer.captured = true;
    saucer.captureTimer = saucer.captureTime;
    ball.captured = saucer;
    ball.vx = 0;
    ball.vy = 0;
    ball.x = saucer.x;
    ball.y = saucer.y;
    saucer.hits = (saucer.hits || 0) + 1;
    return true;
  }
  return false;
}

// Eject a ball that was captured. Place the ball OUTSIDE the saucer's capture radius
// AND start a recapture cooldown so the ball has time to leave the area.
function ejectFromSaucer(ball, saucer, angle, speed) {
  saucer.captured = false;
  saucer.captureTimer = 0;
  saucer.cooldownTimer = 1.2; // seconds during which the saucer cannot recapture
  ball.captured = null;
  const ejectDist = saucer.r + BALL_R + 6;
  ball.x = saucer.x + Math.cos(angle) * ejectDist;
  ball.y = saucer.y + Math.sin(angle) * ejectDist;
  ball.vx = Math.cos(angle) * speed;
  ball.vy = Math.sin(angle) * speed;
}

window.SimPinball = {
  TABLE_W, TABLE_H, BALL_R, GRAVITY, AIR_DRAG, SUBSTEPS, MAX_SPEED,
  WALL_RESTITUTION, BUMPER_RESTITUTION, BUMPER_KICK, SLINGSHOT_KICK,
  FLIPPER_LEN, FLIPPER_BASE_R, FLIPPER_TIP_R,
  FLIPPER_REST_ANGLE_L, FLIPPER_UP_ANGLE_L,
  PLUNGER_MAX_CHARGE, PLUNGER_MIN_POWER, PLUNGER_MAX_POWER,
  SCORE_BUMPER, SCORE_SLINGSHOT, SCORE_DROP_TARGET, SCORE_DROP_ALL_BONUS,
  SCORE_WORMHOLE, SCORE_WORMHOLE_JACKPOT, SCORE_BLACK_HOLE,
  SCORE_ENGINEER_BONUS, SCORE_LANE_LETTER, SCORE_HYPERSPACE,
  clamp, lerp, len, closestPointOnSegment,
  buildTable, createBall, spawnBallInPlunger,
  flipperSegment, flipperPointVelocity, stepFlipper,
  ballSegmentCollide, ballCircleCollide, ballFlipperCollide,
  ballDropTargetCollide, ballLaneOverlap,
  trySaucerCapture, ejectFromSaucer,
};
