package main

import "net/http"

// Transport for the shared stream player (YouTube and any future stream-URL
// connector). Playback is started via /provider/<id>/play; these control it.
//   POST /stream/pause  | /stream/resume | /stream/stop
//   GET  /stream/status -> {is_playing, position_ms}

func handleStreamPause(w http.ResponseWriter, r *http.Request) {
	streamPause()
	writeJSON(w, map[string]bool{"ok": true})
}

func handleStreamResume(w http.ResponseWriter, r *http.Request) {
	streamResume()
	writeJSON(w, map[string]bool{"ok": true})
}

func handleStreamStop(w http.ResponseWriter, r *http.Request) {
	stopStream()
	writeJSON(w, map[string]bool{"ok": true})
}

func handleStreamStatus(w http.ResponseWriter, r *http.Request) {
	playing, pos, ended := streamStatus()
	writeJSON(w, map[string]interface{}{"is_playing": playing, "position_ms": pos, "ended": ended})
}
