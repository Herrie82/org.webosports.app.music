# Changelog

## 0.9.2 — 2026-08-03 — First public release

Music+Spotify for webOS: a local-files-and-streaming music player for
legacy Palm/HP webOS and webOS Open Source Edition (webosports) devices,
built on the stock Enyo Music app.

### What's in this release

- **Local playback** — the stock Music app experience, untouched.
- **Streaming providers, each as its own installable connector**: Spotify,
  Apple Music, Deezer, Tidal, Qobuz, SoundCloud, Jamendo, and the Internet
  Archive. Install only the ones you use.
- **Synergy integration** — every provider shows up as a normal account
  type in the system Accounts app (**Add Account → Spotify**, etc.), using
  the same account/validator framework as the stock IM and cloud
  connectors.
- A local backend service (`spotify-webos-service`, ARMv7) drives search,
  streaming, and sign-in for every provider over `127.0.0.1:8730` — the app
  never talks to the internet directly.

### Packaging

Two kinds of ipk, install the base one first:

- **`org.webosports.app.music`** (base) — the Enyo UI app, the shared
  sign-in/validator app, and the backend daemon.
- **`org.webosports.app.music.<provider>`** (connector, one per provider)
  — adds that provider's account type. Install as many as you want, side
  by side.

See `docs/INSTALL.md` for the full install order and prerequisites
(**Preware or WebOS Quick Install is required** — the backend and account
types are set up by a `postinst` script that plain `palm-install` does not
run).

### Before you sign in

Spotify and Apple Music each need a one-time device secret before sign-in
will work (a Spotify app client id you register yourself, and a Widevine
`device.wvd` for Apple Music) — see `docs/PROVISIONING.md`. Everything
else works with no setup beyond installing the connector.

### Known limitations

- Per the project status: this is an early-stage release. Expect rough
  edges, especially around first-time account setup on a freshly imaged
  device.
- Deezer, Tidal, and Qobuz require an active subscription with that
  service to play full tracks.
- Apple Music playback requires a personally-obtained Widevine L3 device
  credential; none is provided or distributable with this project.
