# Pic to PC

> Transfer photos from your phone directly into any browser file-upload field — no app, no account, no cloud.

## How it works

1. The extension injects an **"📱 Upload from Phone"** button next to every `<input type="file">` on any page.
2. Clicking it (or clicking the toolbar icon for **Input Mode**) shows a QR code.
3. Scan the QR code — your phone opens a lightweight web page.
4. Select photos on your phone.
5. Photos transfer **peer-to-peer via WebRTC** — they never touch any server.
6. In File Upload Mode the files are injected into the input. In Input Mode they're queued in your clipboard (press Ctrl+V to paste, tap Next for the next photo).

## Install

[**Add to Chrome →**](https://chrome.google.com/webstore/detail/pic-to-pc)

Or load unpacked for development — see [Contributing](#contributing) below.

## Two modes

| Mode | How to trigger | Best for |
|---|---|---|
| **File Upload** | Button appears automatically next to `<input type="file">` | Google Drive, email attachments, any upload form |
| **Input / Clipboard** | Click the toolbar icon | Google Docs, Notion, any rich-text editor |

## Architecture

Photos travel **phone → desktop** over a direct WebRTC DataChannel. The signaling server (hosted separately) only relays the WebRTC handshake (SDP + ICE candidates) and never sees your files.

```
Phone browser  ──── WebRTC DataChannel (P2P) ────►  Chrome Extension
                              ▲
                  SDP / ICE only (no file data)
                              │
                    Signaling server (Railway)
```

## Contributing

```bash
# 1. Clone
git clone https://github.com/dastardlycole/pic-to-pc-extension.git
cd pic-to-pc-extension

# 2. Load in Chrome
# chrome://extensions → Enable Developer mode → Load unpacked → select this folder
```

Changes to `content/content.js` or `manifest.json` require reloading the extension at `chrome://extensions`.

## License

MIT — see [LICENSE](LICENSE).
