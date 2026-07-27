# Roadmap

Three parallel dimensions on one Enyo base (the stock Music app fork). Build in
this order — each phase is independently shippable.

## Phase 0 — Base (DONE in scaffold)
- [x] Fork `com.palm.app.musicplayer` → `app/` (id `com.herrie.musicspotify`).
- [x] `build.sh` produces an installable IPK in stock format (+ auto-fixes localized
      `resources/*/appinfo.json` ids, which otherwise silently block registration).
- [x] Fork installs and launches on the topaz TouchPad (`returnValue: true`).
- [x] Verified on-device: Enyo app **boots and runs** (`MusicPlayerApp`, `kindMediaIndex`,
      `kindListViewGenres`, `SearchControl` all init in the device log).
- [x] **Local media access FIXED.** Root cause: the media kinds
      (`com.palm.media.audio.{file,artist,album,genre}:1`) have an explicit read ACL and our
      third-party id wasn't on it → `db: permission denied` (-3963). Owner is the media indexer
      `com.palm.filenotifyd.js`; granted read via `putPermissions` impersonating that owner
      (`luna-send -a`). Reproducible: `deploy/provision-media-perms.sh`.
      Verified on device: app reads 33 songs / 1 artist/album/genre, **0 permission errors**.

## Phase 1 — Spotify plumbing (scaffolded, needs on-device finish)
- [x] `kindLibrespotManager` — audio adapter, backend-driven.
- [x] `kindAudioRouter` — local/Spotify dispatch; `playback.js` swapped to it.
- [x] `kindSpotifyIndex` — remote data source mirroring `kindMediaIndex`.
- [x] Go backend: `/search`, `/browse/*`, `/me/playlists`, `/player/*`.
- [x] `service/` **compiles clean** (host + ARMv7) against pinned `zmb3/spotify` v2;
      `go.sum` committed. ARM binary runs and binds on the topaz TouchPad.
- [x] **Kernel `accept4` patched, built, deployed & VERIFIED.** Added `CALL(sys_accept4)` (#366) to
      `arch/arm/kernel/calls.S` + `__NR_accept4` to `unistd.h` in `webos-uber-kernel`; built with
      CodeSourcery gcc 4.3.3 (`build-webos.sh`), deployed to topaz `/boot/uImage.webOSdebug`, rebooted
      into `#11`. Confirmed on-device: the Go service now **binds and answers** (`/auth/status`→200,
      `/search`→401) with **no `accept4` crash**. DB8 media grant also persisted across the reboot.
- [x] **OAuth2 PKCE flow — done in the BACKEND** (keeps crypto off the old browser):
      `/auth/login` → returns Spotify authorize URL; `/auth/callback` exchanges code+verifier;
      `/auth/status`. Start service with `-client-id <spotify-app-id>`. Compiles host + ARMv7.
- [x] **Enyo UI wired & verified.** Added a **"Spotify" nav entry** + self-contained
      `kindSpotifyView` (`source/spotifyView.js`): "Log in with Spotify" (opens `/auth/login`
      URL via `applicationManager/open`, polls `/auth/status`), a search box → `/search`, and
      tap-to-play that fires `onSetPlaybackList` → `kindPlayback` → `kindAudioRouter` →
      `kindLibrespotManager` (spotify: URIs). Verified on device: app boots clean (no Spotify JS
      errors) and its XHR **reaches the backend** (`GET /auth/status` logged server-side).
- [ ] End-to-end run needs external deps only: a Spotify **client_id** (`-client-id`) for login,
      and **librespot** running for actual audio (Phase 2). UI + backend + routing are in place.
- [ ] Instantiate `SpotifyIndex` in `app.js`; add a **Local / Spotify** source toggle
      in the nav panel; wire Spotify results into the existing list views.
- [ ] Confirm `spotify:` tracks route to librespot and local paths stay local.

## Phase 2 — librespot port (the hard dependency for real audio)
- [ ] Cross-compile librespot (Rust, `arm-unknown-linux-gnueabihf`) for the device.
- [ ] Audio sink: wire librespot output to the device's ALSA/PulseAudio.
- [ ] Run as a Connect receiver named `webOS`, logged in with **Premium**.
- [ ] Native launch (upstart/init) alongside the Go service on `127.0.0.1`.
- [ ] Latency/gapless check; decide Connect-control vs librespot direct API.

## Phase 3 — MPR feature port (make the bare player rich)

**Progress (2026-07-27, autonomous overnight):**
- [x] **Now-Playing album-art tap regions** — on the current track's art: left=prev, right=next,
      center=play/pause (`albumartitem.js` region math → `albumartview.js` fwd → `app.js` prev/next).
      Loads clean; the stock view was already album-art-centric so this adds the MPR interaction.
- [x] **Bookmarks / Resume** — `utility/bookmarkmanager.js` (db8 kind `…bookmark:1`), saves position
      every ~10s (`onUpdateTrackTime`), fetches + seeks on track start (`onTrackSrcChanged`). VERIFIED:
      kind registers (third-party app owns it), save+read works.
- [~] **Auto playlists FOUNDATION** — `utility/playstatmanager.js` (db8 kind `…playstat:1` +
      byLastPlayed/byPlayCount indexes), records a play on track start. VERIFIED: kind + ordered
      "most played"/"recently played" queries work. REMAINING: nav entries + list views to surface
      them ("Recently Played", "Most Played", "Recently Added" via media date), and **flylists**
      (rule-based smart playlists + rules UI — the most complex, deferred).



Music Player (Remix) features, ranked by value ÷ effort. Each is an Enyo
re-implementation using `reference/mpr-2.5.11/` as the behavioural spec — port
the *logic*, not the Mojo code. Many apply to **both** local and Spotify content.

| MPR feature | MPR source (reference) | Notes for the Enyo port | Applies to |
|-------------|------------------------|-------------------------|------------|
| **Bookmarks / resume** (per-track + auto) | `bookmark-service`, `MusicPlayer.js` | Store position per track id; resume on relaunch. Highest value. | local + spotify |
| **Sleep timer** | `mainmenu` scene | Timer → pause via `AudioRouter`. Small. | local + spotify |
| **Now-playing extras** (lights-off, orientation lock, screen-on) | `localnowplaying` | Power/display via `com.palm.display`, `powermanager`. | both |
| **Smart playlists (flylists)** | `flylist-service`, `flylistitems` | Rule-based auto playlists. Local = DB query; Spotify = saved-query. | local (+ spotify) |
| **Auto-playlists** (recently added/played/most played) | `autolists` | Play-count/history tracking layer. | local (+ spotify) |
| **Last.fm scrobbling** | `LastFM.js`, `scrobblecaching-service` | Offline-cached scrobbles; reuse `oauth.js`. | both |
| **Lyrics** | `lyrics-service`, `lyrics` scene | Fetch by title/artist (needs a lyrics source). | both |
| **Song info / discovery** | `songinfo-service`, `discovery` | Artist/album info, related. Spotify API gives this for free. | both |
| **Reorderable / editable playlists** | `ReorderablePlaylist.js` | Drag-reorder queue + playlist edit. | both |
| **Karaoke (synced lyrics)** | `karaoke-service`, `karaokes` | Niche; low priority. | local |
| **Videos** | `videos` scene | Out of scope for a music+Spotify app. | — |
| ~~Trial licensing~~ | `Trial.js`, `trialcheck` | **Drop.** Not needed. | — |
| ~~Facebook/Twitter/Google/Yahoo~~ | social scripts | **Drop / reconsider** — dated APIs. | — |

Suggested Phase-3 order: Bookmarks → Sleep timer → Now-playing extras →
Smart/auto playlists → Scrobbling → Lyrics/Discovery → the rest.

## Open decisions
1. **Install alongside or replace** the stock Music app? (Currently a separate id.)
2. Spotify **search scope**: merged local+Spotify results, or a hard source toggle?
3. librespot control path: **Connect Web API** (simple, ~1s latency) vs **direct
   librespot API** (complex, snappier) — revisit after Phase 2 latency testing.
