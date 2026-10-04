// Content script: snapshots the live (rendered) DOM of the page.
// Injected on demand by background.js; safe to inject more than once.

(() => {
  if (window.__contentGrabber) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
  const progress = (text, pct) => send({ type: 'progress', text, pct });

  let busy = false;

  // =====================================================================
  // Entry point
  // =====================================================================

  async function start(mode, opts) {
    if (busy) return progress('A capture is already running on this page…');
    busy = true;
    try {
      let target = null;
      if (opts.scope === 'pick') {
        progress('Click the part of the page you want to save (Esc to cancel)…', 0);
        target = await pickElement();
        if (!target) return send({ type: 'progress', text: 'Cancelled.', done: true });
      }
      if (mode !== 'text') {
        // Capture at the top of the page: sticky headers / affixed sidebars
        // switch to position:fixed when scrolled and would be saved that way.
        scrollers = [document.scrollingElement || document.documentElement, largestInnerScroller()].filter(Boolean);
        savedScroll = scrollers.map((el) => el.scrollTop);
        if (opts.autoScroll) await autoScroll(scrollers);
        for (const el of scrollers) el.scrollTop = 0;
        await settle();
      }

      const title = cleanFileName(document.title || location.hostname || 'page');
      let result;
      if (mode === 'html') {
        const content = await captureHtml(target, opts);
        result = { content, filename: title + '.html' };
      } else if (mode === 'markdown') {
        progress('Converting to Markdown…', 50);
        result = { content: captureMarkdown(target || (opts.scope === 'page' ? document.body : findMainContent())), filename: title + '.md' };
      } else if (mode === 'text') {
        const root = target || (opts.scope === 'page' ? document.body : findMainContent());
        result = { content: header('text') + root.innerText.replace(/\n{3,}/g, '\n\n').trim() + '\n', filename: title + '.txt' };
      } else if (mode === 'images') {
        progress('Collecting images…', 50);
        result = { images: collectImages(target || document.body), folder: title + ' - images' };
        if (!result.images.length) return send({ type: 'progress', text: 'No images found.', done: true });
      }
      progress('Saving…', 95);
      try {
        await chrome.runtime.sendMessage({ type: 'captured', mode, opts, ...result });
      } catch (e) {
        // Messages are capped at 64 MB; save huge pages straight from the page instead.
        if (!result.content) throw e;
        pageDownload(result.content, result.filename, mode);
        send({ type: 'progress', text: `Saved ${result.filename} to your Downloads folder.`, pct: 100, done: true });
      }
    } catch (e) {
      console.error('[Web Content Grabber]', e);
      send({ type: 'progress', text: 'Capture failed: ' + (e && e.message || e), error: true, done: true });
    } finally {
      scrollers.forEach((el, i) => { el.scrollTop = savedScroll[i]; });
      scrollers = [];
      busy = false;
    }
  }

  let scrollers = [];
  let savedScroll = [];

  // Let scroll listeners (usually rAF-throttled, then a framework re-render) catch up.
  async function settle() {
    window.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(400);
  }

  function pageDownload(content, filename, mode) {
    const type = { html: 'text/html', markdown: 'text/markdown', text: 'text/plain' }[mode] + ';charset=utf-8';
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.documentElement.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function cleanFileName(s) {
    return s.replace(/[\\/:*?"<>|\x00-\x1f~]/g, '_').replace(/\s+/g, ' ').trim()
      .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'page';
  }

  function header(kind) {
    const when = new Date().toLocaleString();
    if (kind === 'text') return `${document.title}\nSource: ${location.href}\nSaved: ${when}\n\n`;
    return `# ${document.title}\n\n> Source: <${location.href}>  \n> Saved: ${when}\n\n`;
  }

  // =====================================================================
  // Lazy content: scroll the page (and its main inner scroller) to the end
  // =====================================================================

  async function autoScroll(targets) {
    progress('Scrolling to load lazy content…', 5);
    for (const el of targets) {
      const deadline = Date.now() + 15000;
      let stable = 0;
      let lastHeight = 0;
      while (Date.now() < deadline) {
        el.scrollTop += Math.max(300, el.clientHeight * 0.8);
        await sleep(120);
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        if (atBottom) {
          if (el.scrollHeight === lastHeight && ++stable >= 3) break;
          await sleep(350);
        } else {
          stable = 0;
        }
        lastHeight = el.scrollHeight;
      }
    }
    await waitForImages(5000);
  }

  function largestInnerScroller() {
    let best = null;
    let bestArea = window.innerWidth * window.innerHeight * 0.3;
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  function waitForImages(timeout) {
    const pending = [...document.images].filter((img) => !img.complete);
    if (!pending.length) return Promise.resolve();
    progress(`Waiting for ${pending.length} image(s) to load…`, 10);
    return Promise.race([
      Promise.all(pending.map((img) => new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); }))),
      sleep(timeout)
    ]);
  }

  // =====================================================================
  // Element picker
  // =====================================================================

  function pickElement() {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:3px;transition:all .05s;';
      const tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;';
      tip.textContent = 'Click to save this area · ↑ / ↓ to widen / narrow · Esc to cancel';
      document.documentElement.append(box, tip);

      let current = null;
      const trail = [];
      const show = (el) => {
        current = el;
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
      };
      const onMove = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== box && el !== tip && el !== document.documentElement) { trail.length = 0; show(el); }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        else if (e.key === 'ArrowUp' && current && current.parentElement && current.parentElement !== document.documentElement) {
          e.preventDefault(); trail.push(current); show(current.parentElement);
        } else if (e.key === 'ArrowDown' && trail.length) { e.preventDefault(); show(trail.pop()); }
        else if (e.key === 'Enter' && current) { e.preventDefault(); finish(current); }
      };
      const onClick = (e) => { e.preventDefault(); e.stopPropagation(); finish(current); };
      const block = (e) => { e.preventDefault(); e.stopPropagation(); };
      function finish(el) {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('mousedown', block, true);
        document.removeEventListener('mouseup', block, true);
        box.remove(); tip.remove();
        resolve(el);
      }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('mousedown', block, true);
      document.addEventListener('mouseup', block, true);
    });
  }

  // =====================================================================
  // Resource fetching (same-origin in page, everything else via background)
  // =====================================================================

  const cache = new Map();
  let active = 0;
  const queue = [];
  let fetchedCount = 0;

  function limited(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try { resolve(await fn()); } catch (e) { reject(e); } finally {
          active--;
          if (queue.length) queue.shift()();
        }
      };
      active < 8 ? run() : queue.push(run);
    });
  }

  function fetchResource(url, as, opts) {
    const key = as + '|' + url;
    if (!cache.has(key)) {
      cache.set(key, limited(() => doFetch(url, as, opts)).catch(() => null).then((r) => {
        fetchedCount++;
        if (fetchedCount % 10 === 0) progress(`Embedded ${fetchedCount} resources…`, Math.min(90, 20 + fetchedCount / 4));
        return r;
      }));
    }
    return cache.get(key);
  }

  async function doFetch(url, as, opts) {
    const maxBytes = (opts.maxResourceMB || 15) * 1048576;
    let local = url.startsWith('blob:') || url.startsWith('data:');
    try { local = local || new URL(url).origin === location.origin; } catch {}
    if (local) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) {
          if (as === 'text') return { text: await res.text(), url: res.url || url };
          const blob = await res.blob();
          return blob.size > maxBytes ? null : await blobToDataUrl(blob);
        }
      } catch {}
      if (url.startsWith('blob:') || url.startsWith('data:')) return null;
    }
    const res = await chrome.runtime.sendMessage({ type: 'fetch', url, as, maxBytes });
    if (!res || !res.ok) return null;
    return as === 'text' ? { text: res.text, url: res.url || url } : res.dataUrl;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function abs(url, base) {
    if (!url) return url;
    url = url.trim();
    if (/^(data|blob|javascript|mailto|tel|about):/i.test(url) || url.startsWith('#')) return url;
    try { return new URL(url, base || document.baseURI).href; } catch { return url; }
  }

  async function inlineUrl(url, base, opts) {
    const full = abs(url, base);
    if (!opts.inlineAssets || !full || !/^(https?|blob):/i.test(full)) return full;
    return (await fetchResource(full, 'dataurl', opts)) || full;
  }

  // =====================================================================
  // CSS processing: inline @import, embed url() assets
  // =====================================================================

  // A stylesheet can reference far more than the page uses (every
  // unicode-range font slice, sprite states, other breakpoints…). With
  // "skip unused" on, only assets in use are embedded; the rest keep their
  // absolute URL. (Resource Timing can't tell us: Chrome hides requests
  // made by cross-origin stylesheets, i.e. most CDN-hosted CSS.)
  const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
  const IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;
  const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/gi;

  // Image URLs referenced by the computed style of any element / pseudo-element.
  const usedImageCache = new WeakMap();
  function usedImages(doc) {
    if (usedImageCache.has(doc)) return usedImageCache.get(doc);
    const set = new Set();
    const view = doc.defaultView;
    const props = ['backgroundImage', 'listStyleImage', 'borderImageSource', 'maskImage', 'webkitMaskImage', 'content', 'cursor'];
    for (const el of doc.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = view.getComputedStyle(el, pseudo);
        for (const p of props) {
          const v = cs[p];
          if (v && v.includes('url(')) for (const m of v.matchAll(URL_RE)) set.add(m[1] ?? m[2] ?? m[3]);
        }
      }
    }
    usedImageCache.set(doc, set);
    return set;
  }

  // Did the browser load (or try to load) the face this @font-face block declares?
  function fontFaceUsed(block, doc) {
    const prop = (name) => {
      const m = block.match(new RegExp('(?:^|[;{\\s])' + name + '\\s*:\\s*([^;}]+)', 'i'));
      return m ? m[1].trim() : '';
    };
    const family = normFamily(prop('font-family'));
    if (!family || !doc.fonts) return true;
    const range = normRange(prop('unicode-range'));
    const weight = normWeight(prop('font-weight'));
    const style = normStyle(prop('font-style'));
    const matches = [...doc.fonts].filter((f) => normFamily(f.family) === family && normRange(f.unicodeRange) === range
      && normWeight(f.weight) === weight && normStyle(f.style) === style);
    return !matches.length || matches.some((f) => f.status !== 'unloaded');
  }
  const normFamily = (s) => s.replace(/^\s*['"]|['"]\s*$/g, '').trim().toLowerCase();
  const normWeight = (s) => (s || 'normal').toLowerCase().replace(/\bnormal\b/g, '400').replace(/\bbold\b/g, '700').replace(/\s+/g, ' ').trim();
  const normStyle = (s) => (s || 'normal').toLowerCase().split(/\s+/)[0];
  function normRange(s) {
    if (!s) return 'U+0-10FFFF';
    return s.split(',').map((part) => {
      let [lo, hi] = part.trim().toUpperCase().replace(/^U\+/, '').split('-');
      if (lo.includes('?')) { hi = lo.replace(/\?/g, 'F'); lo = lo.replace(/\?/g, '0'); }
      const h = (x) => parseInt(x, 16).toString(16).toUpperCase();
      return 'U+' + h(lo) + (hi ? '-' + h(hi) : '');
    }).join(',');
  }

  async function processCss(css, base, opts, depth = 0) {
    // @import → inline the imported sheet
    const imports = [...css.matchAll(IMPORT_RE)];
    if (imports.length) {
      const parts = await Promise.all(imports.map(async (m) => {
        const href = abs(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], base);
        const cond = (m[6] || '').trim();
        if (depth > 5) return `@import url("${href}") ${cond};`;
        const res = await fetchResource(href, 'text', opts);
        if (!res) return `@import url("${href}") ${cond};`;
        const inner = await processCss(res.text, res.url || href, opts, depth + 1);
        if (!cond) return inner;
        if (/^(layer|supports)/i.test(cond)) return `@import url("${href}") ${cond};`;
        return `@media ${cond} {\n${inner}\n}`;
      }));
      let i = 0;
      css = css.replace(IMPORT_RE, () => parts[i++]);
    }

    // url(...) → absolute, and embedded as data: when enabled and in use
    const doc = opts.doc || document;
    const faces = [...css.matchAll(FONT_FACE_RE)].map((m) => ({
      start: m.index, end: m.index + m[0].length, used: fontFaceUsed(m[0], doc)
    }));
    const inUse = (full, index) => {
      if (!opts.skipUnusedCssAssets || full.startsWith('blob:')) return true;
      const face = faces.find((f) => index >= f.start && index < f.end);
      return face ? face.used : usedImages(doc).has(full);
    };
    const values = await Promise.all([...css.matchAll(URL_RE)].map(async (m) => {
      const raw = m[1] ?? m[2] ?? m[3] ?? '';
      if (!raw || raw.startsWith('#') || raw.startsWith('data:')) return null;
      const full = abs(raw, base);
      if (opts.inlineAssets && /^(https?|blob):/i.test(full) && inUse(full, m.index)) {
        return (await fetchResource(full, 'dataurl', opts)) || full;
      }
      return full;
    }));
    let i = 0;
    return css.replace(URL_RE, (all) => {
      const v = values[i++];
      return v ? `url("${v.replace(/"/g, '%22')}")` : all;
    });
  }

  function rulesText(sheet) {
    try {
      return [...sheet.cssRules].map((r) => r.cssText).join('\n');
    } catch {
      return null;
    }
  }

  // =====================================================================
  // HTML snapshot
  // =====================================================================

  async function captureHtml(target, opts) {
    progress('Capturing page…', 15);
    let html = await snapshotDocument(document, opts, 0, target);
    const comment = `<!--\n Saved with Web Content Grabber\n Source: ${location.href.replace(/--/g, '-‐')}\n Saved: ${new Date().toISOString()}\n-->\n`;
    return html.replace(/^(<!DOCTYPE[^>]*>\n?)?/i, (d) => (d || '<!DOCTYPE html>\n') + comment);
  }

  async function snapshotDocument(doc, opts, depth, target) {
    opts = { ...opts, doc };
    const base = doc.baseURI;
    const originals = [doc.documentElement, ...doc.documentElement.querySelectorAll('*')];
    const clone = doc.documentElement.cloneNode(true);
    const clones = [clone, ...clone.querySelectorAll('*')];
    const tasks = [];
    const removals = [];
    processElements(originals, clones, { doc, base, opts, depth, tasks, removals });

    // Stylesheets attached from script (constructable stylesheets)
    if (doc.adoptedStyleSheets && doc.adoptedStyleSheets.length) {
      const st = doc.createElement('style');
      const text = doc.adoptedStyleSheets.map(rulesText).filter(Boolean).join('\n');
      tasks.push(processCss(text, base, opts).then((css) => { st.textContent = css; }));
      (clone.querySelector('head') || clone).append(st);
    }

    if (target) keepOnly(clone, clones[originals.indexOf(target)]);

    await Promise.all(tasks);
    for (const el of removals) el.remove();

    const head = clone.querySelector('head') || clone.insertBefore(doc.createElement('head'), clone.firstChild);
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    head.prepend(charset);

    const doctype = doc.doctype
      ? `<!DOCTYPE ${doc.doctype.name}${doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ''}${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ''}>\n`
      : '<!DOCTYPE html>\n';
    return doctype + clone.outerHTML;
  }

  // Fixes up each clone from its live original (form state, canvas pixels,
  // resolved image sources…). Async work is queued on ctx.tasks.
  function processElements(originals, clones, ctx) {
    const { doc, base, opts, depth, tasks, removals } = ctx;
    for (let i = 0; i < originals.length; i++) {
      const o = originals[i];
      const c = clones[i];
      if (!c || c.localName !== o.localName) break; // structure diverged; stop mapping
      const tag = o.localName;

      if (opts.removeScripts) {
        for (const attr of [...c.attributes]) {
          if (/^on/i.test(attr.name)) c.removeAttribute(attr.name);
        }
      }
      if (o.shadowRoot) c.prepend(snapshotShadow(o.shadowRoot, ctx));

      switch (tag) {
        case 'script':
          if (opts.removeScripts) removals.push(c);
          else if (c.hasAttribute('src')) c.setAttribute('src', abs(c.getAttribute('src'), base));
          continue;
        case 'base':
          removals.push(c);
          continue;
        case 'meta': {
          const equiv = (c.getAttribute('http-equiv') || '').toLowerCase();
          if (c.hasAttribute('charset') || equiv === 'content-security-policy' || equiv === 'refresh' || equiv === 'content-type') removals.push(c);
          continue;
        }
        case 'link':
          handleLink(o, c, base, opts, tasks, removals);
          continue;
        case 'style': {
          const text = c.textContent.trim() ? c.textContent : (o.sheet && rulesText(o.sheet)) || '';
          tasks.push(processCss(text, base, opts).then((css) => { c.textContent = css; }));
          continue;
        }
        case 'img': {
          let src = o.currentSrc || o.src;
          if (!src || (o.complete && o.naturalWidth === 0) || /^data:image\/gif/.test(src) && o.naturalWidth <= 1) {
            src = o.dataset.src || o.dataset.original || o.dataset.lazySrc || o.dataset.url || src;
          }
          for (const a of ['srcset', 'sizes', 'loading', 'decoding', 'data-src', 'data-srcset']) c.removeAttribute(a);
          if (src) {
            c.setAttribute('src', abs(src, base));
            tasks.push(inlineUrl(src, base, opts).then((v) => c.setAttribute('src', v)));
          }
          break;
        }
        case 'source':
          if (o.parentElement && o.parentElement.localName === 'picture') removals.push(c); // <img> keeps the chosen source
          else absAttr(c, ['src'], base);
          break;
        case 'input': {
          const type = (o.type || '').toLowerCase();
          if (type === 'checkbox' || type === 'radio') o.checked ? c.setAttribute('checked', '') : c.removeAttribute('checked');
          else if (type === 'image') tasks.push(inlineUrl(c.getAttribute('src'), base, opts).then((v) => v && c.setAttribute('src', v)));
          else if (type === 'password') c.removeAttribute('value');
          else if (type !== 'file') c.setAttribute('value', o.value);
          break;
        }
        case 'textarea':
          c.textContent = o.value;
          break;
        case 'option':
          o.selected ? c.setAttribute('selected', '') : c.removeAttribute('selected');
          break;
        case 'canvas':
          try {
            const img = doc.createElement('img');
            for (const a of c.attributes) img.setAttribute(a.name, a.value);
            img.setAttribute('src', o.toDataURL());
            if (!img.style.width) img.style.width = o.clientWidth + 'px';
            if (!img.style.height) img.style.height = o.clientHeight + 'px';
            c.replaceWith(img);
          } catch {} // tainted canvas: leave empty
          break;
        case 'iframe':
        case 'frame': {
          let inner = null;
          try { inner = o.contentDocument; } catch {}
          if (inner && inner.documentElement && depth < 5) {
            tasks.push(snapshotDocument(inner, opts, depth + 1).then((h) => {
              c.setAttribute('srcdoc', h);
              c.removeAttribute('src');
            }).catch(() => absAttr(c, ['src'], base)));
          } else {
            absAttr(c, ['src'], base);
          }
          break;
        }
        case 'video':
          absAttr(c, ['src'], base);
          if (c.hasAttribute('poster')) tasks.push(inlineUrl(c.getAttribute('poster'), base, opts).then((v) => c.setAttribute('poster', v)));
          break;
        case 'audio': case 'track': case 'embed':
          absAttr(c, ['src'], base);
          break;
        case 'object':
          absAttr(c, ['data'], base);
          break;
        case 'a': case 'area':
          absAttr(c, ['href'], base);
          break;
        case 'form':
          absAttr(c, ['action'], base);
          break;
        case 'image': // SVG <image>
          for (const a of ['href', 'xlink:href']) {
            if (c.hasAttribute(a)) tasks.push(inlineUrl(c.getAttribute(a), base, opts).then((v) => c.setAttribute(a, v)));
          }
          break;
        case 'use':
          for (const a of ['href', 'xlink:href']) {
            const v = c.getAttribute(a);
            if (v && !v.startsWith('#')) c.setAttribute(a, abs(v, base));
          }
          break;
      }

      const style = c.getAttribute('style');
      if (style && style.includes('url(')) {
        tasks.push(processCss(style, base, { ...opts, skipUnusedCssAssets: false }).then((s) => c.setAttribute('style', s)));
      }
    }
  }

  function absAttr(el, names, base) {
    for (const n of names) {
      const v = el.getAttribute(n);
      if (v) el.setAttribute(n, abs(v, base));
    }
  }

  function handleLink(o, c, base, opts, tasks, removals) {
    const rel = (c.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const href = c.getAttribute('href');
    if (rel.includes('stylesheet') && !rel.includes('alternate') && href) {
      if (o.disabled) { removals.push(c); return; }
      const full = abs(href, base);
      tasks.push((async () => {
        const res = await fetchResource(full, 'text', opts);
        // Fall back to the CSSOM when the file can't be refetched.
        const text = res ? res.text : (o.sheet && rulesText(o.sheet));
        if (text == null) { c.setAttribute('href', full); return; }
        const style = c.ownerDocument.createElement('style');
        const media = c.getAttribute('media');
        if (media && media !== 'all') style.setAttribute('media', media);
        style.textContent = await processCss(text, res ? res.url || full : full, opts);
        c.replaceWith(style);
      })());
    } else if (rel.some((r) => ['preload', 'prefetch', 'modulepreload', 'preconnect', 'dns-prefetch', 'prerender', 'manifest'].includes(r))) {
      removals.push(c);
    } else if (rel.some((r) => r.includes('icon')) && href) {
      tasks.push(inlineUrl(href, base, opts).then((v) => c.setAttribute('href', v)));
    } else if (href) {
      c.setAttribute('href', abs(href, base));
    }
    c.removeAttribute('integrity');
    c.removeAttribute('crossorigin');
  }

  // Open shadow roots become declarative shadow DOM, processed like the page
  // itself (so nested roots, images and adopted stylesheets all survive).
  function snapshotShadow(root, ctx) {
    // Usage detection only scans the light DOM, so embed everything in here.
    ctx = { ...ctx, opts: { ...ctx.opts, skipUnusedCssAssets: false } };
    const tpl = ctx.doc.createElement('template');
    tpl.setAttribute('shadowrootmode', 'open');
    for (const node of root.childNodes) tpl.content.append(node.cloneNode(true));
    processElements([...root.querySelectorAll('*')], [...tpl.content.querySelectorAll('*')], ctx);
    if (root.adoptedStyleSheets && root.adoptedStyleSheets.length) {
      const style = ctx.doc.createElement('style');
      const text = root.adoptedStyleSheets.map(rulesText).filter(Boolean).join('\n');
      ctx.tasks.push(processCss(text, ctx.base, ctx.opts).then((css) => { style.textContent = css; }));
      tpl.content.prepend(style);
    }
    return tpl;
  }

  // Keep only `keep` and its ancestors (plus non-visual nodes), so the area
  // the user picked keeps its styling context but nothing else is shown.
  function keepOnly(root, keep) {
    if (!keep) return;
    const body = root.querySelector('body');
    for (let node = keep; node && node !== body && node !== root; node = node.parentElement) {
      for (const sib of [...node.parentElement.children]) {
        if (sib !== node && !['style', 'link', 'script', 'template'].includes(sib.localName)) sib.remove();
      }
    }
  }

  // =====================================================================
  // Main-content detection (Markdown / text)
  // =====================================================================

  function visibleText(el) {
    const all = el.innerText.length;
    let links = 0;
    for (const a of el.querySelectorAll('a')) links += a.innerText.length;
    return all - links * 0.7;
  }

  function findMainContent() {
    const bodyLen = document.body.innerText.length;
    const explicit = [...document.querySelectorAll('main, [role="main"], article')]
      .filter((el) => el.innerText.length > bodyLen * 0.3);
    if (explicit.length === 1) return explicit[0];

    let current = document.body;
    for (;;) {
      const total = visibleText(current);
      let best = null;
      let bestScore = 0;
      for (const child of current.children) {
        if (['script', 'style', 'nav', 'header', 'footer', 'aside', 'noscript'].includes(child.localName)) continue;
        const score = visibleText(child);
        if (score > bestScore) { best = child; bestScore = score; }
      }
      if (!best || bestScore < total * 0.6 || bestScore < 200) return current;
      current = best;
    }
  }

  // =====================================================================
  // HTML → Markdown
  // =====================================================================

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'button', 'input', 'select', 'textarea', 'head', 'meta', 'link', 'object', 'embed']);
  const BLOCK = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'figure', 'figcaption', 'form', 'fieldset', 'details', 'summary', 'address', 'center']);

  function captureMarkdown(root) {
    const md = convert(root, { list: [] });
    return header('md') + md
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ *\uE000/g, '  ') // hard line breaks
      .trim() + '\n';
  }

  function isHidden(el) {
    if (el.checkVisibility && el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'contents') return false; // no box of its own, children still render
    return cs.display === 'none' || cs.visibility === 'hidden';
  }

  function inline(el, ctx) {
    return convert(el, ctx).replace(/\s*\n\s*/g, ' ').trim();
  }

  function convert(node, ctx) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (ctx.pre) { out += child.textContent; continue; }
        const text = child.textContent.replace(/\s+/g, ' ');
        out += out.endsWith('\n') ? text.replace(/^ /, '') : text;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.localName;
      if (SKIP.has(tag) || isHidden(child)) continue;
      out += element(child, tag, ctx);
    }
    return out;
  }

  function element(el, tag, ctx) {
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = inline(el, ctx);
        return text ? `\n\n${'#'.repeat(+tag[1])} ${text}\n\n` : '';
      }
      case 'p':
        return `\n\n${convert(el, ctx).trim()}\n\n`;
      case 'br':
        return '\uE000\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'strong': case 'b': {
        const t = convert(el, ctx);
        return t.trim() ? wrapKeepSpace(t, '**') : t;
      }
      case 'em': case 'i': {
        const t = convert(el, ctx);
        return t.trim() ? wrapKeepSpace(t, '*') : t;
      }
      case 'del': case 's': case 'strike': {
        const t = convert(el, ctx);
        return t.trim() ? wrapKeepSpace(t, '~~') : t;
      }
      case 'code': {
        if (ctx.pre) return el.textContent;
        const t = el.textContent;
        const fence = t.includes('`') ? '``' : '`';
        return t.trim() ? `${fence}${t.replace(/\s+/g, ' ')}${fence}` : '';
      }
      case 'pre': {
        const code = el.querySelector('code');
        const cls = ((code && code.className) || el.className || '').toString();
        const lang = (cls.match(/(?:language|lang)-([\w+#-]+)/) || [])[1] || '';
        const text = el.innerText.replace(/\n+$/, '');
        const fence = text.includes('```') ? '~~~~' : '```';
        return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
      }
      case 'a': {
        const text = inline(el, ctx);
        const href = el.getAttribute('href');
        if (!text) return '';
        if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
        return `[${text}](${abs(href).replace(/\)/g, '%29').replace(/ /g, '%20')})`;
      }
      case 'img': {
        const src = el.currentSrc || el.src;
        if (!src || src.startsWith('data:') && src.length > 2000) return el.alt ? el.alt : '';
        return `![${(el.alt || '').replace(/[[\]]/g, '')}](${src.replace(/\)/g, '%29').replace(/ /g, '%20')})`;
      }
      case 'ul': case 'ol':
        return list(el, tag === 'ol', ctx);
      case 'li': // stray <li> outside a list
        return `\n- ${convert(el, ctx).trim()}\n`;
      case 'blockquote': {
        const inner = convert(el, ctx).replace(/\n{3,}/g, '\n\n').trim();
        return '\n\n' + inner.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      }
      case 'table':
        return table(el, ctx);
      case 'dl':
        return '\n\n' + convert(el, ctx) + '\n\n';
      case 'dt':
        return `\n**${inline(el, ctx)}**\n`;
      case 'dd':
        return `: ${inline(el, ctx)}\n`;
      default:
        if (BLOCK.has(tag) || isBlockDisplay(el)) return `\n${convert(el, ctx).trim()}\n`;
        return convert(el, ctx);
    }
  }

  function isBlockDisplay(el) {
    const d = getComputedStyle(el).display;
    return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table';
  }

  function wrapKeepSpace(text, mark) {
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return `${m[1]}${mark}${m[2].replace(/\s*\n\s*/g, ' ')}${mark}${m[3]}`;
  }

  function list(el, ordered, ctx) {
    // Nested lists get their indentation from the enclosing item's continuation lines.
    const depth = ctx.list.length;
    let n = parseInt(el.getAttribute('start') || '1', 10) || 1;
    let out = depth ? '\n' : '\n\n';
    for (const li of el.children) {
      if (li.localName !== 'li' || isHidden(li)) continue;
      const marker = ordered ? `${n++}. ` : '- ';
      const body = convert(li, { ...ctx, list: [...ctx.list, ordered] })
        .replace(/\n{3,}/g, '\n\n').trim()
        .split('\n').map((line, i) => (i === 0 || !line ? line : '   ' + line)).join('\n');
      out += `${marker}${body}\n`;
    }
    return out + (depth ? '' : '\n');
  }

  function table(el, ctx) {
    const rows = [];
    for (const tr of el.rows) {
      if (isHidden(tr)) continue;
      const cells = [];
      for (const cell of tr.cells) {
        const text = convert(cell, { ...ctx, list: [] })
          .replace(/\uE000\n/g, '<br>').replace(/\n{2,}/g, '<br>').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
        cells.push(text);
        for (let k = 1; k < (cell.colSpan || 1); k++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    for (const r of rows) while (r.length < width) r.push('');
    const line = (r) => `| ${r.join(' | ')} |`;
    const caption = el.caption ? `**${inline(el.caption, ctx)}**\n\n` : '';
    return `\n\n${caption}${line(rows[0])}\n| ${Array(width).fill('---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`;
  }

  // =====================================================================
  // Image collection
  // =====================================================================

  function collectImages(root) {
    const urls = new Set();
    const add = (u) => {
      if (!u) return;
      const full = abs(u);
      if (/^https?:/i.test(full) || (/^data:image\//i.test(full) && full.length < 1500000)) urls.add(full);
    };
    for (const img of root.querySelectorAll('img')) add(img.currentSrc || img.src || img.dataset.src);
    for (const v of root.querySelectorAll('video[poster]')) add(v.getAttribute('poster'));
    for (const i of root.querySelectorAll('image')) add(i.getAttribute('href') || i.getAttribute('xlink:href'));
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') for (const m of bg.matchAll(URL_RE)) add(m[1] ?? m[2] ?? m[3]);
    }
    if (root === document.body) {
      add(document.querySelector('meta[property="og:image"]')?.content);
    }
    return [...urls];
  }

  window.__contentGrabber = { start };
})();
