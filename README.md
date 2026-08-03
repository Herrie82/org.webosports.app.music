# Music+Spotify for webOS

A legacy-webOS music player that plays **local files _and_ Spotify**, built by
forking the open-source stock **Enyo** Music app and adding a Spotify backend
plus the rich features of Music Player (Remix).

> Status: **scaffold / feasibility spike.** The Enyo app forks and packages into
> an installable IPK today; the Spotify data + playback adapters and the Go
> backend are wired end-to-end but stubbed at the edges (marked `STATUS: scaffold`
> in each file) for on-device iteration.

## Three things this project combines

| # | Goal | Base / approach |
|---|------|-----------------|
| 1 | **Enyo music player** | Fork of `com.palm.app.musicplayer` (stock, open-source, Enyo 1-gen). Already plays local music. |
| 2 | **+ Spotify (local + remote)** | Add a Spotify data source and a librespot playback backend *alongside* the local ones, dispatched by track type. |
| 3 | **+ MPR features** | Re-implement Music Player (Remix)'s extras (bookmarks, smart playlists, lyrics, scrobbling, sleep timer, …) in Enyo. |

## Layout

```
app/                 Enyo app — fork of the stock Music player
  utility/
    mediaindex.js       local media (com.palm.db)        [stock]
    spotifyindex.js     Spotify data source (→ backend)  [added]
    audiomanager.js     local file playback (HTML5 Audio)[stock]
    librespotmanager.js Spotify playback (→ backend)     [added]
    audiorouter.js      routes each track local vs Spotify[added]
  ...
service/             Go backend (Spotify search + librespot control)
  main.go spotify.go player.go go.mod
librespot/           notes for the librespot ARM port (full-track audio)
reference/mpr-2.5.11/ extracted Music Player (Remix) — feature reference only
docs/                ARCHITECTURE.md, ROADMAP.md
build.sh             packages app/ into build-output/*.ipk
```

## Build

```bash
./build.sh                      # -> build-output/org.webosports.app.music_0.0.1_all.ipk

cd service                      # Go backend, cross-compiled for the device
GOOS=linux GOARCH=arm GOARM=7 go build -o spotify-webos-service .
```

See `docs/ARCHITECTURE.md` for how the pieces talk, `docs/ROADMAP.md` for the
build order and the MPR feature catalogue, `docs/INSTALL.md` for how to build
and install the ipks, and `docs/PROVISIONING.md` for the one-time per-device
setup (Spotify client id, Apple Music's `device.wvd`, …) needed after
installing before sign-in will actually work. See `CHANGELOG.md` for release
notes.
