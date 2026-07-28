package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"regexp"
	"strings"
	"sync"
	"time"
)

// youtubeProvider: a free, no-DRM source. The device has no Python/yt-dlp, so we
// talk to YouTube's InnerTube API DIRECTLY from the Go backend (self-contained, no
// middleman) — search via the WEB client, and resolve a direct audio stream URL via
// mobile/VR clients that return UN-ciphered URLs (no signature descrambling needed).
// The URL is then played by the shared gst stream player (curl | decodebin), which
// decodes AAC (itag 140, ffdec_aac) or Opus (itag 251, opusdec) — both present on
// the device. This establishes the stream-URL connector pattern.
type youtubeProvider struct{}

func (y *youtubeProvider) ID() string   { return "youtube" }
func (y *youtubeProvider) Name() string { return "YouTube Music" }

const innertubeKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"

type itClient struct {
	name, version, userAgent string
	num                      int // X-Youtube-Client-Name (0 = omit)
	extra                    map[string]interface{}
}

// Player clients that return direct (un-ciphered) audio URLs to a server, tried in
// order until one yields a playable audio format. IOS is deliberately omitted — it
// now 400s with "Precondition check failed" (needs attestation we can't provide).
// ANDROID_VR is the most reliable; embedded players bypass many age/precondition
// gates.
var itPlayerClients = []itClient{
	androidVRClient,
	{name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", version: "2.0",
		extra: map[string]interface{}{"clientScreen": "EMBED"}},
	{name: "WEB_EMBEDDED_PLAYER", version: "1.20240723.01.00",
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
		extra:     map[string]interface{}{"clientScreen": "EMBED"}},
	{name: "ANDROID", version: "19.29.37",
		userAgent: "com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip",
		extra:     map[string]interface{}{"androidSdkVersion": 30}},
}

// Clients used WITH the user's OAuth token (Authorization: Bearer). The token is
// issued for the "YouTube on TV" client, so it MUST be paired with the TVHTML5
// client context (other clients 400). Authenticated requests clear the bot-check,
// so official music resolves. Tried before the anonymous clients when signed in.
var itAuthedClients = []itClient{
	// Mobile clients return UN-ciphered URLs; with the OAuth token they also clear
	// the bot-check. TVHTML5 is a fallback (clears the check but returns ciphered
	// URLs we can't yet descramble).
	androidVRClient,
	{name: "ANDROID", version: "19.29.37",
		userAgent: "com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip",
		extra:     map[string]interface{}{"androidSdkVersion": 30}},
	{name: "TVHTML5", version: "7.20240724.13.00"},
}

// androidVRClient is the Oculus Quest ("VR") InnerTube client. Its player responses
// carry DIRECT, un-ciphered, un-throttled audio URLs and — crucially — it clears the
// "sign in to confirm you're not a bot" gate on OFFICIAL music tracks (the ATV art
// tracks) with NOTHING but an anonymous visitor session (visitorData + visitor
// cookies). No OAuth, no PoToken, no signature descrambling. This is the whole reason
// YouTube Music playback works self-contained on-device. Client name number is 28.
var androidVRClient = itClient{
	name: "ANDROID_VR", version: "1.65.10", num: 28,
	userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
	extra: map[string]interface{}{
		"deviceMake": "Oculus", "deviceModel": "Quest 3",
		"androidSdkVersion": 32, "osName": "Android", "osVersion": "12L",
	},
}

// itHTTP carries a cookie jar so the anonymous visitor cookies YouTube sets on the
// bootstrap page GET (VISITOR_INFO1_LIVE / VISITOR_PRIVACY_METADATA / YSC / SOCS) ride
// along on the subsequent InnerTube POSTs — required, together with visitorData, to
// clear the bot-check for official music.
var itHTTP = func() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Timeout: 25 * time.Second, Jar: jar}
}()

// ---- anonymous visitor session (visitorData) ----
// yt-dlp's trick: GET a normal YouTube page (which Set-Cookies a visitor session and
// embeds a matching "visitorData" token in its ytcfg), then send BOTH on every player
// call. Cached and refreshed lazily; a stale token just re-bootstraps.
var (
	ytVisMu     sync.Mutex
	ytVisData   string
	ytVisAt     time.Time
	ytVisitorRe = regexp.MustCompile(`"visitorData":\s*"([^"]+)"`)
)

const ytVisitorTTL = 3 * time.Hour

// ytVisitorData returns a cached visitorData token, bootstrapping one if missing/stale.
// force=true discards the cache first (used after a LOGIN_REQUIRED to get a fresh one).
func ytVisitorData(ctx context.Context, force bool) string {
	ytVisMu.Lock()
	defer ytVisMu.Unlock()
	if !force && ytVisData != "" && time.Since(ytVisAt) < ytVisitorTTL {
		return ytVisData
	}
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://www.youtube.com/?bpctr=9999999999&has_verified=1", nil)
	if err != nil {
		return ytVisData
	}
	// A browser UA on the bootstrap page so the ytcfg (and its visitorData) is present.
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := itHTTP.Do(req)
	if err != nil {
		log.Printf("youtube visitor bootstrap: %v", err)
		return ytVisData
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if m := ytVisitorRe.FindSubmatch(body); m != nil {
		ytVisData = string(m[1])
		ytVisAt = time.Now()
		log.Printf("youtube visitor bootstrap: got visitorData (len %d)", len(ytVisData))
	} else {
		log.Printf("youtube visitor bootstrap: visitorData not found in page")
	}
	return ytVisData
}

// innertubePost issues an InnerTube v1 call and returns the raw top-level fields.
// If bearer != "" the request is authenticated as the signed-in YouTube account
// (Authorization: Bearer), which clears the "confirm you're not a bot" gate.
func innertubePost(ctx context.Context, host, endpoint string, cl itClient, body map[string]interface{}, bearer, visitorData string) (map[string]json.RawMessage, error) {
	client := map[string]interface{}{
		"clientName": cl.name, "clientVersion": cl.version, "hl": "en", "gl": "US",
	}
	if visitorData != "" {
		client["visitorData"] = visitorData
	}
	for k, v := range cl.extra {
		client[k] = v
	}
	full := map[string]interface{}{"context": map[string]interface{}{"client": client}}
	for k, v := range body {
		full[k] = v
	}
	buf, _ := json.Marshal(full)
	// OAuth (bearer) requests must NOT carry the web API key — mixing them yields
	// http 400. Anonymous requests use the key.
	url := "https://" + host + "/youtubei/v1/" + endpoint + "?prettyPrint=false"
	if bearer == "" {
		url += "&key=" + innertubeKey
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if cl.userAgent != "" {
		req.Header.Set("User-Agent", cl.userAgent)
	}
	req.Header.Set("Origin", "https://"+host)
	if cl.num != 0 {
		req.Header.Set("X-Youtube-Client-Name", fmt.Sprintf("%d", cl.num))
		req.Header.Set("X-Youtube-Client-Version", cl.version)
	}
	if visitorData != "" {
		req.Header.Set("X-Goog-Visitor-Id", visitorData)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := itHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		snip, _ := io.ReadAll(io.LimitReader(resp.Body, 900))
		return nil, fmt.Errorf("innertube %s/%s: http %d: %s", cl.name, endpoint, resp.StatusCode, strings.TrimSpace(string(snip)))
	}
	var out map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// StreamURL resolves a direct audio URL for a videoId, preferring AAC (itag 140)
// then Opus (itag 251/250/249) — both decodable on-device.
func (y *youtubeProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	// Build the attempt list: anonymous clients FIRST — ANDROID_VR + a visitor session
	// resolves official music with no login, no cipher, no throttle. The OAuth clients
	// are only a fallback (and a stale TV-issued token otherwise just wastes attempts).
	type attempt struct {
		cl     itClient
		bearer string
	}
	var attempts []attempt
	for _, cl := range itPlayerClients {
		attempts = append(attempts, attempt{cl, ""})
	}
	token := ytAccessToken()
	if token != "" {
		for _, cl := range itAuthedClients {
			attempts = append(attempts, attempt{cl, token})
		}
	}
	// Anonymous visitor session — the key that clears the bot-check on official music
	// for ANDROID_VR. Fetched once, refreshed on demand if a call comes back LOGIN_REQUIRED.
	vd := ytVisitorData(ctx, false)
	log.Printf("youtube resolve %s: authed=%v visitor=%v (%d attempts)", trackID, token != "", vd != "", len(attempts))

	var lastErr error
	refreshedVD := false
	for _, a := range attempts {
		cl := a.cl
	retry:
		res, err := innertubePost(ctx, "www.youtube.com", "player", cl, map[string]interface{}{
			"videoId": trackID, "contentCheckOk": true, "racyCheckOk": true,
		}, a.bearer, vd)
		if err != nil {
			log.Printf("youtube player %s(%s): %v", cl.name, trackID, err)
			lastErr = err
			continue
		}
		// playability gate
		if ps, ok := res["playabilityStatus"]; ok {
			var st struct {
				Status string `json:"status"`
				Reason string `json:"reason"`
			}
			_ = json.Unmarshal(ps, &st)
			if st.Status != "" && st.Status != "OK" {
				// A bot/login gate usually means our visitor token went stale — mint a
				// fresh one and retry this client ONCE before giving up on it.
				if !refreshedVD && (st.Status == "LOGIN_REQUIRED" || strings.Contains(st.Reason, "bot")) {
					refreshedVD = true
					vd = ytVisitorData(ctx, true)
					if vd != "" {
						log.Printf("youtube player %s(%s): %s → retrying with fresh visitorData", cl.name, trackID, st.Status)
						goto retry
					}
				}
				lastErr = fmt.Errorf("%s: %s %s", cl.name, st.Status, st.Reason)
				log.Printf("youtube player %s(%s): %v", cl.name, trackID, lastErr)
				continue
			}
		}
		sd, ok := res["streamingData"]
		if !ok {
			lastErr = fmt.Errorf("%s: no streamingData", cl.name)
			continue
		}
		var streaming struct {
			AdaptiveFormats []struct {
				Itag            int    `json:"itag"`
				URL             string `json:"url"`
				MimeType        string `json:"mimeType"`
				SignatureCipher string `json:"signatureCipher"`
			} `json:"adaptiveFormats"`
			HlsManifestURL  string `json:"hlsManifestUrl"`
			DashManifestURL string `json:"dashManifestUrl"`
		}
		if json.Unmarshal(sd, &streaming) != nil {
			continue
		}
		log.Printf("youtube player %s(%s): formats=%d hls=%v dash=%v", cl.name, trackID,
			len(streaming.AdaptiveFormats), streaming.HlsManifestURL != "", streaming.DashManifestURL != "")
		// Pick the best audio format (AAC 140, then Opus tiers, then any audio),
		// taking either its direct URL or its ciphered form.
		var directURL, cipher string
		pick := func(itag int) bool {
			for i := range streaming.AdaptiveFormats {
				f := &streaming.AdaptiveFormats[i]
				match := itag > 0 && f.Itag == itag
				if itag == 0 {
					match = strings.HasPrefix(f.MimeType, "audio/")
				}
				if match {
					if f.URL != "" {
						directURL = f.URL
						return true
					}
					if f.SignatureCipher != "" {
						cipher = f.SignatureCipher
						return true
					}
				}
			}
			return false
		}
		for _, want := range []int{140, 251, 250, 249, 0} {
			if pick(want) {
				break
			}
		}
		best := directURL
		if best == "" && cipher != "" { // TVHTML5 gives ciphered URLs — descramble via base.js
			if u, derr := decipherSignatureCipher(ctx, cipher); derr == nil {
				best = u
				log.Printf("youtube player %s(%s): resolved via decipher", cl.name, trackID)
			} else {
				log.Printf("youtube player %s(%s): decipher failed: %v", cl.name, trackID, derr)
			}
		}
		if best != "" {
			log.Printf("youtube player %s(%s): resolved audio url", cl.name, trackID)
			return best, nil
		}
		lastErr = fmt.Errorf("%s: no direct audio url (ciphered?)", cl.name)
		log.Printf("youtube player %s(%s): %v", cl.name, trackID, lastErr)
	}
	return "", fmt.Errorf("youtube: could not resolve stream url: %v", lastErr)
}

// Search queries YouTube (WEB client, video filter) and returns normalised tracks.
func (y *youtubeProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	web := itClient{name: "WEB", version: "2.20240726.00.00", num: 1, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
	// Search is anonymous: the visitor session is enough. Never pass the OAuth token
	// here — it's issued for the TVHTML5 client and pairing it with WEB yields http 400
	// INVALID_ARGUMENT.
	res, err := innertubePost(ctx, "www.youtube.com", "search", web, map[string]interface{}{
		"query":  query,
		"params": "EgIQAQ%3D%3D", // filter: videos only
	}, "", ytVisitorData(ctx, false))
	if err != nil {
		return nil, err
	}
	tracks := parseYouTubeSearch(res, limit)
	return tracks, nil
}

// parseYouTubeSearch walks the WEB search response for videoRenderer items.
func parseYouTubeSearch(res map[string]json.RawMessage, limit int) []providerTrack {
	out := []providerTrack{}
	var top struct {
		Contents struct {
			TwoColumn struct {
				PrimaryContents struct {
					SectionList struct {
						Contents []struct {
							ItemSection struct {
								Contents []struct {
									Video *videoRenderer `json:"videoRenderer"`
								} `json:"contents"`
							} `json:"itemSectionRenderer"`
						} `json:"contents"`
					} `json:"sectionListRenderer"`
				} `json:"primaryContents"`
			} `json:"twoColumnSearchResultsRenderer"`
		} `json:"contents"`
	}
	if c, ok := res["contents"]; ok {
		_ = json.Unmarshal(c, &top.Contents)
	}
	for _, sec := range top.Contents.TwoColumn.PrimaryContents.SectionList.Contents {
		for _, it := range sec.ItemSection.Contents {
			if it.Video == nil || it.Video.VideoID == "" {
				continue
			}
			out = append(out, it.Video.toTrack())
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

type videoRenderer struct {
	VideoID string `json:"videoId"`
	Title   struct {
		Runs []struct {
			Text string `json:"text"`
		} `json:"runs"`
	} `json:"title"`
	OwnerText struct {
		Runs []struct {
			Text string `json:"text"`
		} `json:"runs"`
	} `json:"ownerText"`
	LengthText struct {
		SimpleText string `json:"simpleText"`
	} `json:"lengthText"`
	Thumbnail struct {
		Thumbnails []struct {
			URL string `json:"url"`
		} `json:"thumbnails"`
	} `json:"thumbnail"`
}

func (v *videoRenderer) toTrack() providerTrack {
	title, artist := "", ""
	if len(v.Title.Runs) > 0 {
		title = v.Title.Runs[0].Text
	}
	if len(v.OwnerText.Runs) > 0 {
		artist = v.OwnerText.Runs[0].Text
	}
	thumb := ""
	if n := len(v.Thumbnail.Thumbnails); n > 0 {
		thumb = v.Thumbnail.Thumbnails[n-1].URL // largest
	}
	return providerTrack{
		ID: v.VideoID, Provider: "youtube", Title: title, Artist: artist,
		Thumbnail: thumb, DurationMs: parseClockMs(v.LengthText.SimpleText),
		Path: "youtube:" + v.VideoID,
	}
}

// parseClockMs turns "3:45" / "1:02:03" into milliseconds.
func parseClockMs(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	parts := strings.Split(s, ":")
	sec := 0
	for _, p := range parts {
		n := 0
		for _, c := range p {
			if c < '0' || c > '9' {
				n = -1
				break
			}
			n = n*10 + int(c-'0')
		}
		if n < 0 {
			return 0
		}
		sec = sec*60 + n
	}
	return sec * 1000
}
