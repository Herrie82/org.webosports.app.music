# Architecture

## Principle: two seams, everything else untouched

The stock Enyo Music app already has a clean split between *where media comes
from* and *how audio is played*. We exploit exactly two seams so the entire
existing UI (list views, now-playing, dashboard, controls, media keys) keeps
working for **both** local and Spotify content.

```
                          ┌──────────────────────────────────────────┐
                          │            Enyo UI (unchanged)            │
                          │  listViews · nowPlaying · dashboard · keys │
                          └───────────────┬───────────────┬───────────┘
                            data requests │               │ transport
                     ┌────────────────────▼──┐   ┌────────▼───────────────────┐
        SEAM 1 ──►   │  kindMediaIndex (local)│   │  kindAudioRouter (added)   │  ◄── SEAM 2
        data source  │  kindSpotifyIndex (add)│   │   ├ kindAudioManager  local│
                     └──────────┬─────────────┘   │   └ kindLibrespotManager sp │
                                │                  └────────┬───────────────────┘
                    local: com.palm.db        local: HTML5 <audio> + media server
                    spotify: HTTP ▼                    spotify: HTTP ▼
                          ┌───────────────────────────────────────────┐
                          │       Go backend  (127.0.0.1:8730)         │
                          │  /search /browse  ·  /player/*             │
                          └───────────┬───────────────────┬───────────┘
                            Web API   │                   │  Connect control
                          api.spotify.com          librespot receiver → ALSA
```

### Seam 1 — data source (`kindMediaIndex` ↔ `kindSpotifyIndex`)
`kindSpotifyIndex` mirrors `kindMediaIndex`'s surface (`requestMedia`,
`playSongs`, `onSetPlaybackList`) but answers from the Go backend. Results are
normalised to the app's media-item shape, with the playable `path` set to a
Spotify URI (`spotify:track:…`). Both indexes are instantiated at once; a source
selector (nav "Local" vs "Spotify", or a merged search) picks which answers.

Wiring: `source/app.js:22` keeps `MediaIndex`; add a sibling `SpotifyIndex`.

### Seam 2 — audio (`kindAudioManager` → `kindAudioRouter`)
`kindAudioRouter` owns **both** the stock `kindAudioManager` (local files via
HTML5 `<audio>` + the Palm media server) and the new `kindLibrespotManager`
(Spotify via librespot). It exposes the identical `kindAudioManager` surface
(`playAudio`/`pauseAudio`/`setAudioTime`/`getAudioCurrentTime`/… + the
`boolAudioPlaying/Paused/Loaded` flags + the five events) and dispatches by
track: URIs starting with `spotify:` go to librespot, everything else stays
local. Events from the active engine bubble up unchanged.

Wiring: one line in `utility/playback.js:7` — `kind:"kindAudioManager"` →
`kind:"kindAudioRouter"` (already applied).

## The Go backend (`service/`)

A single localhost HTTP/JSON server, cross-compiled for ARMv7 with Herrie's Go
toolchain. Two responsibilities:

1. **Search / browse** — `github.com/zmb3/spotify` against the Spotify Web API.
   `/search`, `/browse/album`, `/browse/artist`, `/me/playlists`.
2. **Playback control** — drives a local **librespot** Spotify Connect receiver
   via the Connect Web API (`/player/load|play|pause|next|prev|seek|volume|status`).

Auth: the **front-end** runs the OAuth2 Authorization-Code + PKCE flow itself
(the device now has TLS 1.3 + a modern browser), then `POST /session` hands the
token to the backend. No client secret lives on the device.

### Why librespot, and why Connect-control
The Spotify Web API returns **metadata only** — 30-second `preview_url`s were
[deprecated Nov 2024](https://community.spotify.com/t5/Spotify-for-Developers/Preview-URLs-Deprecated/td-p/6791368),
and the Web Playback SDK needs Widevine/EME (impossible here). Full-track audio
on unsupported hardware means **[librespot](https://github.com/librespot-org/librespot)**
(Rust, **Spotify Premium required**, ARMv7/armhf cross-compile supported).

librespot runs as a Connect *receiver* and outputs decoded audio to ALSA/Pulse.
The backend controls it with ordinary Connect commands (transfer + play/pause/
seek), so we need **no custom librespot protocol** — just `zmb3/spotify`'s player
endpoints. Trade-off: ~1s command latency (server round-trip). Alternative
(lower latency, more work): librespot's own player API / event pipe.

## Deployment (native side)
The IPK ships the Enyo UI. The Go service + librespot are native components
launched on the device (upstart/init script) listening on `127.0.0.1`. The app
only ever speaks localhost HTTP. See `librespot/README.md` for the port.

## Known scaffold caveats
- `zmb3/spotify` v2 method signatures used in `service/` are plausible but must be
  compiled against the pinned version (search types, `PlayOptions`, `SeekOpt`…).
- Enyo 0.10 `enyo.json`/`enyo.bind` helpers are used in the adapters; verify on
  the exact on-device framework build (fallbacks noted in-file).
- Field mapping from Spotify objects to the stock list-view row model is stubbed
  where the two differ (genre, album grouping, paging/collation).
