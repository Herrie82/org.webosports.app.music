package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
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
	extra                    map[string]interface{}
}

// Player clients that return direct (un-ciphered) audio URLs to a server, tried in
// order until one yields a playable audio format. IOS is deliberately omitted — it
// now 400s with "Precondition check failed" (needs attestation we can't provide).
// ANDROID_VR is the most reliable; embedded players bypass many age/precondition
// gates.
var itPlayerClients = []itClient{
	{name: "ANDROID_VR", version: "1.60.19",
		userAgent: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; Quest 3)",
		extra:     map[string]interface{}{"androidSdkVersion": 32, "deviceModel": "Quest 3"}},
	{name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", version: "2.0",
		extra: map[string]interface{}{"clientScreen": "EMBED"}},
	{name: "WEB_EMBEDDED_PLAYER", version: "1.20240723.01.00",
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
		extra:     map[string]interface{}{"clientScreen": "EMBED"}},
	{name: "ANDROID", version: "19.29.37",
		userAgent: "com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip",
		extra:     map[string]interface{}{"androidSdkVersion": 30}},
}

var itHTTP = &http.Client{Timeout: 25 * time.Second}

// innertubePost issues an InnerTube v1 call and returns the raw top-level fields.
func innertubePost(ctx context.Context, host, endpoint string, cl itClient, body map[string]interface{}) (map[string]json.RawMessage, error) {
	client := map[string]interface{}{
		"clientName": cl.name, "clientVersion": cl.version, "hl": "en", "gl": "US",
	}
	for k, v := range cl.extra {
		client[k] = v
	}
	full := map[string]interface{}{"context": map[string]interface{}{"client": client}}
	for k, v := range body {
		full[k] = v
	}
	buf, _ := json.Marshal(full)
	url := "https://" + host + "/youtubei/v1/" + endpoint + "?key=" + innertubeKey + "&prettyPrint=false"
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if cl.userAgent != "" {
		req.Header.Set("User-Agent", cl.userAgent)
	}
	req.Header.Set("Origin", "https://"+host)
	resp, err := itHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		snip, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
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
	var lastErr error
	for _, cl := range itPlayerClients {
		res, err := innertubePost(ctx, "www.youtube.com", "player", cl, map[string]interface{}{
			"videoId": trackID, "contentCheckOk": true, "racyCheckOk": true,
		})
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
		}
		if json.Unmarshal(sd, &streaming) != nil {
			continue
		}
		best := ""
		for _, want := range []int{140, 251, 250, 249} { // AAC first, then Opus tiers
			for _, f := range streaming.AdaptiveFormats {
				if f.Itag == want && f.URL != "" {
					best = f.URL
					break
				}
			}
			if best != "" {
				break
			}
		}
		if best == "" { // any audio-only with a direct URL
			for _, f := range streaming.AdaptiveFormats {
				if strings.HasPrefix(f.MimeType, "audio/") && f.URL != "" {
					best = f.URL
					break
				}
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
	web := itClient{name: "WEB", version: "2.20240726.00.00", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
	res, err := innertubePost(ctx, "www.youtube.com", "search", web, map[string]interface{}{
		"query":  query,
		"params": "EgIQAQ%3D%3D", // filter: videos only
	})
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
