const statusEl = document.getElementById('status');
const startingEl = document.getElementById('starting');
const prefsEl = document.getElementById('prefs');
const prefsForm = document.getElementById('prefs-form');
const prefsNote = document.getElementById('prefs-note');

function showPreferences(show) {
  if (startingEl) startingEl.hidden = show;
  if (prefsEl) prefsEl.hidden = !show;
}

function isPreferencesView() {
  return window.location.hash === '#prefs';
}

showPreferences(isPreferencesView());
window.addEventListener('hashchange', () => showPreferences(isPreferencesView()));

if (window.desktop && typeof window.desktop.onStatus === 'function') {
  window.desktop.onStatus((message) => {
    if (statusEl) statusEl.textContent = message;
  });
}

async function fillPreferences() {
  if (!window.desktop || typeof window.desktop.getSettings !== 'function') return;
  const result = await window.desktop.getSettings();
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
    const result = await window.desktop.setStartupMode(mode);
    if (!result.success) {
      prefsNote.textContent = result.error;
      return;
    }
    const apply = result.data && result.data.lastStartupApply;
    prefsNote.textContent = (apply && apply.message) || 'Saved.';
  });
}
