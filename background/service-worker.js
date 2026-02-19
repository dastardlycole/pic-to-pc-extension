// Background service worker (Manifest V3)
//
// Primary role: WebSocket proxy for content scripts.
//
// Content scripts on HTTPS pages cannot open ws:// connections directly —
// the browser blocks it as mixed content. The extension background context
// is not subject to the host page's CSP or mixed-content rules, so we open
// the WebSocket here and relay messages to/from the content script via a
// chrome.runtime port.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[pic-to-pc] Extension installed.');
});

// Toolbar icon click → tell the content script to open in smart-detect mode
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'p2p-toolbar-click' });
  } catch (e) {
    // Tab may not have the content script yet (e.g. chrome:// pages)
    console.warn('[pic-to-pc] Could not message tab:', e.message);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'p2p-signal') return;

  let ws = null;

  port.onMessage.addListener(({ type, payload }) => {

    // ── open: create the WebSocket connection ─────────────────────────────────
    if (type === 'open') {
      ws = new WebSocket(payload.url);

      ws.onopen    = ()  => port.postMessage({ type: 'open' });
      ws.onmessage = (e) => port.postMessage({ type: 'message', data: e.data });
      ws.onclose   = ()  => port.postMessage({ type: 'close' });
      ws.onerror   = ()  => port.postMessage({ type: 'error' });
      return;
    }

    // ── send: forward a message to the server ─────────────────────────────────
    if (type === 'send' && ws?.readyState === WebSocket.OPEN) {
      ws.send(payload.data);
      return;
    }

    // ── close: tear down ──────────────────────────────────────────────────────
    if (type === 'close') {
      ws?.close();
    }
  });

  // Clean up if the content script disconnects (tab closed, modal closed, etc.)
  port.onDisconnect.addListener(() => {
    ws?.close();
    ws = null;
  });
});
