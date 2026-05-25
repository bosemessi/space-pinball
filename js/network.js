// network.js — PeerJS wiring for 2-player live-spectate pinball.
// Host is authoritative for turn order. The active player runs physics locally
// and streams ball/flipper state at ~30Hz to the spectator. Score events fire
// out-of-band so the spectator gets popups/particles.

const STATE_HZ = 30;
const STATE_INTERVAL = 1 / STATE_HZ;

let gameMode = 'idle';        // 'idle' | 'host' | 'guest' | 'solo'
let myName = 'Anonymous Cadet';
let peer = null;
let hostConn = null;
let guestConn = null;         // host's single connection to its one guest
let guestName = '';
let knockingPeerId = null;
let knockingName = '';

// Match plan (host only): array of {playerIdx, ballNumber}
let matchOrder = [];
let matchStep = 0;
let extraBallPending = false; // host tracks if active player just earned an extra ball

let stateAccumulator = 0;

function sanitizeName(n) {
  const t = String(n || '').trim().slice(0, 20);
  return t || 'Anonymous Cadet';
}

function setMyName(name) {
  myName = sanitizeName(name);
  try { localStorage.setItem('pinball_name', myName); } catch {}
}

function randomRoomId() {
  return 'sp-' + Math.random().toString(36).substring(2, 10);
}

// ============ HOST: setup ============
function startHosting() {
  gameMode = 'host';
  const roomId = randomRoomId();
  peer = new Peer(roomId);
  peer.on('open', (id) => {
    const inviteUrl = `${location.origin}${location.pathname}?invite=${id}`;
    document.getElementById('invite-link').value = inviteUrl;
    document.getElementById('lobby-status').textContent =
      'Lobby ready. Send the invite link to your opponent.';
  });
  peer.on('connection', (conn) => setupGuestConnection(conn));
  peer.on('error', (err) => {
    console.error('Host PeerJS error:', err);
    document.getElementById('lobby-status').textContent = 'Networking error: ' + err.type;
  });
}

function setupGuestConnection(conn) {
  if (guestConn) {
    // Already have a guest; reject
    conn.on('open', () => {
      conn.send({ type: 'denied', reason: 'Lobby full (2 players max).' });
      setTimeout(() => conn.close(), 200);
    });
    return;
  }
  knockingPeerId = conn.peer;
  conn.on('open', () => {
    // Wait for set_name then show knock
  });
  conn.on('data', (data) => {
    if (data.type === 'set_name') {
      knockingName = sanitizeName(data.name);
      document.getElementById('knock-name').textContent = `${knockingName} wants to join`;
      document.getElementById('knock-box').style.display = '';
      // Stash the conn temporarily; we accept/deny via buttons
      guestConn = conn; // tentative — accept_knock confirms, deny_knock clears
    } else if (guestConn === conn) {
      onGuestMessage(data);
    }
  });
  conn.on('close', () => {
    if (guestConn === conn) {
      guestConn = null;
      onGuestDisconnect();
    }
  });
}

function acceptKnock() {
  if (!guestConn) return;
  document.getElementById('knock-box').style.display = 'none';
  guestConn.send({ type: 'accepted' });
  // Update lobby UI: show guest in player list, enable start button
  refreshHostLobby();
}

function denyKnock() {
  if (!guestConn) return;
  document.getElementById('knock-box').style.display = 'none';
  try { guestConn.send({ type: 'denied', reason: 'Host denied entry.' }); } catch {}
  setTimeout(() => { try { guestConn.close(); } catch {}; guestConn = null; }, 200);
  knockingName = '';
  knockingPeerId = null;
}

function refreshHostLobby() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  const li0 = document.createElement('li');
  li0.textContent = `${myName} — You (host)`;
  list.appendChild(li0);
  if (guestConn && knockingName) {
    const li1 = document.createElement('li');
    li1.textContent = knockingName;
    list.appendChild(li1);
  }
  document.getElementById('btn-start-game').disabled = !guestConn;
}

function onGuestDisconnect() {
  if (window.App && window.App.getScreen() === 'game') {
    alert('Opponent disconnected. Match ended.');
    window.App.showScreen('landing');
    teardownNetwork();
  } else {
    refreshHostLobby();
  }
}

// ============ HOST: start match ============
function startMatch() {
  const isSolo = !guestConn;
  const players = isSolo
    ? [{ name: myName, color: '#80a8ff', score: 0 }]
    : [
        { name: myName, color: '#80a8ff', score: 0 },
        { name: knockingName, color: '#ffa0e8', score: 0 },
      ];

  // Build alternating ball order
  matchOrder = [];
  if (isSolo) {
    for (let b = 1; b <= 3; b++) matchOrder.push({ playerIdx: 0, ballNumber: b });
  } else {
    for (let b = 1; b <= 3; b++) {
      matchOrder.push({ playerIdx: 0, ballNumber: b });
      matchOrder.push({ playerIdx: 1, ballNumber: b });
    }
  }
  matchStep = 0;

  // Initialize my state
  window.GameState = window.Game.createGameState({
    players, isHost: true,
  });
  window.GameState.myIdx = 0;
  attachStateHooks(window.GameState);

  if (!isSolo) {
    guestConn.send({
      type: 'match_start',
      players,
      yourIdx: 1,
    });
  }

  window.App.showScreen('game');
  window.UI.refreshHUD();
  window.Game.startGameLoop();
  window.Game.requestWakeLock();
  hostBeginTurn();
}

// ============ GUEST: join ============
function joinAsGuest(hostId) {
  gameMode = 'guest';
  peer = new Peer();
  peer.on('open', () => {
    hostConn = peer.connect(hostId);
    hostConn.on('open', () => {
      hostConn.send({ type: 'set_name', name: myName });
      document.getElementById('guest-status').textContent = "Knocking on the host's door…";
    });
    hostConn.on('data', onHostMessage);
    hostConn.on('close', () => {
      if (window.App && window.App.getScreen() === 'game') {
        alert('Host disconnected. Match ended.');
        window.App.showScreen('landing');
        teardownNetwork();
      } else {
        document.getElementById('guest-status').textContent = 'Disconnected from host.';
      }
    });
  });
  peer.on('error', (err) => {
    console.error('Guest PeerJS error:', err);
    document.getElementById('guest-status').textContent =
      `Could not connect (${err.type}). The invite link may be invalid.`;
  });
}

// ============ Solo mode ============
function startSolo() {
  gameMode = 'solo';
  const players = [{ name: myName || 'You', color: '#80a8ff', score: 0 }];
  matchOrder = [];
  for (let b = 1; b <= 3; b++) matchOrder.push({ playerIdx: 0, ballNumber: b });
  matchStep = 0;
  window.GameState = window.Game.createGameState({ players, isHost: true });
  window.GameState.myIdx = 0;
  attachStateHooks(window.GameState);
  window.App.showScreen('game');
  window.UI.refreshHUD();
  window.Game.startGameLoop();
  window.Game.requestWakeLock();
  hostBeginTurn();
}

// ============ Turn flow (host only) ============
function hostBeginTurn() {
  if (gameMode === 'guest') return;
  if (matchStep >= matchOrder.length) {
    return hostFinishMatch();
  }
  const turn = matchOrder[matchStep];
  const state = window.GameState;
  state.currentPlayerIdx = turn.playerIdx;
  state.ballNumber = turn.ballNumber;
  state.isSpectating = (state.myIdx !== turn.playerIdx);
  window.Game.startNextBall(state);
  window.UI.refreshHUD();
  window.UI.hideBallOverlay();
  if (guestConn) {
    guestConn.send({
      type: 'turn_start',
      playerIdx: turn.playerIdx,
      ballNumber: turn.ballNumber,
    });
  }
}

function hostHandleBallLost(playerIdx, gotExtraBall) {
  if (gameMode === 'guest') return;
  const state = window.GameState;
  if (state.currentPlayerIdx !== playerIdx) return; // stale
  if (gotExtraBall) {
    // Same player keeps the turn; preserve mission progress (extra ball perk)
    if (guestConn) guestConn.send({ type: 'extra_ball', playerIdx });
    setTimeout(() => {
      window.Game.startNextBall(state, { keepMissions: true });
      window.UI.refreshHUD();
    }, 1200);
  } else {
    matchStep++;
    // UI's refreshHUD shows the overlay based on phase='ball-lost'; just wait + advance.
    setTimeout(() => hostBeginTurn(), 2200);
  }
}

function hostFinishMatch() {
  const state = window.GameState;
  state.phase = 'match-over';
  window.UI.showMatchOverlay(state);
  if (guestConn) {
    guestConn.send({
      type: 'match_complete',
      scores: state.players.map(p => p.score),
    });
  }
}

// ============ Message handlers ============
function onGuestMessage(data) {
  // Host receives from guest
  switch (data.type) {
    case 'state':
      applyStateSnapshot(window.GameState, data.snap);
      break;
    case 'score_event':
      replayScoreEvent(window.GameState, data.ev);
      break;
    case 'ball_lost':
      hostHandleBallLost(1, !!data.extraBall);
      break;
  }
}

function onHostMessage(data) {
  // Guest receives from host
  switch (data.type) {
    case 'accepted':
      document.getElementById('guest-status').textContent =
        "You're in! Waiting for the host to start the match…";
      break;
    case 'denied':
      document.getElementById('guest-status').textContent = data.reason || 'Host denied entry.';
      try { hostConn.close(); } catch {}
      break;
    case 'match_start': {
      window.GameState = window.Game.createGameState({
        players: data.players, isHost: false,
      });
      window.GameState.myIdx = data.yourIdx;
      attachStateHooks(window.GameState);
      window.App.showScreen('game');
      window.UI.refreshHUD();
      window.Game.startGameLoop();
      window.Game.requestWakeLock();
      break;
    }
    case 'turn_start': {
      const state = window.GameState;
      state.currentPlayerIdx = data.playerIdx;
      state.ballNumber = data.ballNumber;
      state.isSpectating = (state.myIdx !== data.playerIdx);
      window.Game.startNextBall(state);
      window.UI.refreshHUD();
      window.UI.hideBallOverlay();
      break;
    }
    case 'extra_ball': {
      const state = window.GameState;
      state.isSpectating = (state.myIdx !== data.playerIdx);
      window.Game.startNextBall(state, { keepMissions: true });
      window.UI.refreshHUD();
      window.UI.hideBallOverlay();
      break;
    }
    case 'state':
      applyStateSnapshot(window.GameState, data.snap);
      break;
    case 'score_event':
      replayScoreEvent(window.GameState, data.ev);
      break;
    case 'match_complete': {
      const state = window.GameState;
      for (let i = 0; i < state.players.length; i++) state.players[i].score = data.scores[i];
      state.phase = 'match-over';
      window.UI.showMatchOverlay(state);
      break;
    }
  }
}

// ============ State snapshot streaming ============
function attachStateHooks(state) {
  state.onEvent = (ev) => {
    if (state.isSpectating) return;
    if (ev.type === 'ball-lost') {
      const isExtra = !!ev.extraBall;
      if (gameMode === 'host' || gameMode === 'solo') {
        hostHandleBallLost(state.currentPlayerIdx, isExtra);
      } else if (gameMode === 'guest') {
        hostConn?.send({ type: 'ball_lost', extraBall: isExtra });
      }
    }
    // Score events are propagated implicitly via state snapshots.
  };
}

let lastBroadcastBall = null;
function tickNetwork(dt) {
  const state = window.GameState;
  if (!state) return;
  if (state.isSpectating) return;
  if (gameMode === 'solo') return;
  // Only stream if there's an opponent
  if (state.players.length < 2) return;
  stateAccumulator += dt;
  if (stateAccumulator < STATE_INTERVAL) return;
  stateAccumulator = 0;
  const snap = makeSnapshot(state);
  const msg = { type: 'state', snap };
  if (gameMode === 'host') guestConn?.send(msg);
  else if (gameMode === 'guest') hostConn?.send(msg);
}

function makeSnapshot(state) {
  const b = state.ball;
  return {
    ball: b ? {
      x: b.x, y: b.y, vx: b.vx, vy: b.vy, alive: b.alive,
      captured: b.captured ? (b.captured === state.table.wormhole ? 'wh' : 'bh') : null,
    } : null,
    flippers: {
      la: state.table.flippers.left.angle,
      ra: state.table.flippers.right.angle,
    },
    plunger: state.table.plunger.pullDist,
    drops: state.table.dropTargets.map(d => d.down ? 1 : 0).join(''),
    lanes: state.table.lanes.map(l => l.lit ? 1 : 0).join(''),
    bumperHits: state.table.bumpers.map(b => b.hits),
    scores: state.players.map(p => p.score),
    jackpotRem: Math.max(0, state.missions.wormholeJackpotEnd - state.timeNow),
    engineerRem: state.missions.engineerActive ? Math.max(0, state.missions.engineerMultEnd - state.timeNow) : 0,
    engineerActive: state.missions.engineerActive,
    spaceLit: state.missions.spaceLitCount,
    phase: state.phase,
    ball_num: state.ballNumber,
  };
}

function applyStateSnapshot(state, snap) {
  if (!snap) return;
  if (snap.ball) {
    if (!state.ball) state.ball = window.SimPinball.createBall(snap.ball.x, snap.ball.y);
    state.ball.x = snap.ball.x;
    state.ball.y = snap.ball.y;
    state.ball.vx = snap.ball.vx;
    state.ball.vy = snap.ball.vy;
    state.ball.alive = snap.ball.alive;
    if (snap.ball.captured === 'wh') state.ball.captured = state.table.wormhole;
    else if (snap.ball.captured === 'bh') state.ball.captured = state.table.blackHole;
    else state.ball.captured = null;
  } else {
    state.ball = null;
  }
  state.table.flippers.left.angle = snap.flippers.la;
  state.table.flippers.right.angle = snap.flippers.ra;
  state.table.plunger.pullDist = snap.plunger;
  for (let i = 0; i < state.table.dropTargets.length; i++) {
    state.table.dropTargets[i].down = snap.drops[i] === '1';
  }
  for (let i = 0; i < state.table.lanes.length; i++) {
    state.table.lanes[i].lit = snap.lanes[i] === '1';
  }
  // Bumper flash: trigger when hits delta is positive
  for (let i = 0; i < state.table.bumpers.length; i++) {
    const oldH = state.table.bumpers[i].hits;
    const newH = snap.bumperHits[i];
    if (newH > oldH) state.bumperFlash[i] = 1.0;
    state.table.bumpers[i].hits = newH;
  }
  for (let i = 0; i < state.players.length; i++) state.players[i].score = snap.scores[i];
  state.missions.wormholeJackpotEnd = state.timeNow + snap.jackpotRem;
  state.missions.engineerMultEnd = state.timeNow + snap.engineerRem;
  state.missions.engineerActive = snap.engineerActive;
  state.missions.spaceLitCount = snap.spaceLit;
  state.phase = snap.phase;
  state.ballNumber = snap.ball_num;
  window.UI.refreshHUD();
}

function replayScoreEvent(state, ev) {
  // Spectator-side replay of score popup / particles
  // (currently unused — snapshot stream is enough for v1)
}

// ============ Teardown ============
function teardownNetwork() {
  try { guestConn?.close(); } catch {}
  try { hostConn?.close(); } catch {}
  try { peer?.destroy(); } catch {}
  guestConn = null;
  hostConn = null;
  peer = null;
  gameMode = 'idle';
  matchOrder = [];
  matchStep = 0;
  window.Game.releaseWakeLock();
}

// ============ Public API ============
window.Network = {
  startHosting,
  joinAsGuest,
  startSolo,
  startMatch,
  acceptKnock,
  denyKnock,
  teardownNetwork,
  tickNetwork,
  setMyName,
  refreshHostLobby,
  getMode: () => gameMode,
};
