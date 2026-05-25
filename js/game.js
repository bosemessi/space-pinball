// game.js — canvas rendering, animation loop, input handling, scoring & mission logic.
// All game state lives on `window.GameState`. Mutated by network.js + ui.js too.

const S = window.SimPinball;

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

// ===== Pre-computed starfield (drawn under the playfield each frame) =====
const stars = [];
(function initStars() {
  for (let i = 0; i < 120; i++) {
    stars.push({
      x: Math.random() * S.TABLE_W,
      y: Math.random() * S.TABLE_H,
      r: Math.random() * 1.4 + 0.2,
      a: Math.random() * 0.6 + 0.15,
      tw: Math.random() * 0.4 + 0.6, // twinkle phase factor
    });
  }
})();

// ===== Game state factory =====
function createGameState(opts = {}) {
  const isHotseat = !!opts.hotseat; // 1-screen 2-player not used in remote; placeholder
  return {
    table: S.buildTable(),
    ball: null,
    players: opts.players || [{ name: 'You', color: '#80a8ff', score: 0 }],
    currentPlayerIdx: 0,
    ballNumber: 1,             // 1..TOTAL_BALLS
    totalBalls: 3,
    phase: 'idle',             // 'idle' | 'launching' | 'in-play' | 'ball-lost' | 'match-over'
    myIdx: 0,                  // which player this client controls
    isSpectating: false,       // true while watching the other player's ball
    isHost: !!opts.isHost,
    missions: {
      wormholeJackpotEnd: 0,
      hyperspaceCycles: 0,
      engineerHits: 0,
      engineerActive: false,
      engineerMultEnd: 0,
      extraBallPending: false,
      spaceLitCount: 0,
    },
    popups: [],   // floating score numbers
    particles: [],
    lastFrameTime: 0,
    laneRolloverCooldown: {},  // per-lane cooldown so a single pass doesn't trigger many times
    timeNow: 0,
    bumperFlash: {},
    onEvent: null,             // (event) => void  — for network broadcast
  };
}

window.GameState = null;

// ===== Score popups =====
function addPopup(state, x, y, text, color = '#ffd479') {
  state.popups.push({ x, y, vy: -40, text, color, life: 0.7, age: 0 });
}

function spawnParticles(state, x, y, n = 6, color = '#cce0ff') {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 80 + Math.random() * 180;
    state.particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.4 + Math.random() * 0.3,
      age: 0,
      color,
    });
  }
}

// ===== Mission logic =====
function addScore(state, points, sourceX = null, sourceY = null, color = '#ffd479') {
  const mult = state.missions.engineerActive ? 2 : 1;
  const final = points * mult;
  state.players[state.currentPlayerIdx].score += final;
  if (sourceX != null) addPopup(state, sourceX, sourceY, `+${final}`, color);
  notifyEvent(state, { type: 'score', idx: state.currentPlayerIdx, score: state.players[state.currentPlayerIdx].score });
}

function notifyEvent(state, ev) {
  if (state.onEvent) state.onEvent(ev);
}

function startWormholeJackpot(state) {
  state.missions.wormholeJackpotEnd = state.timeNow + 10;
}

function triggerEngineerMission(state) {
  state.missions.engineerActive = true;
  state.missions.engineerMultEnd = state.timeNow + 15;
  state.missions.engineerHits = 0;
  addScore(state, S.SCORE_ENGINEER_BONUS, state.table.blackHole.x, state.table.blackHole.y, '#a8ffe8');
}

function awardExtraBall(state) {
  state.missions.extraBallPending = true;
  // Visual cue
  addPopup(state, 300, 200, 'EXTRA BALL!', '#a8ffe8');
}

// ===== Physics + game step =====
function gameStep(state, dt) {
  state.timeNow += dt;

  // --- Flippers ---
  const fL = state.table.flippers.left;
  const fR = state.table.flippers.right;
  S.stepFlipper(fL, dt);
  S.stepFlipper(fR, dt);

  // --- Mission timers ---
  if (state.missions.engineerActive && state.timeNow >= state.missions.engineerMultEnd) {
    state.missions.engineerActive = false;
  }

  // --- Plunger charge ---
  const p = state.table.plunger;
  if (p.charging) {
    const elapsed = state.timeNow - p.chargeStart;
    p.pullDist = S.clamp(elapsed / S.PLUNGER_MAX_CHARGE, 0, 1) * p.maxPullDist;
  } else if (p.pullDist > 0) {
    // Spring back when not charging
    p.pullDist = Math.max(0, p.pullDist - 600 * dt);
  }
  // Move plunger wall to match
  if (state.table.plungerWall) {
    const wy = p.restY + p.pullDist;
    state.table.plungerWall.y1 = wy;
    state.table.plungerWall.y2 = wy;
  }

  // --- Drop target recovery: when all 3 are down, after a short wait, all pop back up ---
  const allDown = state.table.dropTargets.every(d => d.down);
  if (allDown) {
    for (const d of state.table.dropTargets) {
      d.downTimer += dt;
      if (d.downTimer > 2.0) { d.down = false; d.downTimer = 0; }
    }
  }

  // --- Saucer capture / cooldown timers ---
  for (const sname of ['wormhole', 'blackHole']) {
    const s = state.table[sname];
    if (s.captured) {
      s.captureTimer -= dt;
      if (s.captureTimer <= 0) {
        const ball = state.ball;
        if (ball && ball.captured === s) {
          // Wider angle jitter so the ball is less likely to fall straight back in.
          const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
          S.ejectFromSaucer(ball, s, angle, 720);
        }
      }
    }
    if (s.cooldownTimer > 0) s.cooldownTimer = Math.max(0, s.cooldownTimer - dt);
  }

  // --- Bumper flash fade ---
  for (let i = 0; i < state.table.bumpers.length; i++) {
    if (state.bumperFlash[i]) state.bumperFlash[i] = Math.max(0, state.bumperFlash[i] - dt * 3);
  }
  for (const s of state.table.slingshots) {
    if (s.lit > 0) s.lit = Math.max(0, s.lit - dt * 4);
  }

  // --- Lane cooldowns ---
  for (const key in state.laneRolloverCooldown) {
    state.laneRolloverCooldown[key] -= dt;
    if (state.laneRolloverCooldown[key] <= 0) delete state.laneRolloverCooldown[key];
  }

  // --- Ball physics with substeps ---
  const ball = state.ball;
  if (ball && ball.alive) {
    const sdt = dt / S.SUBSTEPS;
    for (let k = 0; k < S.SUBSTEPS; k++) {
      stepBallPhysics(state, ball, sdt);
      if (!ball.alive) break;
    }
  }

  // --- Stuck-ball safety: if the ball has been crawling for several seconds
  // while in active play, give up and drain it rather than freezing the player. ---
  if (ball && ball.alive && !ball.captured && state.phase === 'in-play') {
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed < 25) {
      state.stuckTimer = (state.stuckTimer || 0) + dt;
      if (state.stuckTimer > 5) {
        state.stuckTimer = 0;
        ball.alive = false;
        onBallLost(state);
      }
    } else {
      state.stuckTimer = 0;
    }
  } else {
    state.stuckTimer = 0;
  }

  // --- Particles + popups ---
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const pt = state.particles[i];
    pt.age += dt;
    if (pt.age >= pt.life) { state.particles.splice(i, 1); continue; }
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vy += 200 * dt;
  }
  for (let i = state.popups.length - 1; i >= 0; i--) {
    const pp = state.popups[i];
    pp.age += dt;
    if (pp.age >= pp.life) { state.popups.splice(i, 1); continue; }
    pp.y += pp.vy * dt;
    pp.vy += 8 * dt; // slight gravity
  }
}

function stepBallPhysics(state, ball, dt) {
  if (ball.captured) return; // frozen while in saucer

  // Plunger force: if ball is in plunger lane and plunger is releasing, kick the ball.
  // The plunger applies an impulse when it releases (transition from charging -> not charging).
  // We handle the "fire" event separately via firePlunger().

  // If ball is in plunger lane and plunger tip is moving up toward it, push it.
  // (Plunger physics is simplified — see firePlunger.)

  // Gravity
  ball.vy += S.GRAVITY * dt;
  // Air drag (mild)
  ball.vx *= (1 - S.AIR_DRAG);
  ball.vy *= (1 - S.AIR_DRAG);

  // Cap speed
  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp > S.MAX_SPEED) {
    ball.vx = (ball.vx / sp) * S.MAX_SPEED;
    ball.vy = (ball.vy / sp) * S.MAX_SPEED;
  }

  // Integrate
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // Collide with walls
  for (const w of state.table.walls) {
    S.ballSegmentCollide(ball, w);
  }

  // Bumpers
  for (let i = 0; i < state.table.bumpers.length; i++) {
    const b = state.table.bumpers[i];
    const r = S.ballCircleCollide(ball, b, S.BUMPER_RESTITUTION, S.BUMPER_KICK);
    if (r.hit) {
      b.hits++;
      addScore(state, S.SCORE_BUMPER, b.x, b.y, '#80e0ff');
      spawnParticles(state, b.x + r.nx * b.r, b.y + r.ny * b.r, 5, '#80e0ff');
      state.bumperFlash[i] = 1.0;
    }
  }

  // Slingshots — collide with front face; back walls already in `walls` list
  for (const s of state.table.slingshots) {
    const r = S.ballSegmentCollide(ball, s.front, 1.0);
    if (r.hit) {
      // Add a kick along the front normal
      const sp = Math.hypot(ball.vx, ball.vy);
      if (sp < S.SLINGSHOT_KICK) {
        ball.vx = r.nx * S.SLINGSHOT_KICK;
        ball.vy = r.ny * S.SLINGSHOT_KICK;
      }
      s.lit = 1.0;
      const midX = (s.front.x1 + s.front.x2) / 2;
      const midY = (s.front.y1 + s.front.y2) / 2;
      addScore(state, S.SCORE_SLINGSHOT, midX, midY - 14, '#ffd479');
      spawnParticles(state, midX, midY, 3, '#ffd479');
    }
  }

  // Drop targets
  let droppedThisFrame = false;
  for (const d of state.table.dropTargets) {
    const r = S.ballDropTargetCollide(ball, d);
    if (r.hit && r.dropped) {
      addScore(state, S.SCORE_DROP_TARGET, d.x + d.w / 2, d.y, '#ffa0e8');
      droppedThisFrame = true;
    }
  }
  if (droppedThisFrame) {
    const allDown = state.table.dropTargets.every(dx => dx.down);
    if (allDown) {
      addScore(state, S.SCORE_DROP_ALL_BONUS, 175, 600, '#ffa0e8');
      startWormholeJackpot(state);
      addPopup(state, 300, 600, 'WORMHOLE JACKPOT LIT!', '#ffa0e8');
    }
  }

  // Flippers
  S.ballFlipperCollide(ball, state.table.flippers.left);
  S.ballFlipperCollide(ball, state.table.flippers.right);

  // Saucers: wormhole + black hole
  const wormhole = state.table.wormhole;
  if (!wormhole.captured && S.trySaucerCapture(ball, wormhole)) {
    // If jackpot is lit, big score; otherwise small.
    if (state.timeNow < state.missions.wormholeJackpotEnd) {
      addScore(state, S.SCORE_WORMHOLE_JACKPOT, wormhole.x, wormhole.y - 30, '#ffa0e8');
      addPopup(state, wormhole.x, wormhole.y - 50, 'JACKPOT!', '#ffa0e8');
      state.missions.wormholeJackpotEnd = 0;
    } else {
      addScore(state, S.SCORE_WORMHOLE, wormhole.x, wormhole.y - 30, '#80e0ff');
    }
    spawnParticles(state, wormhole.x, wormhole.y, 10, '#a8ffe8');
  }

  const blackHole = state.table.blackHole;
  if (!blackHole.captured && S.trySaucerCapture(ball, blackHole)) {
    addScore(state, S.SCORE_BLACK_HOLE, blackHole.x, blackHole.y - 30, '#cc80ff');
    state.missions.engineerHits++;
    if (state.missions.engineerHits >= 4 && !state.missions.engineerActive) {
      triggerEngineerMission(state);
      addPopup(state, blackHole.x, blackHole.y - 50, 'ENGINEER MISSION!', '#cc80ff');
    }
    spawnParticles(state, blackHole.x, blackHole.y, 10, '#cc80ff');
  }

  // Lanes (S-P-A-C-E rollover) — overlap detection with cooldown to avoid retrigger
  for (const lane of state.table.lanes) {
    if (lane.lit) continue;
    if (state.laneRolloverCooldown[lane.letter]) continue;
    if (S.ballLaneOverlap(ball, lane)) {
      lane.lit = true;
      state.laneRolloverCooldown[lane.letter] = 0.3;
      addScore(state, S.SCORE_LANE_LETTER, lane.x, lane.y, '#a8ffe8');
      state.missions.spaceLitCount = state.table.lanes.filter(l => l.lit).length;
      const allLit = state.table.lanes.every(l => l.lit);
      if (allLit) {
        for (const l of state.table.lanes) l.lit = false;
        state.missions.spaceLitCount = 0;
        awardExtraBall(state);
      }
    }
  }

  // Drain: ball below drain line and within main playfield → ball lost.
  if (ball.y > state.table.drain.y) {
    ball.alive = false;
    onBallLost(state);
  }

  // Sanity: ball stuck outside table (shouldn't happen with walls)
  if (ball.x < -50 || ball.x > S.TABLE_W + 50 || ball.y > S.TABLE_H + 100) {
    ball.alive = false;
    onBallLost(state);
  }
}

// ===== Ball lifecycle =====
function onBallLost(state) {
  const isExtra = state.missions.extraBallPending;
  if (isExtra) state.missions.extraBallPending = false;
  state.phase = isExtra ? 'extra-ball' : 'ball-lost';
  // Network layer decides what happens next; it'll call startNextBall on a timer.
  notifyEvent(state, { type: 'ball-lost', idx: state.currentPlayerIdx, extraBall: isExtra });
}

function startNextBall(state, opts = {}) {
  // Reset per-ball mission state unless this is an extra ball (which should preserve progress)
  if (!opts.keepMissions) {
    state.missions.engineerHits = 0;
    state.missions.engineerActive = false;
    state.missions.wormholeJackpotEnd = 0;
    state.missions.spaceLitCount = 0;
    for (const l of state.table.lanes) l.lit = false;
    for (const d of state.table.dropTargets) { d.down = false; d.downTimer = 0; }
  }
  state.ball = S.spawnBallInPlunger(state.table);
  state.phase = 'launching';
}

function firePlunger(state) {
  // Translate plunger pull dist to ball launch velocity
  const p = state.table.plunger;
  const t = p.pullDist / p.maxPullDist;
  if (t < 0.02) { p.pullDist = 0; p.charging = false; return; }
  const power = S.PLUNGER_MIN_POWER + (S.PLUNGER_MAX_POWER - S.PLUNGER_MIN_POWER) * t;
  if (state.ball && state.ball.alive && state.ball.y > 600 && state.ball.x > 540) {
    // Teleport ball just above the resting plunger top, then impart upward velocity.
    state.ball.x = 560;
    state.ball.y = p.restY - S.BALL_R - 1;
    state.ball.vx = 0;
    state.ball.vy = -power;
    state.phase = 'in-play';
  }
  p.pullDist = 0;
  p.charging = false;
}

// ===== Render =====
function render(state) {
  const w = S.TABLE_W, h = S.TABLE_H;

  // Background — deep space gradient
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#04081c');
  bg.addColorStop(1, '#020514');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Starfield
  const tNow = state.timeNow;
  for (const s of stars) {
    const tw = 0.6 + 0.4 * Math.sin(tNow * s.tw * 2 + s.x);
    ctx.globalAlpha = s.a * tw;
    ctx.fillStyle = '#cce0ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Subtle radial vignette around playfield center
  const vg = ctx.createRadialGradient(w / 2, 480, 120, w / 2, 480, 520);
  vg.addColorStop(0, 'rgba(80,120,255,0.05)');
  vg.addColorStop(1, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  // Lanes (S-P-A-C-E)
  for (const lane of state.table.lanes) {
    ctx.save();
    ctx.translate(lane.x, lane.y);
    if (lane.lit) {
      ctx.shadowColor = '#a8ffe8';
      ctx.shadowBlur = 16;
      ctx.fillStyle = 'rgba(168, 255, 232, 0.18)';
    } else {
      ctx.fillStyle = 'rgba(120, 160, 220, 0.06)';
    }
    ctx.fillRect(-lane.w / 2, -lane.h / 2, lane.w, lane.h);
    ctx.shadowBlur = 0;
    ctx.fillStyle = lane.lit ? '#a8ffe8' : '#5a6a8a';
    ctx.font = 'bold 18px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lane.letter, 0, 0);
    ctx.restore();
  }

  // Saucers (drawn as glowing pits with rotating rings)
  drawSaucer(state, state.table.wormhole, '#a8ffe8', 'WORM');
  drawSaucer(state, state.table.blackHole, '#cc80ff', 'BH');

  // Drop targets
  for (const d of state.table.dropTargets) {
    if (d.down) {
      // Faded "down" indicator
      ctx.fillStyle = 'rgba(160, 100, 200, 0.18)';
      ctx.fillRect(d.x, d.y + d.h - 3, d.w, 3);
    } else {
      const grad = ctx.createLinearGradient(d.x, d.y, d.x, d.y + d.h);
      grad.addColorStop(0, '#ffa0e8');
      grad.addColorStop(1, '#a04080');
      ctx.fillStyle = grad;
      ctx.fillRect(d.x, d.y, d.w, d.h);
      ctx.strokeStyle = '#ffd0ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(d.x + 0.5, d.y + 0.5, d.w - 1, d.h - 1);
    }
  }

  // Slingshots — triangular kickers
  for (const s of state.table.slingshots) {
    const a = s.front, b = s.back[0], c = s.back[1];
    // Vertices: a.x1,y1 (top) - a.x2,y2 (bottom of front edge) - and back corner
    // Build triangle from front segment + back vertex (= b.x1,y1 or c.x1,y1 which are the same point)
    const back = { x: b.x1, y: b.y1 }; // both back-edges share this vertex
    ctx.save();
    if (s.lit > 0) {
      ctx.shadowColor = '#ffd479';
      ctx.shadowBlur = 24 * s.lit;
    }
    const tri = ctx.createLinearGradient(back.x, back.y, (a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2);
    tri.addColorStop(0, '#3a2a1a');
    tri.addColorStop(1, s.lit > 0 ? '#ffd479' : '#8a6a3a');
    ctx.fillStyle = tri;
    ctx.beginPath();
    ctx.moveTo(back.x, back.y);
    ctx.lineTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Bumpers — glowing planets
  for (let i = 0; i < state.table.bumpers.length; i++) {
    const b = state.table.bumpers[i];
    const flash = state.bumperFlash[i] || 0;
    ctx.save();
    const grad = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, 2, b.x, b.y, b.r);
    grad.addColorStop(0, '#cce8ff');
    grad.addColorStop(0.4, '#4a8fef');
    grad.addColorStop(1, '#0a1f4a');
    ctx.fillStyle = grad;
    if (flash > 0) {
      ctx.shadowColor = '#80c8ff';
      ctx.shadowBlur = 28 * flash;
    }
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r + flash * 2.5, 0, Math.PI * 2);
    ctx.fill();
    // Rim
    ctx.strokeStyle = `rgba(180, 220, 255, ${0.4 + flash * 0.5})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  // Walls (all line segments)
  ctx.strokeStyle = '#5070b0';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(120, 160, 255, 0.5)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  for (const wseg of state.table.walls) {
    if (wseg.oneWay) continue; // draw one-way separately, dimmer
    ctx.moveTo(wseg.x1, wseg.y1);
    ctx.lineTo(wseg.x2, wseg.y2);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  // One-way walls dimmer + dashed
  ctx.strokeStyle = 'rgba(100, 140, 200, 0.35)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (const wseg of state.table.walls) {
    if (!wseg.oneWay) continue;
    ctx.moveTo(wseg.x1, wseg.y1);
    ctx.lineTo(wseg.x2, wseg.y2);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Plunger (visible in plunger lane bottom)
  drawPlunger(state);

  // Flippers
  drawFlipper(state.table.flippers.left, '#8aa8ff');
  drawFlipper(state.table.flippers.right, '#8aa8ff');

  // Ball
  if (state.ball && state.ball.alive) {
    const b = state.ball;
    ctx.save();
    const g = ctx.createRadialGradient(b.x - 3, b.y - 4, 1, b.x, b.y, S.BALL_R);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, '#cce0ff');
    g.addColorStop(1, '#4a6fd0');
    ctx.fillStyle = g;
    ctx.shadowColor = 'rgba(150, 190, 255, 0.7)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(b.x, b.y, S.BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Particles
  for (const p of state.particles) {
    const t = 1 - p.age / p.life;
    ctx.globalAlpha = t;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;

  // Score popups
  for (const pp of state.popups) {
    const t = 1 - pp.age / pp.life;
    ctx.globalAlpha = t;
    ctx.fillStyle = pp.color;
    ctx.font = 'bold 16px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(pp.text, pp.x, pp.y);
  }
  ctx.globalAlpha = 1;

  // Phase overlays drawn on canvas (e.g., "Pull launcher to begin")
  if (state.phase === 'launching') {
    drawHint(ctx, 'Pull launcher to fire ball', S.TABLE_W / 2, S.TABLE_H - 30);
  } else if (state.phase === 'idle') {
    drawHint(ctx, 'Press Start to launch', S.TABLE_W / 2, S.TABLE_H / 2);
  }

  // Mission banner (if Wormhole Jackpot is lit)
  if (state.timeNow < state.missions.wormholeJackpotEnd) {
    const remaining = state.missions.wormholeJackpotEnd - state.timeNow;
    drawBanner(ctx, `WORMHOLE JACKPOT — ${remaining.toFixed(1)}s`, 80, 285, '#ffa0e8');
  }
  if (state.missions.engineerActive) {
    drawBanner(ctx, `ENGINEER ×2 — ${(state.missions.engineerMultEnd - state.timeNow).toFixed(1)}s`, 300, 510, '#cc80ff');
  }
}

function drawHint(ctx, text, x, y) {
  ctx.fillStyle = 'rgba(168, 184, 216, 0.7)';
  ctx.font = '14px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
}

function drawBanner(ctx, text, x, y, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.font = 'bold 11px -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawSaucer(state, s, color, label) {
  ctx.save();
  // Dark pit
  const grad = ctx.createRadialGradient(s.x, s.y, 1, s.x, s.y, s.r);
  grad.addColorStop(0, '#000000');
  grad.addColorStop(0.7, '#0a1020');
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
  ctx.fill();

  // Rotating ring
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.5;
  const rot = state.timeNow * 1.2;
  for (let i = 0; i < 6; i++) {
    const a1 = rot + (i * Math.PI * 2) / 6;
    const a2 = a1 + 0.35;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r + 4, a1, a2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlunger(state) {
  const p = state.table.plunger;
  const baseY = 870;
  const tipY = p.restY - p.pullDist;
  // Plunger lane background tint
  ctx.fillStyle = 'rgba(120, 160, 255, 0.05)';
  ctx.fillRect(545, 470, 30, 400);
  // Plunger shaft
  ctx.fillStyle = '#3a4a8a';
  ctx.fillRect(555, tipY, 12, baseY - tipY);
  // Plunger tip (rounded)
  ctx.fillStyle = '#8aa8ff';
  ctx.beginPath();
  ctx.arc(561, tipY, 7, 0, Math.PI * 2);
  ctx.fill();
  // Charge indicator
  const t = p.pullDist / p.maxPullDist;
  if (t > 0.02) {
    ctx.fillStyle = `rgba(255, 212, 121, ${0.3 + t * 0.6})`;
    ctx.fillRect(555, tipY - 4, 12, 3);
  }
}

function drawFlipper(f, color) {
  const seg = S.flipperSegment(f);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(seg.x1, seg.y1);
  ctx.lineTo(seg.x2, seg.y2);
  ctx.stroke();
  // Pivot dot
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#cce0ff';
  ctx.beginPath();
  ctx.arc(seg.x1, seg.y1, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ===== Animation loop =====
let rafHandle = null;
function startGameLoop() {
  if (rafHandle != null) return;
  function frame(ts) {
    rafHandle = requestAnimationFrame(frame);
    const state = window.GameState;
    if (!state) return;
    let dt = (ts - state.lastFrameTime) / 1000;
    if (!state.lastFrameTime || dt > 0.1) dt = 1 / 60; // ignore first frame and huge gaps
    state.lastFrameTime = ts;
    if (!state.isSpectating) gameStep(state, dt);
    else gameStepSpectator(state, dt); // only animate visuals, no physics
    render(state);
    if (window.Network) window.Network.tickNetwork(dt);
    state._hudAccum = (state._hudAccum || 0) + dt;
    if (state._hudAccum > 0.1) { state._hudAccum = 0; window.UI && window.UI.refreshHUD(); }
  }
  rafHandle = requestAnimationFrame(frame);
}

function gameStepSpectator(state, dt) {
  // Advance time, popups, particles — but DO NOT run ball physics or flipper input.
  // The active player's ball/flipper state is overwritten by network messages.
  state.timeNow += dt;
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const pt = state.particles[i];
    pt.age += dt;
    if (pt.age >= pt.life) { state.particles.splice(i, 1); continue; }
    pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 200 * dt;
  }
  for (let i = state.popups.length - 1; i >= 0; i--) {
    const pp = state.popups[i];
    pp.age += dt;
    if (pp.age >= pp.life) { state.popups.splice(i, 1); continue; }
    pp.y += pp.vy * dt; pp.vy += 8 * dt;
  }
  for (let i = 0; i < state.table.bumpers.length; i++) {
    if (state.bumperFlash[i]) state.bumperFlash[i] = Math.max(0, state.bumperFlash[i] - dt * 3);
  }
  for (const s of state.table.slingshots) {
    if (s.lit > 0) s.lit = Math.max(0, s.lit - dt * 4);
  }
}

// ===== Input handling =====
const input = {
  flipLeftDown: false,
  flipRightDown: false,
  plungerDown: false,
};

function setFlipper(side, down) {
  const state = window.GameState;
  if (!state || state.isSpectating) return;
  if (side === 'left') state.table.flippers.left.pressed = down;
  if (side === 'right') state.table.flippers.right.pressed = down;
}

function setPlunger(down) {
  const state = window.GameState;
  if (!state || state.isSpectating) return;
  // Only allow plunger while ball is in plunger lane / launching.
  const p = state.table.plunger;
  if (down) {
    if (!state.ball || !state.ball.alive) return;
    if (state.ball.y > 600 && state.ball.x > 540) {
      p.charging = true;
      p.chargeStart = state.timeNow;
    }
  } else {
    if (p.charging) firePlunger(state);
  }
}

// Keyboard
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') { input.flipLeftDown = true; setFlipper('left', true); }
  if (e.code === 'KeyD' || e.code === 'ArrowRight') { input.flipRightDown = true; setFlipper('right', true); }
  if (e.code === 'Space') { e.preventDefault(); input.plungerDown = true; setPlunger(true); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') { input.flipLeftDown = false; setFlipper('left', false); }
  if (e.code === 'KeyD' || e.code === 'ArrowRight') { input.flipRightDown = false; setFlipper('right', false); }
  if (e.code === 'Space') { input.plungerDown = false; setPlunger(false); }
});

// Touch zones
function bindTouchZones() {
  const zones = document.querySelectorAll('.touch-zone');
  for (const z of zones) {
    const action = z.dataset.action;
    const handler = (down) => {
      if (action === 'flip-left') setFlipper('left', down);
      else if (action === 'flip-right') setFlipper('right', down);
      else if (action === 'plunger') {
        setPlunger(down);
        z.classList.toggle('is-pressed', down);
      }
    };
    z.addEventListener('pointerdown', (e) => { e.preventDefault(); z.setPointerCapture(e.pointerId); handler(true); });
    z.addEventListener('pointerup', (e) => { e.preventDefault(); handler(false); });
    z.addEventListener('pointercancel', (e) => { handler(false); });
    z.addEventListener('pointerleave', (e) => {
      // Don't release flippers if pointer leaves zone but is still down — leave/cancel can fire
      // when finger moves; but with setPointerCapture we should mostly stay attached.
      // For safety, release plunger only.
      if (action === 'plunger') handler(false);
    });
  }
}

// ===== Wake Lock (keep screen on while playing on mobile) =====
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* not supported / denied — fine */ }
}
function releaseWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && document.body.dataset.screen === 'game') requestWakeLock();
});

// ===== Public API =====
window.Game = {
  createGameState,
  startGameLoop,
  bindTouchZones,
  startNextBall,
  firePlunger,
  requestWakeLock,
  releaseWakeLock,
  onBallLost,
  notifyEvent,
};
