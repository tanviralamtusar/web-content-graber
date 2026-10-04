// Service worker: injects the capture script, fetches cross-origin resources
// for it (extension fetches are not subject to page CORS), and saves results.

const DEFAULT_OPTS = {
  autoScroll: true,
  inlineAssets: true,
  skipUnusedCssAssets: true,
  removeScripts: true,
  saveAs: true,
  scope: 'auto',
  maxResourceMB: 15
};

const MIME = {
  html: 'text/html;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  text: 'text/plain;charset=utf-8'
};

async function getOpts(overrides = {}) {
  const { opts } = await chrome.storage.local.get('opts');
  return { ...DEFAULT_OPTS, ...(opts || {}), ...overrides };
}

// ---------- capture orchestration ----------

async function startCapture(tabId, mode, overrides) {
  const opts = await getOpts(overrides);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/capture.js'] });
  // Fire and forget: the page reports back with a 'captured' message, which
  // wakes this worker even if it was suspended during a long capture/pick.
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (mode, opts) => { window.__contentGrabber.start(mode, opts); },
    args: [mode, opts]
  });
}

async function handleCaptured(msg) {
  const { mode, opts } = msg;
  if (mode === 'images') {
    const n = await downloadImages(msg.images, msg.folder);
    broadcast({ type: 'progress', text: `Started ${n} image download(s).`, pct: 100, done: true });
    return;
  }
  await saveText(msg.content, msg.filename, MIME[mode] || MIME.text, opts.saveAs);
  broadcast({ type: 'progress', text: `Saved ${msg.filename} (${formatSize(msg.content.length)})`, pct: 100, done: true });
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function formatSize(chars) {
  return chars > 1048576 ? (chars / 1048576).toFixed(1) + ' MB' : Math.ceil(chars / 1024) + ' KB';
}

// ---------- downloads (blob URLs are made in an offscreen document) ----------

const blobUrls = new Map(); // downloadId -> blob URL

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create blob URLs so captured pages can be downloaded.'
    });
  } catch (e) {
    if (!String(e.message).includes('single offscreen')) throw e;
  }
}

async function offscreen(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!res || res.error) throw new Error(res ? res.error : 'Offscreen document did not respond');
  return res;
}

async function saveText(content, filename, mime, saveAs) {
  const { url } = await offscreen({ type: 'make-blob', content, mime });
  const id = await chrome.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
  blobUrls.set(id, url);
}

async function downloadImages(images, folder) {
  const used = new Set();
  let started = 0;
  for (let i = 0; i < images.length; i += 4) {
    await Promise.all(images.slice(i, i + 4).map(async (src) => {
      try {
        const { url, contentType } = await offscreen({ type: 'fetch-blob', url: src });
        const name = uniqueName(imageName(src, contentType), used);
        const id = await chrome.downloads.download({ url, filename: `${folder}/${name}`, saveAs: false, conflictAction: 'uniquify' });
        blobUrls.set(id, url);
        started++;
      } catch (e) {
        console.warn('Image download failed', src, e);
      }
    }));
    broadcast({ type: 'progress', text: `Downloading images ${Math.min(i + 4, images.length)}/${images.length}`, pct: Math.round(100 * Math.min(i + 4, images.length) / images.length) });
  }
  return started;
}

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp'
};

function imageName(src, contentType) {
  let base = 'image';
  try {
    if (!src.startsWith('data:')) base = decodeURIComponent(new URL(src).pathname.split('/').pop()) || 'image';
  } catch {}
  base = base.replace(/[\\/:*?"<>|\x00-\x1f~]/g, '_').replace(/^\.+/, '').slice(0, 100) || 'image';
  const ext = EXT_BY_TYPE[(contentType || '').split(';')[0].trim().toLowerCase()];
  if (ext && !base.toLowerCase().endsWith('.' + ext) && !(ext === 'jpg' && /\.jpe?g$/i.test(base))) {
    base = base.replace(/\.(jpe?g|png|gif|webp|svg|avif|ico|bmp)$/i, '') + '.' + ext;
  }
  return base;
}

function uniqueName(name, used) {
  let candidate = name;
  const dot = name.lastIndexOf('.');
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (!state || !blobUrls.has(id) || state.current === 'in_progress') return;
  const url = blobUrls.get(id);
  blobUrls.delete(id);
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => {});
});

// ---------- resource fetching for the content script ----------

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchForPage({ url, as, maxBytes }) {
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!res.ok) return { ok: false, status: res.status };
  const contentType = res.headers.get('content-type') || '';
  if (as === 'text') {
    return { ok: true, text: await res.text(), url: res.url, contentType };
  }
  const buf = await res.arrayBuffer();
  if (maxBytes && buf.byteLength > maxBytes) return { ok: false, tooLarge: true };
  const mime = contentType.split(';')[0].trim() || 'application/octet-stream';
  return { ok: true, dataUrl: `data:${mime};base64,${toBase64(buf)}` };
}

// ---------- messages, menus, shortcuts ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'start':
      startCapture(msg.tabId, msg.mode, msg.opts)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: friendlyError(e) }));
      return true;
    case 'fetch':
      fetchForPage(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'captured':
      handleCaptured(msg).catch((e) => broadcast({ type: 'progress', text: 'Save failed: ' + e.message, error: true, done: true }));
      return;
  }
});

function friendlyError(e) {
  const m = String(e && e.message || e);
  if (/cannot be scripted|chrome:\/\/|edge:\/\/|extensions gallery|Cannot access/i.test(m)) {
    return 'This page cannot be captured (browser pages and the extension store are protected).';
  }
  return m;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'html', title: 'Save complete page (.html)', contexts: ['page', 'frame', 'selection', 'image', 'link'] });
    chrome.contextMenus.create({ id: 'markdown', title: 'Save page as Markdown (.md)', contexts: ['page', 'frame', 'selection', 'image', 'link'] });
    chrome.contextMenus.create({ id: 'images', title: 'Download all images on page', contexts: ['page', 'frame', 'selection', 'image', 'link'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  startCapture(tab.id, info.menuItemId).catch((e) => console.warn(e));
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = command === 'save-markdown' ? 'markdown' : 'html';
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target) startCapture(target.id, mode).catch((e) => console.warn(e));
});
