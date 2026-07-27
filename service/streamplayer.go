package main

import (
	"log"
	"os/exec"
	"sync"
)

// playStreamURL plays a direct http(s) audio URL through the device speakers,
// reusing the proven audio path: curl streams the URL into gstreamer, which
// decodes it, resamples to the DAC's native 48kHz, and outputs via pulse with
// media.role=music (Palm policy routes that to the hardware sink). This is the
// shared playback path for every "stream-URL" connector (SoundCloud, YouTube,
// Deezer, …) — Spotify is the exception (librespot/Connect).
//
// souphttpsrc isn't in the device's gst plugin set, so we pipe via curl|fdsrc
// (decodebin + the ffmpeg decoders handle mp3/aac/ogg).

var (
	streamMu  sync.Mutex
	streamCmd *exec.Cmd
)

func playStreamURL(url string) error {
	streamMu.Lock()
	defer streamMu.Unlock()

	// stop any current stream + librespot so we own the audio sink
	if streamCmd != nil && streamCmd.Process != nil {
		_ = streamCmd.Process.Kill()
		_ = streamCmd.Wait()
	}

	pipeline := "curl -sL '" + escapeSingle(url) + "' | " +
		"gst-launch-0.10 fdsrc fd=0 ! decodebin ! audioconvert ! ffaudioresample ! " +
		"audio/x-raw-int,rate=48000,channels=2,width=16,depth=16,signed=true,endianness=1234 ! " +
		"pulsesink stream-properties=s,media.role=music"

	cmd := exec.Command("sh", "-c", pipeline)
	if err := cmd.Start(); err != nil {
		return err
	}
	streamCmd = cmd
	log.Printf("stream: playing %.60s", url)
	go func() { _ = cmd.Wait() }()
	return nil
}

func stopStream() {
	streamMu.Lock()
	defer streamMu.Unlock()
	if streamCmd != nil && streamCmd.Process != nil {
		_ = streamCmd.Process.Kill()
	}
}

// escapeSingle makes a URL safe inside a single-quoted shell string.
func escapeSingle(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\'' {
			out = append(out, '\'', '\\', '\'', '\'')
			continue
		}
		out = append(out, r)
	}
	return string(out)
}
