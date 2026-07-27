package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// MusicProvider is the connector contract (see docs/MUSIC-CONNECTORS.md). Each
// music service implements it. Spotify is the special case (playback via
// librespot/Connect, no stream URL); "stream-URL" providers (SoundCloud,
// YouTube, Deezer, …) return a direct URL that the shared gst player plays.
type MusicProvider interface {
	ID() string           // short id, e.g. "spotify", "youtube", "soundcloud"
	Name() string         // display name
	Search(ctx context.Context, query string, limit int) ([]providerTrack, error)
	// StreamURL resolves a playable http(s) audio URL for a track id, or "" if
	// this provider plays via its own mechanism (Spotify → Connect/librespot).
	StreamURL(ctx context.Context, trackID string) (string, error)
}

// providerTrack is the normalised track shape returned to the app.
type providerTrack struct {
	ID         string `json:"id"`
	Provider   string `json:"provider"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	Thumbnail  string `json:"thumbnail"`
	DurationMs int    `json:"duration_ms"`
	// Path the app should hand to playback. For Spotify: spotify:track:<id>.
	// For stream-URL providers: provider:<id>:<trackid> (the app calls
	// /provider/<id>/play to actually start it).
	Path string `json:"path"`
}

var providers = map[string]MusicProvider{}

func registerProvider(p MusicProvider) { providers[p.ID()] = p }

// GET /providers -> [{id,name,available}]
func handleProviders(w http.ResponseWriter, r *http.Request) {
	type row struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := []row{}
	for _, p := range providers {
		out = append(out, row{ID: p.ID(), Name: p.Name()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	writeJSON(w, map[string]interface{}{"providers": out})
}

// GET /provider/<id>/search?q=&limit=
// POST /provider/<id>/play  {trackId}
func handleProviderRoute(w http.ResponseWriter, r *http.Request) {
	// path: /provider/<id>/<action>
	rest := strings.TrimPrefix(r.URL.Path, "/provider/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) < 2 {
		httpErr(w, http.StatusBadRequest, "usage: /provider/<id>/<search|play>")
		return
	}
	id, action := parts[0], parts[1]
	p := providers[id]
	if p == nil {
		httpErr(w, http.StatusNotFound, "unknown provider: "+id)
		return
	}
	switch action {
	case "search":
		q := r.URL.Query().Get("q")
		limit := 50
		if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 {
			limit = l
		}
		tracks, err := p.Search(r.Context(), q, limit)
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, map[string]interface{}{"tracks": tracks})
	case "play":
		var body struct {
			TrackID string `json:"trackId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		url, err := p.StreamURL(r.Context(), body.TrackID)
		if err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		if url == "" {
			httpErr(w, http.StatusConflict, id+" has no stream URL (plays via its own engine)")
			return
		}
		if err := playStreamURL(url); err != nil {
			httpErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		httpErr(w, http.StatusBadRequest, "unknown action: "+action)
	}
}
