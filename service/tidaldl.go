package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// tidalDL downloads DRM-free FLAC from Tidal using the user's OWN OAuth session
// (the unofficial tidalapi device flow) — direct api.tidal.com, no mirror/relay.
//
// Credentials: /media/internal/tidal-token, a JSON blob captured from a tidalapi
// device login (see report). The access token is refreshed against
// auth.tidal.com on 401 and the new token persisted back to that file.
//
// client_id/secret: the tidalapi Automotive client. Streaming requires the versioned
// endpoint (playbackinfopostpaywall/v4) — this client + /v4 is the combo tidalapi uses.
// (The bare playbackinfopostpaywall gives 4005 "Asset is not ready" for every track; the
// Fire TV client 7m7Ap0JC9j1cOM3n gives 4022 "client does not exist" on /v4.)
const (
	tidalClientID     = "zU4XHVVkc2tDPo4t"
	tidalClientSecret = "VJKhDFqJPqvsPVNBV6ukXTJmwlvbttP7wlMlrc72se4="
	tidalTokenFile    = "/media/internal/tidal-token"
	tidalAPIBase      = "https://api.tidal.com/v1"
	tidalAuthTokenURL = "https://auth.tidal.com/v1/oauth2/token"
)

// tidalToken mirrors /media/internal/tidal-token.
type tidalToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	CountryCode  string `json:"country_code"`
	UserID       int64  `json:"user_id"`
	Expiry       string `json:"expiry"` // RFC3339, optional
}

type tidalDL struct {
	mu  sync.Mutex
	tok tidalToken
	ok  bool
}

func newTidalDL() *tidalDL {
	t := &tidalDL{}
	b, err := os.ReadFile(tidalTokenFile)
	if err != nil {
		return t
	}
	if json.Unmarshal(b, &t.tok) == nil && t.tok.AccessToken != "" {
		t.ok = true
		if t.tok.CountryCode == "" {
			t.tok.CountryCode = "US"
		}
	}
	return t
}

func (t *tidalDL) ID() string      { return "tidal" }
func (t *tidalDL) Name() string    { return "Tidal" }
func (t *tidalDL) Available() bool { return t.ok }

// fetchUsername returns the account's Tidal username (or nickname/email/first name),
// so the created account is labelled with the real user rather than "Tidal". Best-effort.
func (t *tidalDL) fetchUsername(ctx context.Context) string {
	t.mu.Lock()
	uid := t.tok.UserID
	t.mu.Unlock()
	if uid == 0 {
		return ""
	}
	u := fmt.Sprintf("%s/users/%d?countryCode=%s", tidalAPIBase, uid, url.QueryEscape(t.countryCode()))
	body, err := t.authGet(ctx, u)
	if err != nil {
		return ""
	}
	var r struct {
		Username  string `json:"username"`
		Nickname  string `json:"nickname"`
		Email     string `json:"email"`
		FirstName string `json:"firstName"`
	}
	if json.Unmarshal(body, &r) != nil {
		return ""
	}
	for _, s := range []string{r.Username, r.Nickname, r.Email, r.FirstName} {
		if s != "" {
			return s
		}
	}
	return ""
}

func (t *tidalDL) countryCode() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tok.CountryCode != "" {
		return t.tok.CountryCode
	}
	return "US"
}

// refresh swaps the refresh_token for a new access_token and persists it.
func (t *tidalDL) refresh(ctx context.Context) error {
	t.mu.Lock()
	rt := t.tok.RefreshToken
	t.mu.Unlock()
	if rt == "" {
		return fmt.Errorf("tidal: no refresh_token to refresh with")
	}
	form := url.Values{}
	form.Set("client_id", tidalClientID)
	form.Set("client_secret", tidalClientSecret)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", rt)
	form.Set("scope", "r_usr w_usr w_sub")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tidalAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return fmt.Errorf("tidal refresh http %d: %s", resp.StatusCode, tidalTrunc(string(body), 200))
	}
	var r struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		User        struct {
			CountryCode string `json:"countryCode"`
			UserID      int64  `json:"userId"`
		} `json:"user"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return err
	}
	if r.AccessToken == "" {
		return fmt.Errorf("tidal refresh: empty access_token")
	}
	t.mu.Lock()
	t.tok.AccessToken = r.AccessToken
	if r.ExpiresIn > 0 {
		t.tok.Expiry = time.Now().Add(time.Duration(r.ExpiresIn) * time.Second).Format(time.RFC3339)
	}
	if r.User.CountryCode != "" {
		t.tok.CountryCode = r.User.CountryCode
	}
	snapshot := t.tok
	t.mu.Unlock()
	if b, err := json.MarshalIndent(snapshot, "", "  "); err == nil {
		_ = os.WriteFile(tidalTokenFile, b, 0600) // best-effort persist
	}
	return nil
}

// authGet does a bearer GET, refreshing once on 401.
func (t *tidalDL) authGet(ctx context.Context, u string) ([]byte, error) {
	do := func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		t.mu.Lock()
		at := t.tok.AccessToken
		t.mu.Unlock()
		req.Header.Set("Authorization", "Bearer "+at)
		return http.DefaultClient.Do(req)
	}
	resp, err := do()
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		resp.Body.Close()
		if rerr := t.refresh(ctx); rerr != nil {
			return nil, rerr
		}
		resp, err = do()
		if err != nil {
			return nil, err
		}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("tidal http %d: %s", resp.StatusCode, tidalTrunc(string(body), 200))
	}
	return body, nil
}

// Resolve maps an ISRC to a Tidal track id. The private user-token API has no
// first-class ISRC filter, but searching the ISRC string returns the matching
// recording (Tidal indexes ISRC); we validate the isrc field when present.
func (t *tidalDL) Resolve(ctx context.Context, isrc string) (string, error) {
	if isrc == "" {
		return "", fmt.Errorf("no isrc")
	}
	cc := t.countryCode()
	u := fmt.Sprintf("%s/search/tracks?query=%s&limit=10&offset=0&countryCode=%s",
		tidalAPIBase, url.QueryEscape(isrc), url.QueryEscape(cc))
	body, err := t.authGet(ctx, u)
	if err != nil {
		return "", err
	}
	var r struct {
		Items []struct {
			ID   json.Number `json:"id"`
			ISRC string      `json:"isrc"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return "", err
	}
	if len(r.Items) == 0 {
		return "", fmt.Errorf("tidal: no match for isrc %s", isrc)
	}
	up := strings.ToUpper(isrc)
	for _, it := range r.Items {
		if strings.ToUpper(it.ISRC) == up {
			return it.ID.String(), nil
		}
	}
	return r.Items[0].ID.String(), nil // best-effort fallback
}

// FileURL resolves a LOSSLESS FLAC download URL via playbackinfopostpaywall.
func (t *tidalDL) FileURL(ctx context.Context, trackID string) (losslessFile, error) {
	cc := t.countryCode()
	u := fmt.Sprintf("%s/tracks/%s/playbackinfopostpaywall?audioquality=LOSSLESS&playbackmode=STREAM&assetpresentation=FULL&countryCode=%s",
		tidalAPIBase, url.PathEscape(trackID), url.QueryEscape(cc))
	body, err := t.authGet(ctx, u)
	if err != nil {
		return losslessFile{}, err
	}
	var pb struct {
		ManifestMimeType string `json:"manifestMimeType"`
		Manifest         string `json:"manifest"` // base64
		AudioQuality     string `json:"audioQuality"`
	}
	if err := json.Unmarshal(body, &pb); err != nil {
		return losslessFile{}, err
	}
	raw, err := base64.StdEncoding.DecodeString(pb.Manifest)
	if err != nil {
		return losslessFile{}, fmt.Errorf("tidal: manifest base64: %v", err)
	}
	// LOSSLESS FLAC => BTS manifest (application/vnd.tidal.bts): JSON with urls[].
	if strings.Contains(pb.ManifestMimeType, "bts") || (len(raw) > 0 && raw[0] == '{') {
		var m struct {
			MimeType string   `json:"mimeType"`
			Codecs   string   `json:"codecs"`
			URLs     []string `json:"urls"`
		}
		if err := json.Unmarshal(raw, &m); err != nil {
			return losslessFile{}, err
		}
		if len(m.URLs) == 0 {
			return losslessFile{}, fmt.Errorf("tidal: no urls in BTS manifest")
		}
		return losslessFile{URL: m.URLs[0], Format: "flac"}, nil
	}
	// Hi-Res (HI_RES_LOSSLESS) returns a DASH/MPD manifest with segmented media.
	// TODO: parse the MPD and reassemble segments. For now we request LOSSLESS
	// (single-URL BTS) above; surface a clear error if a DASH manifest appears.
	return losslessFile{}, fmt.Errorf("tidal: got DASH/hi-res manifest (%s); segment reassembly not implemented — LOSSLESS expected", pb.ManifestMimeType)
}

func tidalTrunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
