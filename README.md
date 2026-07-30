# Reel — Music Recorder PWA

A studio-style recorder: live VU meters, a tape counter, and a local
"reel library" of your takes — installable, and fully usable offline
once it's loaded once.

## What it does

- **Record** — tap the red button, allow microphone access, tap again to stop.
- **Preview & name** — after stopping, name the take, then **Save** or **Discard**.
- **Library** — every saved take lives in your browser's IndexedDB, right on
  this device. Nothing is uploaded anywhere.
- **Play** — tap a take to play it, tap its waveform to scrub, rename it inline,
  download it as an audio file, or delete it (tap delete twice to confirm).
- **Install** — once hosted over HTTPS, browsers will offer to install this as
  an app (or use "Add to Home Screen" on iOS Safari). After that first load,
  it keeps working with no internet connection.

## Running it

Browsers require either **HTTPS** or **localhost** to allow microphone access
and service workers — opening `index.html` directly from disk (`file://`)
won't let recording work.

### Quickest: run it locally

```bash
cd reel-app
python3 -m http.server 8080
# then open http://localhost:8080 in your browser
```

### Put it on the web (so you can install it on your phone)

Any static host works — it's just five files, no build step, no server code:

- **GitHub Pages**: push this folder to a repo, enable Pages on the `main`
  branch, done.
- **Cloudflare Pages**: drag-and-drop the folder in the dashboard, or
  `wrangler pages deploy .`
- **Netlify / Vercel**: drag-and-drop deploy works the same way.

Once it's live on an `https://` URL, open it on your phone and use
"Add to Home Screen" (iOS) or the install prompt / menu → "Install app"
(Android/desktop Chrome).

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell/markup |
| `styles.css` | Design system (all the visual styling) |
| `app.js` | Recording, VU meters, IndexedDB library, playback |
| `manifest.json` | PWA metadata (name, icons, theme) |
| `sw.js` | Service worker — caches the app shell for offline use |
| `icons/` | App icons |

## Notes on the audio format

Recording uses whatever your browser's `MediaRecorder` supports best —
usually WebM/Opus on Chrome/Firefox/Android, or M4A on Safari/iOS. Downloaded
files use the matching extension. This is a solid, widely compatible choice;
if you specifically need `.wav`, that's a straightforward addition (say the
word and I'll add a WAV-encode step on save).

## Ideas for next steps

- WAV export option
- Multi-take overdub/mixing (layer takes together)
- Cloud backup/sync (would need a backend — this version is fully local by design)
- Trim/edit a take before saving
