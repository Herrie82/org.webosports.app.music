package main

// Credential setup for the first-party music services (Qobuz / Deezer / Tidal),
// driven by the Accounts "Add a Music account" flow. The musicauth validator posts
// the user's credentials here; on success we persist the service's cred file and
// HOT-REGISTER the provider so it appears in /providers without a service restart.
//
//   Tidal  -> device-code OAuth (mirrors ytauth.go), writes tidal-token
//   Qobuz  -> email + password  (app_id/secret auto-scraped), writes qobuz-auth
//   Deezer -> ARL cookie,                                      writes deezer-arl
//
// SoundCloud / Jamendo / Internet Archive need no credentials (the validator
// registers those accounts directly) so they have no endpoint here.

import (
	"context"
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

const (
	qobuzAuthFile  = "/media/internal/qobuz-auth"
	deezerArlFile  = "/media/internal/deezer-arl"
	tidalDeviceURL = "https://auth.tidal.com/v1/oauth2/device_authorization"
	tidalScope     = "r_usr w_usr w_sub"
)

// refreshFirstPartyServices rebuilds the Qobuz/Tidal/Deezer adapters from their
// (freshly written) credential files and swaps them into the live provider registry
// and downloader list. Call AFTER a cred file is written and validated. It performs
// no network I/O itself, so it is safe to hold providersMu for its duration.
func refreshFirstPartyServices() {
	qz := newQobuzDL()
	td := newTidalDL()
	dz := newDeezerDL()

	providersMu.Lock()
	defer providersMu.Unlock()
	dzDL = dz
	// The Deezer provider is always present (public search + 30s preview); just
	// rebind it to the fresh adapter so full-track streaming picks up a new ARL.
	providers["deezer"] = &deezerProvider{dl: dz}
	if qz.Available() {
		providers["qobuz"] = &qobuzProvider{dl: qz}
	}
	if td.Available() {
		providers["tidal"] = &tidalProvider{dl: td}
	}
	// Rebuild the lossless downloader list from the three first-party services.
	downloaders = downloaders[:0]
	for _, d := range []LosslessDownloader{qz, td, dz} {
		if d.Available() {
			downloaders = append(downloaders, d)
		}
	}
}

// --- Qobuz: email + password -------------------------------------------------

// POST /qobuzauth/login {email, password}
func handleQobuzAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	email := strings.TrimSpace(body.Email)
	pw := strings.TrimSpace(body.Password)
	if email == "" || pw == "" {
		httpErr(w, http.StatusBadRequest, "email and password required")
		return
	}
	// Persist as (email\npassword); qobuzDL scrapes app_id/app_secret itself.
	if err := os.WriteFile(qobuzAuthFile, []byte(email+"\n"+pw+"\n"), 0600); err != nil {
		httpErr(w, http.StatusInternalServerError, "write cred: "+err.Error())
		return
	}
	// Validate by actually logging in; drop the cred file if it fails so we don't
	// leave a broken account that 502s on every search.
	q := newQobuzDL()
	if err := q.ensureAuth(r.Context()); err != nil {
		_ = os.Remove(qobuzAuthFile)
		httpErr(w, http.StatusBadGateway, "qobuz login failed: "+err.Error())
		return
	}
	refreshFirstPartyServices()
	writeJSON(w, map[string]interface{}{"ok": true, "username": email})
}

// --- Deezer: ARL cookie ------------------------------------------------------

// POST /dzauth/save {arl}
func handleDeezerAuthSave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Arl string `json:"arl"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	arl := strings.TrimSpace(body.Arl)
	if arl == "" {
		httpErr(w, http.StatusBadRequest, "arl required")
		return
	}
	if err := os.WriteFile(deezerArlFile, []byte(arl), 0600); err != nil {
		httpErr(w, http.StatusInternalServerError, "write cred: "+err.Error())
		return
	}
	// Validate the ARL (getUserData); drop it on failure — Deezer still works as
	// public preview-only without one.
	d := newDeezerDL()
	if err := d.auth(r.Context()); err != nil {
		_ = os.Remove(deezerArlFile)
		httpErr(w, http.StatusBadGateway, "deezer ARL invalid: "+err.Error())
		return
	}
	refreshFirstPartyServices()
	writeJSON(w, map[string]interface{}{"ok": true, "username": "Deezer"})
}

// POST /dzauth/login {email, password} — sign in to Deezer and pull the ARL
// automatically (no cookie copying). Falls back to /dzauth/save on the client if
// Deezer blocks the login with a captcha.
func handleDeezerAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json")
		return
	}
	email := strings.TrimSpace(body.Email)
	pw := strings.TrimSpace(body.Password)
	if email == "" || pw == "" {
		httpErr(w, http.StatusBadRequest, "email and password required")
		return
	}
	arl, name, err := deezerLoginGetArl(r.Context(), email, pw)
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := os.WriteFile(deezerArlFile, []byte(arl), 0600); err != nil {
		httpErr(w, http.StatusInternalServerError, "write cred: "+err.Error())
		return
	}
	// Validate the pulled ARL end-to-end before registering.
	d := newDeezerDL()
	if err := d.auth(r.Context()); err != nil {
		_ = os.Remove(deezerArlFile)
		httpErr(w, http.StatusBadGateway, "deezer ARL invalid: "+err.Error())
		return
	}
	refreshFirstPartyServices()
	if name == "" {
		name = email
	}
	writeJSON(w, map[string]interface{}{"ok": true, "username": name})
}

// --- Tidal: OAuth device-code flow (mirrors ytauth.go) -----------------------

var (
	tidalDeviceMu  sync.Mutex
	tidalDevicePnd struct {
		deviceCode string
		interval   int
	}
)

func tidalStartDeviceAuth(ctx context.Context) (map[string]interface{}, error) {
	form := url.Values{}
	form.Set("client_id", tidalClientID)
	form.Set("scope", tidalScope)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tidalDeviceURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("tidal device auth http %d: %s", resp.StatusCode, tidalTrunc(string(b), 200))
	}
	var rr struct {
		DeviceCode              string `json:"deviceCode"`
		UserCode                string `json:"userCode"`
		VerificationURI         string `json:"verificationUri"`
		VerificationURIComplete string `json:"verificationUriComplete"`
		ExpiresIn               int    `json:"expiresIn"`
		Interval                int    `json:"interval"`
	}
	if err := json.Unmarshal(b, &rr); err != nil {
		return nil, err
	}
	if rr.DeviceCode == "" {
		return nil, fmt.Errorf("tidal: no deviceCode in response")
	}
	iv := rr.Interval
	if iv <= 0 {
		iv = 2
	}
	tidalDeviceMu.Lock()
	tidalDevicePnd.deviceCode = rr.DeviceCode
	tidalDevicePnd.interval = iv
	tidalDeviceMu.Unlock()
	// verificationUriComplete already embeds the code (e.g. "link.tidal.com/ABCDE").
	full := rr.VerificationURIComplete
	if full == "" {
		full = rr.VerificationURI
	}
	return map[string]interface{}{
		"user_code":                 rr.UserCode,
		"verification_url":          rr.VerificationURI,
		"verification_url_complete": full,
		"interval":                  iv,
		"expires_in":                rr.ExpiresIn,
	}, nil
}

// tidalPollDeviceAuth polls once; returns "pending" | "ok" | "error" plus the Tidal
// username on success (so the account is labelled with the real user, not "Tidal").
func tidalPollDeviceAuth(ctx context.Context) (string, string, error) {
	tidalDeviceMu.Lock()
	dc := tidalDevicePnd.deviceCode
	tidalDeviceMu.Unlock()
	if dc == "" {
		return "error", "", fmt.Errorf("no pending auth; call /tidalauth/start first")
	}
	form := url.Values{}
	form.Set("client_id", tidalClientID)
	form.Set("client_secret", tidalClientSecret)
	form.Set("device_code", dc)
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
	form.Set("scope", tidalScope)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tidalAuthTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "pending", "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "pending", "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var rr struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
		User         struct {
			CountryCode string `json:"countryCode"`
			UserID      int64  `json:"userId"`
		} `json:"user"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(b, &rr)
	if rr.AccessToken != "" {
		tok := tidalToken{
			AccessToken:  rr.AccessToken,
			RefreshToken: rr.RefreshToken,
			TokenType:    rr.TokenType,
			CountryCode:  rr.User.CountryCode,
			UserID:       rr.User.UserID,
		}
		if rr.ExpiresIn > 0 {
			tok.Expiry = time.Now().Add(time.Duration(rr.ExpiresIn) * time.Second).Format(time.RFC3339)
		}
		if tok.CountryCode == "" {
			tok.CountryCode = "US"
		}
		bb, err := json.MarshalIndent(tok, "", "  ")
		if err != nil {
			return "error", "", err
		}
		if err := os.WriteFile(tidalTokenFile, bb, 0600); err != nil {
			return "error", "", err
		}
		tidalDeviceMu.Lock()
		tidalDevicePnd.deviceCode = ""
		tidalDeviceMu.Unlock()
		refreshFirstPartyServices()
		uname := newTidalDL().fetchUsername(ctx)
		return "ok", uname, nil
	}
	// Tidal returns HTTP 400 {"error":"authorization_pending"} while the user hasn't
	// approved yet (and "slow_down" if we poll too fast).
	if strings.Contains(rr.Error, "authorization_pending") || strings.Contains(rr.Error, "slow_down") {
		return "pending", "", nil
	}
	if rr.Error == "" {
		return "pending", "", nil // treat an unexpected empty body as still-pending
	}
	return "error", "", fmt.Errorf("%s", rr.Error)
}

func handleTidalAuthStart(w http.ResponseWriter, r *http.Request) {
	out, err := tidalStartDeviceAuth(r.Context())
	if err != nil {
		httpErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, out)
}

func handleTidalAuthPoll(w http.ResponseWriter, r *http.Request) {
	status, username, err := tidalPollDeviceAuth(r.Context())
	out := map[string]interface{}{"status": status}
	if username != "" {
		out["username"] = username
	}
	if err != nil && status != "pending" {
		out["error"] = err.Error()
	}
	writeJSON(w, out)
}

func handleTidalAuthStatus(w http.ResponseWriter, r *http.Request) {
	providersMu.RLock()
	_, ok := providers["tidal"]
	providersMu.RUnlock()
	writeJSON(w, map[string]bool{"authenticated": ok})
}
