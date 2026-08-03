# Routing music connectors through the Accounts app (Synergy-style)

Design for making each music service a webOS **account type**, so users add them
via the Accounts app ("Add account → Spotify / YouTube Music / …"), the login
runs through the shared OAuth validator, credentials are stored per-account, and
the music backend/app consume them. Grounded in `webos-synergy-revival` (cloud +
messaging connectors) — the same machinery, minus a native capability.

## Decision: we define our own MUSIC capability

Stock webOS Accounts ships capabilities CONTACTS, CALENDAR, EMAIL, MESSAGING/IM,
PHONE, DOCUMENTS (what the cloud-storage connectors use) — there is no MUSIC one.
Since this is our own webOS fork, **we define a new `MUSIC` capability** (subtype
`STREAMING`) and own it, rather than shoehorning music into a credential-store
account. The Spotify account template declares a `capabilityProvider` with
`capability:"MUSIC"`; our app filters accounts by that capability, exactly how a
messaging app filters MESSAGING accounts.

The capability is declared *without* bus callbacks (`onEnabled`/`onDelete`/
`implementation`) — our backend is a localhost HTTP server, not a luna-bus
service, so there's nothing for Accounts to call back into. The account still
functions as the per-service credential store; the MUSIC capability is what makes
it a first-class, filterable account type. (If a given webOS build's Accounts
service rejects an unknown capability at template-load, the fallback is
`capabilityProviders: []` — a pure credential-store account — with no other
change. On-device testing settles which the build accepts.)

## Pieces per service (mirrors a cloud connector)

For each service `<svc>` (spotify, youtube, soundcloud, deezer, tidal):

1. **Account template** — `/usr/palm/public/accounts/org.webosports.app.music.<svc>/org.webosports.app.music.<svc>.json`:
```json
[{
  "templateId": "org.webosports.app.music.<svc>",
  "loc_name": "<Service>",
  "icon": { "loc_32x32": "images/<svc>-32.png", "loc_48x48": "images/<svc>-48.png" },
  "validator": { "customUI": { "appId": "org.webosports.app.musicauth", "name": "validator.html" } },
  "readPermissions":  ["org.webosports.app.music.service", "org.webosports.app.music"],
  "writePermissions": ["org.webosports.app.music.service", "org.webosports.app.music"],
  "capabilityProviders": []
}]
```
   (No capabilityProviders — credential-store account. read/writePermissions gate
   who may `readCredentials`, so the backend service + app are listed.)

2. **Validator app** — `org.webosports.app.musicauth` with `validator.html`, a thin reuse of
   `com.palm.app.cloud-auth`'s pattern (the embedded **atlas-simple** WebView OAuth we
   already got working for Spotify): runs the service's OAuth, and on success returns
   `{ returnValue:true, credentials:{ common:{ access_token, refresh_token, expiry } }, template:"org.webosports.app.music.<svc>" }`
   to Accounts, which persists the credentials against the new account. One validator
   app handles all services (switch by the template it's launched for).

3. **LS2 roles** (the easily-missed part, per [[connector-ls2-roles]]) —
   `/usr/share/ls2/roles/{prv,pub}/org.webosports.app.music.service.json` allowing the
   backend to call `com.palm.service.accounts`; and the validator app's role. Without
   these, `readCredentials` → "not permitted".

## Auth + credential flow

```
Accounts UI: Add account → org.webosports.app.music.spotify
   → launches validator (org.webosports.app.musicauth/validator.html) in customUI
   → atlas-simple WebView OAuth (the flow we already built) → token
   → validator returns { credentials:{common:{access_token,refresh_token,expiry}}, template }
   → Accounts stores it; a new accountId exists.

Backend (music service) startup / on demand:
   listAccounts (filter templateId in our set) → for each accountId:
     readCredentials { accountId, name:"common" } → token
     → build a MusicProvider for that account (Spotify→librespot+Web API; YouTube→…)
```

Backend credential helper (mirror cloud's `_cloudcore/creds.js`):
```
readCredentials:  palm://com.palm.service.accounts/readCredentials  { accountId, name:"common" }
writeCredentials: palm://com.palm.service.accounts/writeCredentials { accountId, name:"common", credentials }
listAccounts:     palm://com.palm.service.accounts/listAccounts     -> filter by templateId
```
This replaces the current single-file token store (`/media/internal/spotify-token.json`)
with per-account credentials once multi-account lands (keep the file path as a
fallback for the standalone/dev case).

## How it maps to the MusicProvider framework (already built)

- Each **account instance** → one `MusicProvider` instance seeded with that account's
  credentials. `providers` becomes keyed by `accountId` (not just service id).
- `/providers` lists the accounts (id, service, display name) from `listAccounts`.
- `/provider/<accountId>/search|play` uses that account's provider + token.
- The Enyo app's nav "sources" = the accounts (Local + each music account), via
  `kindMusicIndex`/`kindStreamManager` (planned). "Add a service" is now purely an
  Accounts-app action — genuinely Synergy-for-music.

## Build order to adopt this
1. `MusicProvider` framework — DONE (provider.go etc.).
2. Backend credential helper (readCredentials/writeCredentials/listAccounts) + ls2 role.
3. `org.webosports.app.musicauth` validator app (reuse cloud-auth's atlas-simple OAuth).
4. Account template(s) + icons deployed to `/usr/palm/public/accounts/…`.
5. Backend: build providers from accounts (keyed by accountId); token-file becomes fallback.
6. Enyo source selector listing accounts.

Nothing here conflicts with what's built — it swaps the single-token store for
per-account credentials and adds the Accounts-app front door.

## ✅ PoC BUILT (2026-07-27) — Spotify, additive, not yet device-verified

Chose Spotify as the PoC service (it already plays, so Accounts wiring is the only
new variable). All artifacts compile; **device deploy/verify is blocked on the
host `novacomd` transport** (it went to a defunct zombie mid-session — needs a
host-side restart, see runbook). Built:

- **Account template + MUSIC capability** — `deploy/accounts/org.webosports.app.music.spotify/`
  (template JSON declaring `capability:"MUSIC"` + Spotify-green 32/48px icons).
- **Backend `service/creds.go`** — reads/writes an account's `common` credentials
  via `luna-send -a org.webosports.app.music.service` to `com.palm.service.accounts`
  (`listAccounts`/`readCredentials`/`writeCredentials`); `accountToken()` returns
  the first music account's token. Handles the 3 credential-nesting shapes.
- **`service/token.go`** — `restoreSession()` now prefers account credentials and
  falls back to the flat token file; refreshed tokens are written back to the
  account (`currentAccountID`).
- **`service/auth.go`** — new localhost `/auth/token` returns the current token in
  `{accessToken,refreshToken,expiry}` shape for the validator app.
- **Validator app `app-musicauth/`** (`org.webosports.app.musicauth`) — the "Add account"
  customUI: embedded atlas-simple WebView OAuth → `/auth/token` → returns
  `credentials.common` via `enyo.CrossAppResult`. Needs one on-device iteration
  pass (activation-param + card lifecycle).
- **LS2 role** `deploy/ls2-roles/org.webosports.app.music.service.json` (candidate;
  only needed if `readCredentials` returns a permission error).
- **Deploy/provision scripts** — `deploy/deploy-accounts.sh` (host: build ARM
  backend, stage, push, install), `deploy/ondevice-install-accounts.sh` (remount
  rw, drop template+role, restart Accounts + backend), `deploy/provision-spotify-account.sh`
  (headless: create account + store the existing token as credentials + read back
  — the PoC proof path that substitutes for the validator UI).

### Runbook (once host transport is back)
```
# 0. host: revive the novacom daemon (it was a defunct zombie)
sudo pkill -9 novacomd; sudo novacomd &        # or replug the TouchPad USB
novacom -l                                       # confirm topaz-linux listed

# 1. deploy template + role + rebuilt backend, and register the account type
DEVICE=topaz-linux bash deploy/deploy-accounts.sh
#    -> step 5 prints the registered org.webosports.app.music.* template (or NOT REGISTERED)

# 2. headless PoC: create a Spotify account from the existing token + read it back
novacom -d topaz-linux run file:///bin/sh -- -c \
  'sh /media/internal/mp-accounts/provision-spotify-account.sh'
#    -> expect readCredentials to echo the accessToken back (backend path proven)

# 3. restart backend and confirm it sourced the token FROM the account
novacom -d topaz-linux run file:///bin/sh -- -c \
  'initctl restart spotify-webos-service; sleep 2; tail -5 /var/log/spotify-webos-service.log'
#    -> expect: "using credentials from account …" then "restored Spotify session from account …"
#    -> then playback works exactly as before, now sourced from the account.
```
Open verification unknowns (what device testing will settle): (a) does this build's
Accounts service accept `capability:"MUSIC"`; (b) exact `addAccount` signature
(the script prints raw replies to adapt); (c) whether `luna-send -a` needs the ls2
role for `readCredentials`.
```
