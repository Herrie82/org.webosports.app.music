# Device provisioning — one-time setup after install

Installing the ipks gets the app, the backend daemon, and the account types
onto the device. It does **not** by itself make Spotify or Apple Music able to
sign in — those need a couple of one-time secrets seeded on the device first,
outside of anything an ipk can ship (they're either developer credentials that
shouldn't be committed to the repo, or a personal file only the user has).

## Install order

1. **Base package** — `build.sh` → `build-output/org.webosports.app.music_<ver>_all.ipk`.
   Provides the Enyo UI app, the `musicauth` validator app, the backend binary,
   its LS2 role, and its upstart job. Install this first.
2. **Per-provider connector(s)** — `deploy/build-connector-ipk.sh <provider>` →
   `org.webosports.app.music.<provider>_<ver>_all.ipk`. Adds that provider's
   account type. Install one per provider you want (spotify, apple, deezer,
   tidal, qobuz, soundcloud, jamendo, archive).

Both need **Preware or WebOS Quick Install** (ipkg), not plain `palm-install`
— the postinst that wires up the backend/role/account-template never runs
otherwise. See `CLAUDE.md` for why.

## Required one-time secrets

All of these live under `spotifyDataDir` (`/media/cryptofs/spotify-webos/`,
see `service/paths.go`) **except** `device.wvd`, which stays on
`/media/internal/` so it's visible over USB. None of this is created by any
ipk — seed it once per physical device via novacom (or any file manager that
can reach `/media/cryptofs` and `/media/internal`).

| Provider | File | Required for | Notes |
|---|---|---|---|
| **Spotify** | `/media/cryptofs/spotify-webos/spotify-client-id` | Sign-in to work at all | Register your own app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Add Redirect URI `http://127.0.0.1:8730/auth/callback` **exactly**, or the OAuth exchange fails. The client ID identifies the *app*, not the end user — one ID is reused across every Spotify account that signs in, and across every physical device. Without this file, `/login` returns HTTP 412 and the sign-in screen times out after ~2 min with an error (see `app-musicauth/source/musicAuth.js`'s `spotifyPollOnce`). |
| **Apple Music** | `/media/internal/device.wvd` | Sign-in to work at all | A Widevine L3 CDM device certificate (client id + RSA key) — this is a personal credential, not something to commit or share. Without it, the sign-in screen shows "Put your device.wvd at /media/internal/device.wvd" instead of timing out silently (`applemusic.go`'s `appleWVDFile` check). |
| **Jamendo** | `/media/cryptofs/spotify-webos/jamendo-clientid` | Avoiding the demo app's rate limit | Optional — works without it, just rate-limited (`jamendo.go`). |

Everything else (`spotify-token.json`, `deezer-arl`, `qobuz-auth`,
`tidal-token`, `youtube-oauth.json`, `apple-music-user-token`) is a *per-user*
credential the backend writes itself the first time someone actually
completes that provider's sign-in flow — not something to pre-seed.

### Pushing a secret via novacom

```bash
# Spotify client id (one line, no trailing newline needed)
novacom -d <device> put file:///media/cryptofs/spotify-webos/spotify-client-id < spotify-client-id
novacom -d <device> run file:///bin/sh -- -c 'initctl stop spotify-webos-service; initctl start spotify-webos-service'

# Apple Music device.wvd
novacom -d <device> put file:///media/internal/device.wvd < device.wvd
```

The backend only reads the client-id file at startup, so restart
`spotify-webos-service` after changing it.

## Verifying it worked

```bash
# Spotify: should redirect to accounts.spotify.com with your client_id, not 412
novacom -d <device> run file:///usr/bin/wget -- -q -O - http://127.0.0.1:8730/login

# Apple Music: hasCDM should be true once device.wvd is in place
novacom -d <device> run file:///usr/bin/wget -- -q -O - http://127.0.0.1:8730/appleauth/status
```
