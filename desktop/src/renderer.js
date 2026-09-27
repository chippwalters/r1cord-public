// index.html is the start screen (until the core answers) and, as index.html#prefs, the
// desktop Preferences; which one shows is CSS (:target), so neither flashes before this runs.
const startingEl = document.getElementById('starting');
const statusEl = document.getElementById('status');
const detailEl = document.getElementById('detail');
const noteEl = document.getElementById('note');
const retryEl = document.getElementById('retry');
const prefsForm = document.getElementById('prefs-form');
const prefsNote = document.getElementById('prefs-note');

const desktop = window.desktop;

/** state: { phase: 'starting'|'ready'|'error', message, detail, note } from main. */
function showStartState(state) {
  if (!state || typeof state !== 'object' || !startingEl) return;
  const failed = state.phase === 'error';
  startingEl.classList.toggle('failed', failed);
  statusEl.textContent = state.message || 'Starting R1CORD…';
  detailEl.textContent = state.detail || '';
  detailEl.hidden = !failed || !state.detail;
  noteEl.textContent = state.note || '';
  noteEl.hidden = !state.note;
  retryEl.hidden = !failed;
  retryEl.disabled = false;
  retryEl.textContent = 'Retry';
}

if (desktop && typeof desktop.onStatus === 'function') {
  desktop.onStatus(showStartState);
}

// Status sent before this page loaded is gone: ask for the current state once.
if (desktop && typeof desktop.getStartState === 'function') {
  desktop.getStartState().then((result) => {
    if (result && result.success) showStartState(result.data);
  });
}

if (retryEl && desktop && typeof desktop.retryStart === 'function') {
  retryEl.addEventListener('click', async () => {
    retryEl.disabled = true;
    retryEl.textContent = 'Retrying…';
    const result = await desktop.retryStart();
    if (result && result.success) showStartState(result.data);
    else {
      retryEl.disabled = false;
      retryEl.textContent = 'Retry';
    }
  });
}

async function fillPreferences() {
  if (!desktop || typeof desktop.getSettings !== 'function') return;
  const result = await desktop.getSettings();
  if (!result.success) {
    if (prefsNote) prefsNote.textContent = result.error;
    return;
  }
  const mode = result.data.startupMode;
  for (const input of document.querySelectorAll('input[name="startupMode"]')) {
    input.checked = input.value === mode;
  }
  const apply = result.data.lastStartupApply;
  if (apply && apply.message && prefsNote) prefsNote.textContent = apply.message;
}

fillPreferences();

if (prefsForm) {
  prefsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const mode = new FormData(prefsForm).get('startupMode');
    const result = await desktop.setStartupMode(mode);
    if (!result.success) {
      prefsNote.textContent = result.error;
      return;
    }
    const apply = result.data && result.data.lastStartupApply;
    prefsNote.textContent = (apply && apply.message) || 'Saved.';
  });
}
