const OPTION_IDS = ['autoScroll', 'inlineAssets', 'skipUnusedCssAssets', 'removeScripts', 'saveAs'];
const DEFAULTS = { autoScroll: true, inlineAssets: true, skipUnusedCssAssets: true, removeScripts: true, saveAs: true, scope: 'auto' };

const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll('button[data-mode]')];
let tab;

function setStatus(text, { pct, error } = {}) {
  $('status').textContent = text;
  $('status').classList.toggle('error', !!error);
  if (pct != null) $('fill').style.width = pct + '%';
}

function readOpts() {
  const opts = { scope: $('scope').value };
  for (const id of OPTION_IDS) opts[id] = $(id).checked;
  return opts;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('page').textContent = tab ? tab.title || tab.url : '';
  $('page').title = tab ? tab.url : '';

  const { opts } = await chrome.storage.local.get('opts');
  const o = { ...DEFAULTS, ...(opts || {}) };
  for (const id of OPTION_IDS) $(id).checked = !!o[id];
  $('scope').value = o.scope;
  $('skipUnusedCssAssets').disabled = !o.inlineAssets;

  for (const el of [...OPTION_IDS.map($), $('scope')]) {
    el.addEventListener('change', () => {
      $('skipUnusedCssAssets').disabled = !$('inlineAssets').checked;
      chrome.storage.local.set({ opts: readOpts() });
    });
  }

  for (const btn of buttons) btn.addEventListener('click', () => run(btn.dataset.mode));
}

async function run(mode) {
  if (!tab) return;
  const opts = readOpts();
  buttons.forEach((b) => (b.disabled = true));
  setStatus('Starting…', { pct: 2 });
  const res = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, mode, opts });
  if (!res || !res.ok) {
    setStatus(res ? res.error : 'Could not start capture.', { pct: 0, error: true });
    buttons.forEach((b) => (b.disabled = false));
    return;
  }
  // The popup must close so the user can click on the page.
  if (opts.scope === 'pick') window.close();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'progress') return;
  setStatus(msg.text, { pct: msg.pct, error: msg.error });
  if (msg.done) buttons.forEach((b) => (b.disabled = false));
});

init();
