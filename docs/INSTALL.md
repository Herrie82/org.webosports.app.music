# Installing Music+Spotify on a device

This covers building and installing the ipks. For the one-time per-device
secrets (Spotify client id, Apple's `device.wvd`, …) that sign-in actually
needs, see `docs/PROVISIONING.md` — read that too, not just this page.

## Prerequisites

- **Preware** or **WebOS Quick Install** on the device/host. This is not
  optional: every ipk here ships a `postinst` that installs the backend
  daemon, and `palm-install` (and ipkg's own `-o`/offline-root mode) never
  run `postinst` scripts. If you install through anything else, the account
  types and backend will silently never start.
- Developer Mode enabled on the device (for `novacom`/sideloading).

## What gets built

```bash
./build.sh                                  # base package (see below)
./deploy/build-connector-ipk.sh <provider>  # one ipk per provider you want
```

`<provider>` is one of: `spotify`, `apple`, `deezer`, `tidal`, `qobuz`,
`soundcloud`, `jamendo`, `archive`. Run the connector script once per
provider; each produces its own small ipk in `build-output/`.

If you've dropped the matching file into `deploy/secrets/` first (see
`docs/PROVISIONING.md`), the Spotify/Apple/Jamendo connector ipks bundle
that secret into their own `postinst` automatically — no separate step,
no manual on-device file pushing needed for those three.

## Install order

1. **Base package** — `org.webosports.app.music_<ver>_all.ipk`.
   Contains the Enyo UI app, the `musicauth` validator app (shared by every
   provider's sign-in screen), the Go backend daemon, and its upstart job.
   **Install this first.** Nothing else works without it.
2. **Connector ipk(s)** — `org.webosports.app.music.<provider>_<ver>_all.ipk`.
   Each adds one account type to the system Accounts app. Install as many as
   you want, in any order, side by side — they don't conflict with each
   other.

Install both kinds the same way: open the ipk in Preware or WebOS Quick
Install and let it run. `Description` and version numbers are visible there
if you want to confirm what you're installing before confirming.

## After installing

1. Open the **Accounts** app → **Add Account** → pick a provider you
   installed a connector for.
2. Spotify/Apple/Tidal open a sign-in screen; Deezer/Qobuz ask for
   email+password; Jamendo/SoundCloud/Archive/YouTube just add immediately
   (no login).
3. If Spotify or Apple Music don't get past sign-in, it's almost certainly
   a missing secret (client id / `device.wvd`) — see
   `docs/PROVISIONING.md`, which also has the exact commands to verify each
   one worked.

## Reinstalling / upgrading

Bump the version in `app/appinfo.json` (base) before rebuilding if you want
Preware to treat it as an upgrade rather than a no-op reinstall — ipkg can
silently skip re-running `postinst` for a same-version reinstall. Connector
ipks read their version from `deploy/build-connector-ipk.sh`'s `VER`
default; override with `VER=x.y.z ./deploy/build-connector-ipk.sh <provider>`
if you need to force one specific connector to reinstall without bumping
everything.

## Uninstalling

Each connector's `prerm` removes only that connector's own account
template. The base package's `prerm` stops the backend daemon and removes
its upstart job, but **deliberately leaves**
`/media/cryptofs/spotify-webos/`'s cached credentials/tokens/library data in
place — reinstalling finds your accounts already signed in.

## Verifying an install worked (no device screen needed)

Useful when scripting this over `novacom` rather than watching the UI:

```bash
# Is the backend actually running and accepting connections?
novacom -d <device> run file:///usr/bin/wget -- -q -O - http://127.0.0.1:8730/auth/status

# Does the Accounts service see the account type you just installed?
novacom -d <device> run file:///usr/bin/luna-send -- -n 1 palm://com.palm.service.accounts/listAccountTemplates '{}'

# After actually adding an account through the UI, confirm it landed in the DB:
novacom -d <device> run file:///usr/bin/luna-send -- -n 1 palm://com.palm.service.accounts/listAccounts '{}'
```

See `docs/PROVISIONING.md` for the equivalent checks specific to the
Spotify/Apple secrets.
