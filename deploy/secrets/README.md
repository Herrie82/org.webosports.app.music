# deploy/secrets/ — local staging for device provisioning secrets

`deploy/build-secrets-ipk.sh` packages the files in this directory into an
installable ipk. The files themselves are **personal credentials, never
committed** (see the root `.gitignore` — `spotify-client-id`, `device.wvd`,
`jamendo-clientid` are all ignored by name, wherever they appear).

Drop your own values here before running the build script:

| File | Required for | Where it came from |
|---|---|---|
| `spotify-client-id` | Spotify sign-in | Your own app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) — Redirect URI must be `http://127.0.0.1:8730/auth/callback` exactly. |
| `device.wvd` | Apple Music sign-in | A personal Widevine L3 CDM device certificate. |
| `jamendo-clientid` (optional) | Avoiding Jamendo's demo rate limit | Your own Jamendo API client id. |

See `docs/PROVISIONING.md` for the full picture (what each secret unlocks, what
happens without it, how to verify it worked).
