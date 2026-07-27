package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// tidalProvider streams lossless from the user's Tidal account, reusing tidalDL auth
// + playbackinfo (FileURL). Tidal's LOSSLESS URLs are plain, so they go straight to
// the stream player. Registered only when a tidal-token cred file is present.
type tidalProvider struct{ dl *tidalDL }

func (p *tidalProvider) ID() string   { return "tidal" }
func (p *tidalProvider) Name() string { return "Tidal" }

func (p *tidalProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 40 {
		limit = 25
	}
	cc := p.dl.countryCode()
	u := fmt.Sprintf("%s/search/tracks?query=%s&limit=%d&offset=0&countryCode=%s",
		tidalAPIBase, url.QueryEscape(query), limit, url.QueryEscape(cc))
	body, err := p.dl.authGet(ctx, u)
	if err != nil {
		return nil, err
	}
	var r struct {
		Items []struct {
			ID       json.Number `json:"id"`
			Title    string      `json:"title"`
			Duration int         `json:"duration"` // seconds
			Artist   struct {
				Name string `json:"name"`
			} `json:"artist"`
			Album struct {
				Title string `json:"title"`
				Cover string `json:"cover"`
			} `json:"album"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("tidal search parse: %w", err)
	}
	out := []providerTrack{}
	for _, it := range r.Items {
		id := it.ID.String()
		thumb := ""
		if it.Album.Cover != "" { // cover is a UUID with dashes -> path with slashes
			thumb = "https://resources.tidal.com/images/" + strings.ReplaceAll(it.Album.Cover, "-", "/") + "/320x320.jpg"
		}
		out = append(out, providerTrack{
			ID: id, Provider: "tidal", Title: it.Title, Artist: it.Artist.Name,
			Album: it.Album.Title, Thumbnail: thumb,
			DurationMs: it.Duration * 1000, Path: "tidal:" + id,
		})
	}
	return out, nil
}

func (p *tidalProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	f, err := p.dl.FileURL(ctx, trackID)
	if err != nil {
		return "", err
	}
	return f.URL, nil
}
