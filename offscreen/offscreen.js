// Offscreen document: service workers cannot create blob URLs, so this page
// does it for them. Blob URLs from the extension's own origin are always
// downloadable, with no size limit (unlike data: URLs, capped at 2 MB).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'make-blob':
      sendResponse({ url: URL.createObjectURL(new Blob([msg.content], { type: msg.mime })) });
      return;
    case 'fetch-blob':
      fetch(msg.url, { credentials: 'include', cache: 'force-cache' })
        .then(async (res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          sendResponse({ url: URL.createObjectURL(blob), contentType: blob.type });
        })
        .catch((e) => sendResponse({ error: String(e.message || e) }));
      return true;
    case 'revoke':
      URL.revokeObjectURL(msg.url);
      return;
  }
});
