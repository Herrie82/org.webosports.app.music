# Music+Spotify — webOS Project

This is a **Palm/HP webOS** application (original 2009–2012 platform / webOS Open
Source Edition — webosports — not LG webOS).

## Session Setup

At the start of every session, load the full webOS platform context:

```
webos://knowledge/all
```

This gives you knowledge of the Mojo/Enyo frameworks, Luna service bus, SDK
tools (including novacom), app structure conventions, and common gotchas — so
we don't have to re-establish basics each time.

---

## Project Details

**App ID:** `org.webosports.app.music`
**Framework:** Enyo 1.x (fork of the stock `com.palm.app.musicplayer`)
**Target devices:** webOS Open Source Edition ports (e.g. TouchPad), and stock
Palm/HP hardware where the fork still applies
**webOS version(s):** webOS 3.x-era Enyo baseline (see `app/framework_config.json`)

## App Structure

A legacy-webOS music player that plays **local files _and_ streaming
sources** (Spotify, Apple Music, Deezer, Tidal, YouTube, SoundCloud,
Jamendo), built by forking the stock **Enyo** Music app and adding a Go
backend plus richer player features. See `docs/ARCHITECTURE.md` for the full
seam-by-seam breakdown (`kindMediaIndex`/`kindSpotifyIndex` for data,
`kindAudioRouter` for playback routing).

Key files:
- `app/appinfo.json` — app manifest
- `app/source/app.js` — Enyo app entry / kind registration
- `app/depends.js` — Enyo dependency load order (must be kept in sync with new files)
- `build.sh` — packages `app/` into `build-output/org.webosports.app.music_<ver>_all.ipk`

There is a second, separate Enyo app in `app-musicauth/` (`musicAuth`) used
for on-device OAuth/token capture flows — has its own `appinfo.json`.

## Services

This app includes a backend service: a single Go binary (`service/`,
package `main`, built as `spotify-webos-service`), cross-compiled for
ARMv7 (`GOOS=linux GOARCH=arm GOARM=7`). It is **not** an LS2/Luna bus
service — it's a plain localhost HTTP/JSON server on `127.0.0.1:8730`
(see `docs/ARCHITECTURE.md`), driving librespot (Spotify Connect) and
provider-specific search/stream logic for the other backends.

Today it's installed and updated via the ad-hoc scripts in `deploy/`
(`relocate-to-cryptofs.sh`, `rebuild-musicauth.sh`, `provision-*.sh`) rather
than a signed ipk with `postinst`/`prerm`. See `deploy/spotify-webos-service.upstart`
for the upstart job definition.

## Development Notes

- `id` in `app/appinfo.json` **must** stay `org.webosports.app.music` —
  `build.sh` rewrites any localized `resources/**/appinfo.json` copies to
  match, because a stale id (e.g. the stock fork's `com.palm.app.musicplayer`)
  makes LunaSysMgr silently refuse to register the app.
- The backend binary and librespot are deployed as native components, not
  packaged inside the app ipk — the app only ever talks to `127.0.0.1`.
- `palm-install`/`ipkg` via non-root tooling does **not** run
  `postinst`/`prerm` — anything requiring privilege escalation must be
  installed through Preware or WebOS Quick Install.
- Multiple historical app IDs exist in `build-output/` from earlier
  iterations (`com.hedami.musicplayerremix`, `com.herrie.music.apple`,
  `com.herrie.musicspotify`) — only `org.webosports.app.music` is current.

## Useful Commands

```bash
# Package the UI app
./build.sh                      # -> build-output/org.webosports.app.music_<ver>_all.ipk

# Cross-compile the Go backend for the device
cd service && GOOS=linux GOARCH=arm GOARM=7 go build -o spotify-webos-service .

# Install (via Preware/WebOS Quick Install path for postinst support) and launch
palm-install build-output/org.webosports.app.music_*.ipk
palm-launch org.webosports.app.music && palm-log -f org.webosports.app.music

# Quick file push during active on-device iteration
novacom put file:///usr/palm/applications/org.webosports.app.music/source/app.js \
  < app/source/app.js
```
