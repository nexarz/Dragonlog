# Dragon//Log

A dragonboat and outrigger training tracker that runs in your phone's browser. Tracks stroke rate, GPS speed, pace, distance, and lap splits — all stored locally on your device, no accounts or servers.

## Features

- **Stroke rate** detected from phone motion sensors
- **GPS speed, pace, distance** with fused fallback when GPS drops out
- **Crew profiles** with calibrated distance-per-stroke (DPS) — switch between OC1, full crew, etc.
- **Auto-calibration** of DPS during a session when GPS is healthy
- **Lap splits** with per-split time, distance, pace, and stroke rate
- **Session history** with JSON export
- **Offline** — works with no cell signal once loaded
- **Installable** — add to home screen and it runs like a native app

## Try it

Live at: https://your-vercel-url.vercel.app *(update this after deploying)*

On your phone: open the URL in Safari (iOS) or Chrome (Android) → share menu → Add to Home Screen.

## Using it

1. **First time:** tap "Enable" to grant motion and location permission
2. **Calibrate your profile:** tap CALIBRATE, enter a known distance (e.g. 200m), paddle it, tap STOP
3. **Train:** tap START. Mount your phone somewhere stable with a clear view of the sky
4. **Lap splits:** tap LAP to mark splits during the session
5. **Review:** history tab shows all past sessions; export as JSON from Settings

### Tips

- **iOS motion permission** only works when triggered by a button tap — this is why the "Enable" button exists
- **GPS needs HTTPS** — that's why we deploy through Vercel rather than opening the file directly
- **Mount firmly** — loose phones cause false stroke detections. Adjust sensitivity in Settings if needed
- **Pause during rest intervals** so your averages aren't dragged down

## Tech

Single-page PWA, no framework, no build step. Native ES modules in the browser.

```
index.html              - page shell
styles.css              - all styling
app.js                  - main entry, wires modules, owns UI
modules/
  state.js              - live state + localStorage with schema versioning
  sensors.js            - GPS watcher + accelerometer stroke detector
  fusion.js             - pure math: haversine, SPM, fused distance
  format.js             - pure formatters
sw.js                   - service worker (offline cache)
manifest.json           - PWA install metadata
icons/                  - app icons for home screen
```

## Deploying your own copy

1. Fork this repo on GitHub
2. Sign up for [Vercel](https://vercel.com) with your GitHub account
3. Click "Add New Project" → import the forked repo → Deploy
4. Vercel gives you an `https://` URL — open it on your phone

Any push to the main branch auto-deploys. No build step needed.

## Data & privacy

All data — profiles, preferences, session history — is stored in your browser's `localStorage`. Nothing is uploaded anywhere. Clearing your browser data or deleting the app clears your data. Export from Settings to back up.

## Limitations

- Accelerometer stroke detection needs calibration (sensitivity slider). Works best with a firm phone mount
- GPS speed on water is noisy at low speeds — expect some jitter
- Browser storage is per-browser. Sessions in Safari are not visible in Chrome
- iOS aggressively backgrounds web apps. Keep the app in foreground during training
- No cross-device sync, no coach features — by design, for simplicity and privacy

## License

MIT — see LICENSE file.
