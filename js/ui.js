// ui.js — DOM HUD, overlays, localStorage. Reads from window.GameState; doesn't drive physics.

const UI = {
  els: {},
};

function uiInit() {
  UI.els.ballLabel = document.getElementById('ball-label');
  UI.els.missionLabel = document.getElementById('mission-label');
  UI.els.turnLabel = document.getElementById('turn-label');
  UI.els.playerList = document.getElementById('game-player-list');
  UI.els.spectateBanner = document.getElementById('spectate-banner');
  UI.els.spectateText = document.getElementById('spectate-text');
  UI.els.ballOverlay = document.getElementById('ball-overlay');
  UI.els.ballOverlayTitle = document.getElementById('ball-overlay-title');
  UI.els.ballOverlaySub = document.getElementById('ball-overlay-sub');
  UI.els.matchOverlay = document.getElementById('match-overlay');
  UI.els.matchOverlayTitle = document.getElementById('match-overlay-title');
  UI.els.matchOverlaySub = document.getElementById('match-overlay-sub');
  UI.els.matchScoreboard = document.getElementById('match-scoreboard');
  UI.els.btnNextBall = document.getElementById('btn-next-ball');
  UI.els.btnPlayAgain = document.getElementById('btn-play-again');
  UI.els.touchZones = document.getElementById('touch-zones');

  // Restore player name
  const savedName = localStorage.getItem('pinball_name');
  if (savedName) {
    const n1 = document.getElementById('player-name');
    const n2 = document.getElementById('player-name-guest');
    if (n1) n1.value = savedName;
    if (n2) n2.value = savedName;
  }
  // Persist as user types
  ['player-name', 'player-name-guest'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => localStorage.setItem('pinball_name', el.value.trim()));
  });

  // Onboarding tip
  if (!localStorage.getItem('pinball_tip_dismissed')) {
    const tip = document.getElementById('onboarding-tip');
    if (tip) tip.style.display = '';
  }
  const dismissBtn = document.getElementById('btn-dismiss-tip');
  if (dismissBtn) dismissBtn.addEventListener('click', () => {
    localStorage.setItem('pinball_tip_dismissed', '1');
    document.getElementById('onboarding-tip').style.display = 'none';
  });
}

function refreshHUD() {
  const state = window.GameState;
  if (!state) return;

  // Ball counter
  if (state.ballNumber > state.totalBalls) {
    UI.els.ballLabel.textContent = `Game Over`;
  } else {
    UI.els.ballLabel.textContent = `Ball ${state.ballNumber} / ${state.totalBalls}`;
  }

  // Mission label
  let mission = '';
  if (state.timeNow < state.missions.wormholeJackpotEnd) {
    mission = '★ JACKPOT LIT';
  } else if (state.missions.engineerActive) {
    mission = '★ ENGINEER ×2';
  } else if (state.missions.spaceLitCount > 0) {
    mission = `S·P·A·C·E ${state.missions.spaceLitCount}/5`;
  }
  if (UI.els.missionLabel.textContent !== mission) UI.els.missionLabel.textContent = mission;

  // Turn label
  if (state.players.length > 1) {
    const active = state.players[state.currentPlayerIdx];
    if (state.currentPlayerIdx === state.myIdx) UI.els.turnLabel.textContent = 'Your turn';
    else UI.els.turnLabel.textContent = `${active.name}'s turn`;
  } else {
    UI.els.turnLabel.textContent = '';
  }

  // Scoreboard
  if (UI.els.playerList) {
    const html = state.players.map((p, i) => {
      const cls = [];
      if (i === state.myIdx) cls.push('is-you');
      if (i === state.currentPlayerIdx) cls.push('is-turn');
      return `<li class="${cls.join(' ')}">
        <span class="player-dot" style="background:${p.color}"></span>
        <span class="player-name">${escapeHtml(p.name)}</span>
        <span class="player-score">${formatScore(p.score)}</span>
      </li>`;
    }).join('');
    if (UI.els.playerList.dataset.cache !== html) {
      UI.els.playerList.innerHTML = html;
      UI.els.playerList.dataset.cache = html;
    }
  }

  // Spectate banner
  if (state.isSpectating) {
    UI.els.spectateBanner.style.display = '';
    const active = state.players[state.currentPlayerIdx];
    UI.els.spectateText.textContent = `Watching ${active ? active.name : 'opponent'}…`;
  } else {
    UI.els.spectateBanner.style.display = 'none';
  }

  // Hide touch zones when spectating (no input from this player)
  if (UI.els.touchZones) {
    UI.els.touchZones.style.display = state.isSpectating ? 'none' : '';
  }

  // Auto-show ball-lost / extra-ball overlay (data-driven from state.phase)
  const isExtra = state.phase === 'extra-ball';
  const isLost = state.phase === 'ball-lost';
  if ((isLost || isExtra) && UI.els.ballOverlay.style.display === 'none') {
    const active = state.players[state.currentPlayerIdx];
    if (isExtra) {
      UI.els.ballOverlayTitle.textContent = 'Extra Ball!';
      UI.els.ballOverlaySub.innerHTML = active
        ? `${escapeHtml(active.name)} — keep going`
        : 'Keep going';
    } else {
      UI.els.ballOverlayTitle.textContent = 'Ball Lost';
      UI.els.ballOverlaySub.innerHTML = active
        ? `${escapeHtml(active.name)} — <strong>${formatScore(active.score)}</strong>`
        : '';
    }
    UI.els.btnNextBall.style.display = 'none';
    UI.els.ballOverlay.style.display = '';
  } else if (!isLost && !isExtra && UI.els.ballOverlay.style.display !== 'none' && state.phase !== 'match-over') {
    UI.els.ballOverlay.style.display = 'none';
  }
}

function formatScore(n) {
  return n.toLocaleString('en-US');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showBallOverlay(opts = {}) {
  UI.els.ballOverlayTitle.textContent = opts.title || 'Ball Lost';
  UI.els.ballOverlaySub.innerHTML = opts.sub || '';
  UI.els.ballOverlay.style.display = '';
  // The button label depends on whether next ball is mine or opponent's
  if (opts.buttonText) UI.els.btnNextBall.textContent = opts.buttonText;
  UI.els.btnNextBall.style.display = opts.hideButton ? 'none' : '';
}

function hideBallOverlay() {
  UI.els.ballOverlay.style.display = 'none';
}

function showMatchOverlay(state) {
  UI.els.matchOverlay.style.display = '';
  const sorted = state.players.slice().sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  if (state.players.length > 1) {
    UI.els.matchOverlayTitle.textContent = 'Match Complete!';
    if (sorted[0].score === sorted[1].score) {
      UI.els.matchOverlaySub.innerHTML = `Tied at <strong>${formatScore(winner.score)}</strong>`;
    } else {
      UI.els.matchOverlaySub.innerHTML = `${escapeHtml(winner.name)} wins with <strong>${formatScore(winner.score)}</strong>`;
    }
  } else {
    UI.els.matchOverlayTitle.textContent = 'Game Over';
    UI.els.matchOverlaySub.innerHTML = `Final score: <strong>${formatScore(winner.score)}</strong>`;
  }
  UI.els.matchScoreboard.innerHTML = sorted.map(p => `
    <li>
      <span class="player-name">${escapeHtml(p.name)}</span>
      <span class="player-score">${formatScore(p.score)}</span>
    </li>
  `).join('');
}

function hideMatchOverlay() {
  UI.els.matchOverlay.style.display = 'none';
}

window.UI = {
  init: uiInit,
  refreshHUD,
  showBallOverlay,
  hideBallOverlay,
  showMatchOverlay,
  hideMatchOverlay,
  formatScore,
  escapeHtml,
};
