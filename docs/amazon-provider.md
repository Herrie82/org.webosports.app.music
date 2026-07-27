# Amazon Music connector — design sketch + reality check

## What we're actually building against
`AmineSoukara/amazon-music` is **not** a self-hostable API — it's a thin client for the
author's server **`https://amz.dezalty.com`**, which performs Amazon auth + the Widevine
CDM/key extraction server-side. Confirmed from source: no FastAPI app, no `pywidevine`,
no `.wvd` in the repo; auth is a **bearer token to dezalty.com** (from the star-gate), not
to Amazon. So the `amazonProvider` below is a client to that middleman (base URL made
configurable so a future self-hosted equivalent can drop in).

### API contract (Bearer `<dezalty-token>`, base `https://amz.dezalty.com`)
| Method | Path | Params | Response (relevant fields) |
|--------|------|--------|-----------------------------|
| GET | `/search` | `query`, `type`, `max_results` | tracks: id, title, artist, album, image, duration_ms *(exact field names TBC)* |
| GET | `/track` | `id` | track metadata |
| GET | `/stream_urls` | `id` | list of `{quality, bandwidth, codecs, pssh, base_url, segments}` — `base_url` is the **encrypted** CENC MP4 |
| POST | `/widevine_key` | `{"pssh": "<b64>"}` | `{"data": "<hex AES key>"}` (server runs the CDM) |

### Playback flow (per track)
```
/stream_urls?id=  -> pick stream with max bandwidth
POST /widevine_key {pssh}  -> hex content key
download base_url (ciphertext MP4)  -> /media/internal/amz-<id>.enc.m4a
ffmpeg -decryption_key <hex> -i enc.m4a -c:a copy  -> amz-<id>.m4a  (CENC AES-CTR decrypt)
play amz-<id>.m4a via the LOCAL path (gst decodebin -> ffaudioresample -> pulsesink media.role=music)
```
This is **download-then-play**, so it slots into the *local* playback path, not the simple
stream-URL path. Needs the **ffmpeg CLI** available where the decrypt runs (see hosting).

### Hosting the decrypt (pick one)
1. **Sidecar (recommended):** run a small helper (this Go provider, or the Python client) on
   a capable host; it returns a decrypted file/URL; the TouchPad just plays it. Keeps ffmpeg
   + the dezalty calls off the 2011 device.
2. **On-device:** needs the `ffmpeg` CLI on the TouchPad (we have gst/ffaudioresample libs,
   but not necessarily the `ffmpeg` binary) + disk for temp ciphertext. Heavier.

## Sketch — `service/amazonprovider.go` (NOT yet wired into main.go)
```go
package main

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "os/exec"
    "path/filepath"
    "sort"
    "strings"
    "time"
)

// amazonProvider is a client for an Amazon-Music resolver service (default the
// third-party amz.dezalty.com). It does NOT talk to Amazon directly and holds no
// Amazon credentials — only a bearer token for the resolver. Encrypted CENC audio
// is fetched, the Widevine content key is requested from the resolver, and the
// track is decrypted locally with ffmpeg, then played via the local file path.
//
// Config (both optional; provider self-disables if the token is absent):
//   /media/internal/amazon-base   -> base URL (default https://amz.dezalty.com)
//   /media/internal/amazon-token  -> bearer token for the resolver
type amazonProvider struct {
    base  string
    token string
    hc    *http.Client
}

func newAmazonProvider() *amazonProvider {
    base := "https://amz.dezalty.com"
    if b, err := os.ReadFile("/media/internal/amazon-base"); err == nil {
        if s := strings.TrimSpace(string(b)); s != "" {
            base = s
        }
    }
    tok := ""
    if b, err := os.ReadFile("/media/internal/amazon-token"); err == nil {
        tok = strings.TrimSpace(string(b))
    }
    return &amazonProvider{base: base, token: tok, hc: &http.Client{Timeout: 30 * time.Second}}
}

func (a *amazonProvider) ID() string   { return "amazon" }
func (a *amazonProvider) Name() string { return "Amazon Music" }
func (a *amazonProvider) enabled() bool { return a.token != "" }

func (a *amazonProvider) do(ctx context.Context, method, path string, body []byte, out interface{}) error {
    var r *http.Request
    var err error
    if body != nil {
        r, err = http.NewRequestWithContext(ctx, method, a.base+path, bytes.NewReader(body))
        r.Header.Set("Content-Type", "application/json")
    } else {
        r, err = http.NewRequestWithContext(ctx, method, a.base+path, nil)
    }
    if err != nil {
        return err
    }
    r.Header.Set("Authorization", "Bearer "+a.token)
    r.Header.Set("Accept", "application/json")
    resp, err := a.hc.Do(r)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    switch resp.StatusCode {
    case 200:
        return json.NewDecoder(resp.Body).Decode(out)
    case 401, 422:
        return fmt.Errorf("amazon resolver: invalid token")
    case 403:
        return fmt.Errorf("amazon resolver: banned")
    case 429:
        return fmt.Errorf("amazon resolver: rate limited")
    default:
        return fmt.Errorf("amazon resolver: http %d", resp.StatusCode)
    }
}

// --- Search --------------------------------------------------------------
// NOTE: field names below are best-guess; confirm against a live /search body.
func (a *amazonProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
    if !a.enabled() {
        return nil, fmt.Errorf("amazon not configured (no token in /media/internal/amazon-token)")
    }
    if query == "" {
        return []providerTrack{}, nil
    }
    if limit <= 0 || limit > 50 {
        limit = 25
    }
    var res struct {
        Tracks []struct {
            ID       string `json:"id"`
            Title    string `json:"title"`
            Artist   string `json:"artist"`
            Album    string `json:"album"`
            Image    string `json:"image"`
            Duration int    `json:"duration_ms"`
        } `json:"tracks"`
    }
    q := fmt.Sprintf("/search?type=tracks&max_results=%d&query=%s", limit, urlEncode(query))
    if err := a.do(ctx, http.MethodGet, q, nil, &res); err != nil {
        return nil, err
    }
    out := []providerTrack{}
    for _, t := range res.Tracks {
        out = append(out, providerTrack{
            ID: t.ID, Provider: "amazon", Title: t.Title, Artist: t.Artist,
            Album: t.Album, Thumbnail: t.Image, DurationMs: t.Duration,
            Path: "amazon:track:" + t.ID, // resolved+decrypted on play
        })
    }
    return out, nil
}

// --- StreamURL: resolve + decrypt to a local file, return file path ------
// Returns a file:// path to decrypted audio; the play path plays it locally.
func (a *amazonProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
    if !a.enabled() {
        return "", fmt.Errorf("amazon not configured")
    }
    // 1. stream_urls -> pick best by bandwidth
    var streams []struct {
        Quality   string `json:"quality"`
        Bandwidth int    `json:"bandwidth"`
        Codecs    string `json:"codecs"`
        PSSH      string `json:"pssh"`
        BaseURL   string `json:"base_url"`
    }
    if err := a.do(ctx, http.MethodGet, "/stream_urls?id="+urlEncode(trackID), nil, &streams); err != nil {
        return "", err
    }
    if len(streams) == 0 {
        return "", fmt.Errorf("amazon: no streams for %s", trackID)
    }
    sort.Slice(streams, func(i, j int) bool { return streams[i].Bandwidth > streams[j].Bandwidth })
    best := streams[0]

    // 2. widevine_key
    keyBody, _ := json.Marshal(map[string]string{"pssh": best.PSSH})
    var keyRes struct {
        Data string `json:"data"` // hex AES key
    }
    if err := a.do(ctx, http.MethodPost, "/widevine_key", keyBody, &keyRes); err != nil {
        return "", err
    }
    if keyRes.Data == "" {
        return "", fmt.Errorf("amazon: empty widevine key")
    }

    // 3. download ciphertext
    enc := filepath.Join("/media/internal", "amz-"+safe(trackID)+".enc")
    dec := filepath.Join("/media/internal", "amz-"+safe(trackID)+".m4a")
    if err := downloadTo(ctx, a.hc, best.BaseURL, enc); err != nil {
        return "", err
    }
    defer os.Remove(enc)

    // 4. ffmpeg CENC decrypt (AES-CTR) — needs ffmpeg CLI on PATH
    cmd := exec.CommandContext(ctx, "ffmpeg", "-y",
        "-decryption_key", keyRes.Data, "-i", enc, "-c:a", "copy", dec)
    if out, err := cmd.CombinedOutput(); err != nil {
        return "", fmt.Errorf("ffmpeg decrypt failed: %v: %s", err, out)
    }
    return "file://" + dec, nil // play via the local/gst path
}

// helpers urlEncode/safe/downloadTo omitted for brevity (net/url, sanitise id, io.Copy)
```

## Wiring (when/if adopted)
- In `main.go`: `if p := newAmazonProvider(); p.enabled() { registerProvider(p) }` — so it only
  appears when a token file exists.
- Playback: `amazon:track:<id>` resolves via `StreamURL` to a `file://` path; the router/local
  path plays it (or extend `playStreamURL` to accept `file://`). ffmpeg CLI must be present where
  the decrypt runs (device or sidecar).
- Requirements: a dezalty.com **bearer token** (star-gate), **ffmpeg CLI**, temp disk on
  `/media/internal`.

## Recommendation
- If you accept a **third-party dependency on dezalty.com** (privacy, rate-limit/ban, it can
  vanish), this is buildable and would play Amazon Music on the device — but it's **not** the
  self-contained, librespot-class integration Spotify got.
- If you want **self-contained Amazon Music**, this repo provides nothing toward it; that path
  means reverse-engineering Amazon's own auth + running a real Widevine L3 CDM (`pywidevine` +
  a `.wvd`) yourself — a much larger effort, and the genuinely hard part.
- Given the trade-offs, Amazon Music stays **below** Spotify (done) and the open stream-URL
  services (SoundCloud/Tidal/Qobuz/Deezer) in priority. Treat this sketch as an optional,
  clearly-labelled "via third-party resolver" connector, gated behind an explicit token.
```
