// app.js — screen routing, button wiring, ?invite param detection.

const App = {
  currentScreen: 'landing',
};

function showScreen(name) {
  App.currentScreen = name;
  document.body.dataset.screen = name;
  for (const el of document.querySelectorAll('.screen')) {
    el.classList.toggle('active', el.id === `screen-${name}`);
  }
}

function getNameInputValue() {
  // Use whichever name input is on the active screen
  const ids = ['player-name', 'player-name-guest'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && el.value.trim()) return el.value.trim();
  }
  return '';
}

document.addEventListener('DOMContentLoaded', () => {
  window.UI.init();
  window.Game.bindTouchZones();

  // Detect invite link
  const params = new URLSearchParams(location.search);
  const inviteId = params.get('invite');
  if (inviteId) {
    showScreen('lobby-guest');
    // Auto-attempt connect once name is provided
    document.getElementById('btn-join-game').addEventListener('click', () => {
      const name = getNameInputValue() || 'Anonymous Cadet';
      window.Network.setMyName(name);
      window.Network.joinAsGuest(inviteId);
      document.getElementById('btn-join-game').disabled = true;
    });
  } else {
    showScreen('landing');
  }

  // ===== Landing buttons =====
  const btnSolo = document.getElementById('btn-play-solo');
  if (btnSolo) btnSolo.addEventListener('click', () => {
    const name = getNameInputValue() || 'Player 1';
    window.Network.setMyName(name);
    window.Network.startSolo();
  });

  const btnHost = document.getElementById('btn-host-game');
  if (btnHost) btnHost.addEventListener('click', () => {
    const name = getNameInputValue() || 'Player 1';
    window.Network.setMyName(name);
    showScreen('lobby-host');
    window.Network.startHosting();
    window.Network.refreshHostLobby();
  });

  // ===== Lobby buttons =====
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const el = document.getElementById('invite-link');
    el.select();
    el.setSelectionRange(0, 99999);
    try {
      navigator.clipboard.writeText(el.value);
      const btn = document.getElementById('btn-copy-link');
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch {}
  });

  document.getElementById('btn-accept-knock').addEventListener('click', () => window.Network.acceptKnock());
  document.getElementById('btn-deny-knock').addEventListener('click', () => window.Network.denyKnock());
  document.getElementById('btn-start-game').addEventListener('click', () => window.Network.startMatch());
  document.getElementById('btn-host-back').addEventListener('click', () => {
    window.Network.teardownNetwork();
    showScreen('landing');
  });

  // ===== Game buttons =====
  document.getElementById('btn-leave-game').addEventListener('click', () => {
    window.Network.teardownNetwork();
    showScreen('landing');
  });
  document.getElementById('btn-play-again').addEventListener('click', () => {
    window.UI.hideMatchOverlay();
    const mode = window.Network.getMode();
    if (mode === 'solo') window.Network.startSolo();
    else if (mode === 'host') window.Network.startMatch();
    // Guest can't restart on their own; host's match_start will rebuild GameState.
  });
});

window.App = {
  showScreen,
  getScreen: () => App.currentScreen,
};
