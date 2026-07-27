package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// youtubeProvider: a free, no-DRM source. YouTube has no clean public API, so we
// use yt-dlp (search + best-audio stream URL) and play the URL via the shared gst
// player. Requires yt-dlp on the device (deploy separately). This establishes the
// stream-URL connector pattern; SoundCloud/Deezer would be similar HTTP resolvers.
type youtubeProvider struct{}

func (y *youtubeProvider) ID() string   { return "youtube" }
func (y *youtubeProvider) Name() string { return "YouTube Music" }

func (y *youtubeProvider) Search(ctx context.Context, query string, limit int) ([]providerTrack, error) {
	if query == "" {
		return []providerTrack{}, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	out, err := exec.CommandContext(ctx, "yt-dlp",
		fmt.Sprintf("ytsearch%d:%s", limit, query),
		"--flat-playlist", "--dump-json", "--no-warnings").Output()
	if err != nil {
		return nil, fmt.Errorf("yt-dlp search failed (is yt-dlp on the device?): %v", err)
	}
	var tracks []providerTrack
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var e struct {
			ID        string  `json:"id"`
			Title     string  `json:"title"`
			Uploader  string  `json:"uploader"`
			Channel   string  `json:"channel"`
			Duration  float64 `json:"duration"`
			Thumbnail string  `json:"thumbnail"`
		}
		if json.Unmarshal([]byte(line), &e) != nil {
			continue
		}
		artist := e.Uploader
		if artist == "" {
			artist = e.Channel
		}
		tracks = append(tracks, providerTrack{
			ID: e.ID, Provider: "youtube", Title: e.Title, Artist: artist,
			Thumbnail: e.Thumbnail, DurationMs: int(e.Duration * 1000), Path: "youtube:" + e.ID,
		})
	}
	return tracks, nil
}

func (y *youtubeProvider) StreamURL(ctx context.Context, trackID string) (string, error) {
	if trackID == "" {
		return "", fmt.Errorf("no track id")
	}
	out, err := exec.CommandContext(ctx, "yt-dlp", "-f", "bestaudio", "-g",
		"https://www.youtube.com/watch?v="+trackID, "--no-warnings").Output()
	if err != nil {
		return "", fmt.Errorf("yt-dlp resolve failed: %v", err)
	}
	return strings.TrimSpace(string(out)), nil
}
