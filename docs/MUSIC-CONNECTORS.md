# Music Synergy Connectors — design sketch

Goal: a pluggable "music connector" framework (like webOS Synergy / the cloud
connectors) so Spotify, Tidal, YouTube Music, Qobuz, Apple Music, local, … each
plug into the same Music+Spotify app.

## Why this is very feasible: our current architecture is already the shape

What we built for Spotify generalises cleanly:

| Layer | Spotify today | Generalised |
|-------|---------------|-------------|
| Data source (Enyo) | `kindSpotifyIndex` → backend `/search` | `kindMusicIndex` → `/provider/<id>/search` |
| Playback (Enyo) | `kindLibrespotManager` | `kindStreamManager` (routes per provider) |
| Backend | `spotify.go` + `player.go` | `MusicProvider` interface, one impl per service |
| **Audio sink** | gst → `pulsesink media.role=music` | **REUSED verbatim by every stream-URL service** |

The **gst → pulse `media.role=music` sink** (44.1→48k ffaudioresample) is the key
reusable win: any provider that yields a **direct stream URL** plays through the
exact same pipeline — `souphttpsrc location=<url> ! decodebin ! audioconvert !
ffaudioresample ! pulsesink stream-properties=s,media.role=music`. No per-service
native client needed. Spotify is the *special* case (encrypted streams → needs
librespot); most others are simpler.

## The connector contract (backend `MusicProvider` interface)

```
Auth(...)                         // OAuth / login (see accounts reuse below)
Search(q, type) -> []Track/…      // normalised to the app's media-item shape
Browse(albums|artists|playlists)  // library + browse
Play(uri) / Pause / Next / Seek / Volume / Status
```
Each service is a Go module implementing this. The backend exposes
`/providers`, `/provider/<id>/…`. Spotify's existing code becomes the first impl.

## Reuse the webOS Accounts + cloud-auth OAuth you already have

Adding a service = adding an **account type** (com.palm.app.accounts template +
cloud-auth OAuth), exactly like the cloud connectors. That's genuinely "Synergy
for music": the user taps *Add account → Spotify / Tidal / …*, the shared
cloud-auth Atlas-WebView flow does OAuth (we already made Spotify's work), and the
token lands in the account store. The app lists whatever music accounts exist as
sources. This also solves per-service login uniformly.

## Playback feasibility per service (the real differentiator)

| Service | Metadata/Search | Full playback on webOS |
|---------|-----------------|------------------------|
| **Spotify** | ✅ | ✅ librespot (done) — Premium |
| **Local** | ✅ | ✅ media DB + HTML5/media server (done) |
| **YouTube Music** | ✅ (ytmusicapi) | ✅ resolve stream URL (yt-dlp-style) → shared gst sink. No DRM. |
| **Tidal** | ✅ | ⚠️ possible — HiFi stream URLs obtainable (open impls exist); MQA/FLAC decode via gst. Premium. |
| **Qobuz** | ✅ | ⚠️ possible — stream URLs via the API (qobuz-dl-style). FLAC → gst. Premium. |
| **Deezer** | ✅ | ⚠️ streams are Blowfish-encrypted → need a decrypt step before gst (deezer-py-style). Premium. |
| **Apple Music** | ✅ (+30s preview) | ❌ FairPlay DRM, no open client, MusicKit needs EME/FairPlay → **not feasible**. Metadata/search/preview only, or remote-control if Apple exposed a Connect-like API (it doesn't). |

Takeaway: **stream-URL services (YouTube Music, Tidal, Qobuz, Deezer) are all
playable through the sink we already built**, each needing only a URL resolver
(and for Deezer, a decrypt shim). Spotify keeps librespot. Apple Music is
metadata-only (DRM wall — same class as Spotify's Web Playback SDK).

## ✅ Scaffold built (2026-07-27)

The backend now has the framework (additive — existing /search + /player/* still drive Spotify for the app):
- **`provider.go`** — `MusicProvider` interface (`ID/Name/Search/StreamURL`) + registry + routes
  `GET /providers`, `GET /provider/<id>/search?q=`, `POST /provider/<id>/play {trackId}`.
- **`spotifyprovider.go`** — Spotify as provider #1 (unified search VERIFIED: `/provider/spotify/search`
  returns real tracks; playback stays on librespot/Connect so StreamURL="").
- **`streamplayer.go`** — `playStreamURL(url)` = the shared audio path for ALL stream-URL connectors:
  `curl -sL <url> | gst-launch-0.10 fdsrc ! decodebin ! audioconvert ! ffaudioresample ! …48kHz… !
  pulsesink media.role=music` (souphttpsrc isn't on device → curl|fdsrc; ffmpeg decoders handle mp3/aac/ogg).
- **`youtube.go`** — YouTube provider via `yt-dlp` (search `ytsearchN:` + `-g` best-audio URL → shared player).
  Works once yt-dlp is on the device; returns a clear error otherwise. Free/no-DRM.

VERIFIED on device: `/providers` lists spotify+youtube; `/provider/spotify/search` returns tracks.
Chosen free source: research (librespot#1134 + nordicapis) shows **SoundCloud** (public API, direct no-DRM
stream URLs) and **Deezer** (free API; streams Blowfish-encrypted → need decrypt) as the openest; **YouTube**
via yt-dlp is the no-API path. Any of them now = implement one MusicProvider returning a stream URL.

## Suggested build order (when we pick this up)

1. **Refactor the backend** to the `MusicProvider` interface; make Spotify provider #1 (no behaviour change).
2. **Add the shared stream-URL player** (gst sink, already proven) as the default playback path.
3. **YouTube Music connector** — easiest 2nd provider (no DRM, no Premium): validates the framework end-to-end.
4. **Accounts integration** — turn providers into webOS account types via the cloud-auth framework.
5. **Enyo source selector** — `kindMusicIndex`/`kindStreamManager`; nav lists Local + each music account.
6. Tidal/Qobuz/Deezer connectors as URL-resolver modules; Apple Music as metadata-only.

Nothing here requires throwing away current work — it's a generalisation of the
Spotify path plus one reusable audio sink.
