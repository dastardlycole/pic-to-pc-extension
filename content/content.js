/**
 * Pic to PC — Content Script
 *
 * Two modes:
 *
 *  FILE UPLOAD mode — auto-triggered by <input type="file"> buttons.
 *    Received photos are programmatically injected into the input element
 *    using a three-strategy cascade (native setter → direct assign → drag-drop).
 *
 *  INPUT mode — triggered by clicking the extension toolbar icon.
 *    Received photos are queued and walked through one by one via
 *    clipboard + a persistent toast ("Press Ctrl+V → Next →").
 *    Works in Google Docs, Notion, rich-text editors, etc.
 */

(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────────────
  const SIGNALING_WS = 'wss://pic-to-pc-production.up.railway.app';

  const FALLBACK_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const MODE_FILE_UPLOAD = 'file-upload';
  const MODE_INPUT       = 'input';

  // ── Session state (one active session at a time) ───────────────────────────
  let session = null;
  /*
    session = {
      mode,           // MODE_FILE_UPLOAD | MODE_INPUT
      targetInput,    // <input type="file"> element (file-upload mode only)
      roomId,         // UUID string
      port,           // chrome.runtime port to service worker
      pc,             // RTCPeerConnection
      dc,             // RTCDataChannel
      receivedFiles,  // File[] indexed by fileIndex
      currentMeta,    // current file-start metadata
      currentChunks,  // ArrayBuffer[] for current file
      currentReceived // bytes received for current file
    }
  */

  // ══════════════════════════════════════════════════════════════════════════
  // FILE UPLOAD MODE — button injection
  // ══════════════════════════════════════════════════════════════════════════

  function injectButton(input) {
    if (input.dataset.p2pInjected) return;
    input.dataset.p2pInjected = '1';

    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'p2p-trigger-btn';
    btn.textContent = '📱 Upload from Phone';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startSession(MODE_FILE_UPLOAD, input);
    });

    input.insertAdjacentElement('afterend', btn);
  }

  function scanForInputs() {
    document.querySelectorAll('input[type="file"]:not([data-p2p-injected])')
      .forEach(injectButton);
  }

  const domObserver = new MutationObserver(scanForInputs);
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
  scanForInputs();

  // ══════════════════════════════════════════════════════════════════════════
  // INPUT MODE — toolbar icon click
  // ══════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'p2p-toolbar-click') {
      startSession(MODE_INPUT, null);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SESSION — shared setup for both modes
  // ══════════════════════════════════════════════════════════════════════════

  function startSession(mode, targetInput) {
    if (session) return; // only one session at a time

    const roomId = crypto.randomUUID();

    session = {
      mode,
      targetInput,
      roomId,
      port:            null,
      pc:              null,
      dc:              null,
      receivedFiles:   [],
      currentMeta:     null,
      currentChunks:   [],
      currentReceived: 0,
    };

    showModal();
    openSignaling(roomId);
  }

  function closeSession() {
    session?.dc?.close();
    session?.pc?.close();
    session?.port?.postMessage({ type: 'close' });
    session?.port?.disconnect();
    removeModal();
    removeToast();
    session = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODAL — QR code + progress bars
  // ══════════════════════════════════════════════════════════════════════════

  let overlayEl = null;

  function showModal() {
    overlayEl = document.createElement('div');
    overlayEl.id = 'p2p-overlay';
    overlayEl.innerHTML = `
      <div class="p2p-modal">
        <div class="p2p-header">
          <span class="p2p-title">📱 Upload from Phone</span>
          <button class="p2p-close-btn" title="Close">✕</button>
        </div>
        <div class="p2p-body">
          <div class="p2p-status">Connecting to server…</div>
          <div class="p2p-qr" id="p2p-qr-container"></div>
          <div class="p2p-hint">Point your camera at the code to open the transfer page</div>
          <div class="p2p-files" id="p2p-files"></div>
        </div>
      </div>
    `;

    overlayEl.querySelector('.p2p-close-btn').addEventListener('click', closeSession);
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) closeSession();
    });

    document.body.appendChild(overlayEl);
  }

  function renderQr(publicUrl, roomId) {
    const roomUrl = `${publicUrl}/room?id=${roomId}`;
    const container = document.getElementById('p2p-qr-container');
    if (!container) return;

    try {
      new QRCode(container, { text: roomUrl, width: 200, height: 200 });
    } catch {
      container.style.cssText = 'font-size:11px;word-break:break-all;padding:8px;color:#374151';
      container.textContent = roomUrl;
    }

    setModalStatus('Scan with your phone');
  }

  function removeModal() {
    overlayEl?.remove();
    overlayEl = null;
  }

  function setModalStatus(text) {
    const el = overlayEl?.querySelector('.p2p-status');
    if (el) el.textContent = text;
  }

  function addFileRow(index, name) {
    const filesEl = document.getElementById('p2p-files');
    if (!filesEl) return;
    const row = document.createElement('div');
    row.className = 'p2p-file-row';
    row.innerHTML = `
      <span class="p2p-file-name">${escHtml(name)}</span>
      <div class="p2p-bar-wrap">
        <div class="p2p-bar" id="p2p-bar-${index}"></div>
      </div>
    `;
    filesEl.appendChild(row);
  }

  function updateFileBar(index, received, total) {
    const bar = document.getElementById(`p2p-bar-${index}`);
    if (bar) bar.style.width = Math.round((received / total) * 100) + '%';
  }

  function completeFileBar(index) {
    const bar = document.getElementById(`p2p-bar-${index}`);
    if (bar) {
      bar.style.width = '100%';
      bar.classList.add('p2p-bar-done');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SIGNALING — via service worker port (handles mixed-content ws:// on HTTPS)
  // ══════════════════════════════════════════════════════════════════════════

  function openSignaling(roomId) {
    const port = chrome.runtime.connect({ name: 'p2p-signal' });
    session.port = port;

    port.onMessage.addListener(async ({ type, data }) => {
      switch (type) {
        case 'open':
          // WebSocket connected — join room, then wait for 'joined' before creating offer
          port.postMessage({
            type: 'send',
            payload: { data: JSON.stringify({ type: 'join', roomId }) },
          });
          break;

        case 'message': {
          let msg;
          try { msg = JSON.parse(data); } catch { break; }
          if (msg.type === 'joined') {
            if (msg.publicUrl) renderQr(msg.publicUrl, roomId);
            if (msg.iceServers) session.iceServers = msg.iceServers;
            await createOffer(roomId); // now has correct ICE servers
          }
          await handleSignalingMessage(msg);
          break;
        }

        case 'error':
        case 'close':
          setModalStatus('Connection lost. Close and try again.');
          break;
      }
    });

    port.postMessage({ type: 'open', payload: { url: SIGNALING_WS } });
  }

  async function handleSignalingMessage(msg) {
    if (!session?.pc) return;

    if (msg.type === 'answer') {
      await session.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      setModalStatus('Connected — select photos on your phone');
    }

    if (msg.type === 'ice-candidate' && msg.payload?.candidate) {
      await session.pc.addIceCandidate(new RTCIceCandidate(msg.payload)).catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEBRTC — desktop is the offerer and creates the DataChannel
  // ══════════════════════════════════════════════════════════════════════════

  async function createOffer(roomId) {
    const pc = new RTCPeerConnection({ iceServers: session.iceServers ?? FALLBACK_ICE_SERVERS });
    session.pc = pc;

    const dc = pc.createDataChannel('p2p-files', { ordered: true });
    session.dc = dc;
    dc.binaryType = 'arraybuffer';
    setupDataChannel(dc);

    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate && session?.port) {
        session.port.postMessage({
          type: 'send',
          payload: { data: JSON.stringify({ type: 'ice-candidate', payload: candidate.toJSON() }) },
        });
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        setModalStatus('Connection failed — TURN server may be needed on this network');
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    session.port.postMessage({
      type: 'send',
      payload: {
        data: JSON.stringify({
          type:    'offer',
          roomId,
          payload: { type: offer.type, sdp: offer.sdp },
        }),
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DATACHANNEL RECEIVE — reassemble chunks into File objects
  // ══════════════════════════════════════════════════════════════════════════

  function setupDataChannel(dc) {
    dc.addEventListener('open', () => {
      setModalStatus('Connected — select photos on your phone');
    });

    dc.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        handleJsonFrame(msg);
      } else {
        handleChunk(data); // ArrayBuffer
      }
    });

    dc.addEventListener('error', (e) => {
      setModalStatus('Transfer error: ' + (e.error?.message ?? 'unknown'));
    });
  }

  function handleJsonFrame(msg) {
    if (!session) return;

    if (msg.type === 'file-start') {
      session.currentMeta     = msg;
      session.currentChunks   = [];
      session.currentReceived = 0;
      addFileRow(msg.fileIndex, msg.name);
      setModalStatus(`Receiving ${msg.fileIndex + 1} of ${msg.totalFiles}…`);
      return;
    }

    if (msg.type === 'file-end') {
      const meta = session.currentMeta;
      if (!meta) return;
      const blob = new Blob(session.currentChunks, { type: meta.mimeType });
      const file = new File([blob], meta.name, { type: meta.mimeType });
      session.receivedFiles[msg.fileIndex] = file;
      completeFileBar(msg.fileIndex);
      session.currentChunks = [];
      session.currentMeta   = null;
      return;
    }

    if (msg.type === 'transfer-complete') {
      onTransferComplete();
    }
  }

  function handleChunk(arrayBuffer) {
    if (!session?.currentMeta) return;
    session.currentChunks.push(arrayBuffer);
    session.currentReceived += arrayBuffer.byteLength;
    updateFileBar(session.currentMeta.fileIndex, session.currentReceived, session.currentMeta.size);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSFER COMPLETE — dispatch by mode
  // ══════════════════════════════════════════════════════════════════════════

  function onTransferComplete() {
    const files = session.receivedFiles.filter(Boolean);

    if (session.mode === MODE_FILE_UPLOAD) {
      const count = files.length;
      setModalStatus(`Done! ${count} photo${count !== 1 ? 's' : ''} added.`);
      injectIntoInput(files, session.targetInput);
      setTimeout(closeSession, 1500);
    } else {
      // Input mode: close modal, start clipboard queue
      removeModal();
      const savedSession = session;
      session = null; // release session so closeSession doesn't run twice
      savedSession.dc?.close();
      savedSession.pc?.close();
      savedSession.port?.postMessage({ type: 'close' });
      savedSession.port?.disconnect();
      startClipboardQueue(files);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FILE UPLOAD MODE — inject files into <input type="file">
  // ══════════════════════════════════════════════════════════════════════════

  function injectIntoInput(files, input) {
    if (!input) return;
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));

    // Strategy 1: native setter (works with React and most frameworks)
    try {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
      if (nativeSetter) {
        nativeSetter.call(input, dt.files);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        return;
      }
    } catch (_) {}

    // Strategy 2: direct assignment (vanilla HTML)
    try {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    } catch (_) {}

    // Strategy 3: synthetic drag-drop on parent (react-dropzone, Uppy, etc.)
    try {
      const target = input.closest('.dropzone, [data-testid*="drop"], [class*="drop"]')
                  ?? input.parentElement;
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt }));
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INPUT MODE — clipboard queue + toast
  // ══════════════════════════════════════════════════════════════════════════

  async function startClipboardQueue(files) {
    let index = 0;

    async function advance() {
      if (index >= files.length) {
        showToast('All photos sent ✓', null, null);
        setTimeout(removeToast, 2500);
        return;
      }

      const file    = files[index];
      const isLast  = index === files.length - 1;
      const label   = `Photo ${index + 1} of ${files.length} ready — Press Ctrl+V to paste`;
      const btnText = isLast ? null : 'Next →';

      await writeToClipboard(file);

      showToast(label, btnText, async () => {
        index++;
        await advance();
      });
    }

    await advance();
  }

  // Convert any image to PNG blob (clipboard only accepts image/png in Chrome)
  function toPngBlob(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  async function writeToClipboard(file) {
    try {
      const png = await toPngBlob(file);
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': png }),
      ]);
    } catch (e) {
      console.warn('[pic-to-pc] Clipboard write failed:', e);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TOAST UI (input mode)
  // ══════════════════════════════════════════════════════════════════════════

  function showToast(message, btnLabel, onBtn) {
    let toast = document.getElementById('p2p-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'p2p-toast';
      document.body.appendChild(toast);
    }

    toast.innerHTML = `
      <span class="p2p-toast-msg">${escHtml(message)}</span>
      ${btnLabel ? `<button class="p2p-toast-btn">${escHtml(btnLabel)}</button>` : ''}
    `;

    if (btnLabel && onBtn) {
      toast.querySelector('.p2p-toast-btn').addEventListener('click', onBtn);
    }
  }

  function removeToast() {
    document.getElementById('p2p-toast')?.remove();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ══════════════════════════════════════════════════════════════════════════

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

})();
