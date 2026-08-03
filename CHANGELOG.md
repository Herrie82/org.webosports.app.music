# Changelog

## 0.9.2 — 2026-08-03

### Packaging: split into a base package + per-provider connectors

Previously each provider's ipk carried its own full copy of the backend
binary, the musicauth validator app, and the LS2 role — ~18MB duplicated
per provider. Now:

- **`build.sh`** produces one **base package** (`org.webosports.app.music`):
  the Enyo UI app, the shared `musicauth` validator app, the Go backend
  daemon, and its upstart job. Install this first.
- **`deploy/build-connector-ipk.sh <provider>`** produces one small
  **connector ipk** per provider (spotify, apple, deezer, tidal, qobuz,
  soundcloud, jamendo, archive) — just that provider's account template,
  ~8KB instead of ~6MB. Install as many as you want, side by side.
- Per-provider secrets (Spotify client id, Apple's `device.wvd`, Jamendo
  client id) now bundle directly into their own connector ipk's `postinst`
  when present locally — installing "Spotify" gets you both the account
  type and the credential it needs, in one step. See
  `docs/PROVISIONING.md` and `deploy/secrets/README.md`.
- `deploy/build-apple-connector-ipk.sh`, the old fat single-provider
  builder, is removed — fully superseded.

See `docs/INSTALL.md` for the install order and `docs/PROVISIONING.md` for
device-secret setup.

### Rebrand: `com.herrie.*` → `org.webosports.app.*`

All account template ids, the musicauth app id, and LS2 role
`allowedNames` renamed from `com.herrie.*` to `org.webosports.app.*` to
match the project's actual vendor. Vendor set to "WebOS Ports", maintainer
to Herman van Hazendonk.

### Fixed: backend never actually served requests

Go's standard library dropped its `accept4`→`accept()` ENOSYS fallback for
every `GOOS` some time ago; `net.Listener.Accept()` now always calls
`accept4` unconditionally. This device's ARM kernel implements `accept` but
not `accept4` — the backend bound to `127.0.0.1:8730` and logged
"listening", but its accept loop died on the very first connection attempt,
silently, forever. Every request from the app looked like "the backend
isn't running." Fixed in `service/main.go` with a custom `net.Listener`
that calls the raw `SYS_ACCEPT` syscall directly.

### Fixed: our own LS2 role file broke `luna-send` device-wide

The base package's `postinst` used to install
`deploy/ls2-roles/org.webosports.app.music.service.json`, which declared
`"exeName": "/usr/bin/luna-send"` — the same executable the stock
`com.palm.lunasend.json` role already claims. Having both installed broke
`ls-hubd`'s ability to register **any** `luna-send` identity at all, from
any caller, until the conflicting file was removed and the device
rebooted. This is also very likely what caused the Accounts app to hang
forever on "Loading accounts" on a fresh device. `build.sh` no longer ships
or installs this file at all — the role file's own comment already said
the dev bus is permissive without it.

### Fixed: Spotify/Apple Music sign-in spinning forever with no feedback

`musicAuth.js`'s Spotify and Apple Music sign-in flows polled the backend
forever with no timeout and no error path — a permanently-failing state
(missing client id, wrong redirect URI, anything) looked identical to "just
still loading." Both now give up after ~2 minutes and show a real error.

### Fixed: secrets silently corrupting during on-device install

Discovered while wiring up bundled secrets:
- `echo "$var" | ...` for a multi-KB base64 string silently fails on
  BusyBox's shell (single command-line argument, not streamed) — switched
  to piping the payload in via a heredoc.
- Even via heredoc, this device's ancient OpenSSL 0.9.8 `base64 -d`
  silently emits **0 bytes** for an unwrapped multi-KB single line —
  switched the host-side encode to the standard 76-char MIME wrapping.
  Verified byte-exact via `md5sum` against the source file after the fix.

### Docs

- **`docs/INSTALL.md`** (new) — install order, prerequisites, verification
  commands.
- **`docs/PROVISIONING.md`** (new) — the one-time per-device secrets, what
  each unlocks, how to verify each worked.
- **`deploy/secrets/README.md`** (new) — how `deploy/build-connector-ipk.sh`
  picks up local secret files; never committed (gitignored by filename).
- `CLAUDE.md` / `README.md` updated with the `accept4` and LS2-role-conflict
  gotchas, so they don't get silently reintroduced.

### Also in this release

- webos-mcp wired up for this project (`CLAUDE.md` loads
  `webos://knowledge/all` at session start).
- App/musicauth version bumped to 0.9.2; connector ipks default to the same.
