package main

import (
	"log"
	"os"
	"os/exec"
	"sync"
	"time"
)

// librespot process manager. The backend spawns librespot as the Spotify Connect
// receiver "webOS" and keeps it alive; the backend's /player/* endpoints then
// control it via the Connect Web API. Audio is decoded by librespot and piped
// (subprocess backend) into a gstreamer pipeline that resamples 44.1->48kHz and
// plays through pulse with media.role=music (so Palm's audio policy routes it to
// the speakers). This exact recipe was validated on-device.

var (
	librespotBin  = "/media/internal/librespot"
	librespotLog  = "/media/internal/librespot.log"
	librespotDir  = "/media/internal/librespot-cache"
	librespotMu   sync.Mutex
	librespotUp   bool
)

// gstDevice: librespot subprocess sink. ffaudioresample -> native 48kHz avoids
// pulse's low-quality "palm" resampler; media.role=music -> speakers.
const gstDevice = `gst-launch-0.10 fdsrc fd=0 ! ` +
	// Streaming buffer: start playing ASAP and keep buffering WHILE playing.
	// A plain queue (no min-threshold-time, which caused audible "buffering" gaps)
	// passes the first samples straight through and then fills to ~1.5s DURING
	// playback to absorb jitter. A small 0.5s PulseAudio buffer keeps startup
	// preroll short. The real slow-wifi protection is librespot's own compressed
	// download-ahead upstream of this pipe; the PCM queue is only jitter smoothing.
	`queue max-size-buffers=0 max-size-bytes=0 max-size-time=1500000000 ! ` +
	`audio/x-raw-int,rate=44100,channels=2,width=16,depth=16,signed=true,endianness=1234 ! ` +
	`audioconvert ! ffaudioresample ! ` +
	`audio/x-raw-int,rate=48000,channels=2,width=16,depth=16,signed=true,endianness=1234 ! ` +
	`pulsesink stream-properties=s,media.role=music buffer-time=500000 latency-time=50000`

// gstBufferLatencyMs is how far AHEAD librespot's reported progress runs vs the
// audible output. With the small buffer above audio now starts almost immediately
// (before the queue fills), so the lag is only ~1-2s and GROWS during the first
// second of play rather than being a fixed pre-buffered amount. A big subtraction
// would wrongly pin the counter at 0 while audio plays, so we correct only a
// small amount — keeping the residual error ~1s in either direction.
const gstBufferLatencyMs = 1000

// startLibrespot launches the managed librespot loop once (idempotent).
func startLibrespot() {
	librespotMu.Lock()
	defer librespotMu.Unlock()
	if librespotUp {
		return
	}
	if _, err := os.Stat(librespotBin); err != nil {
		log.Printf("librespot not found at %s; playback disabled", librespotBin)
		return
	}
	librespotUp = true
	go librespotLoop()
}

func killStaleLibrespot() {
	// A backend restart orphans the previous librespot; clear it so we don't get
	// two "webOS" Connect devices.
	_ = exec.Command("sh", "-c", "for p in $(pidof librespot gst-launch-0.10); do kill -9 $p 2>/dev/null; done").Run()
	time.Sleep(500 * time.Millisecond)
}

func librespotLoop() {
	killStaleLibrespot()
	for {
		tok := freshAccessToken()
		args := []string{
			"--name", sess.librespotName,
			"--backend", "subprocess",
			"--device", gstDevice,
			"--system-cache", librespotDir,
			"--bitrate", "320",
			"--initial-volume", "100",
			"--volume-ctrl", "linear",
		}
		if tok != "" { // first login needs a token; afterwards --system-cache creds suffice
			args = append(args, "--access-token", tok)
		}
		cmd := exec.Command(librespotBin, args...)
		if lf, err := os.OpenFile(librespotLog, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644); err == nil {
			cmd.Stdout, cmd.Stderr = lf, lf
			defer lf.Close()
		}
		log.Printf("librespot: starting (token=%v)", tok != "")
		if err := cmd.Start(); err != nil {
			log.Printf("librespot: start failed: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}
		// once it registers, (re)select it as the playback device
		go func() { time.Sleep(6 * time.Second); selectLibrespotDevice() }()
		_ = cmd.Wait()
		log.Printf("librespot: exited; restarting in 5s")
		time.Sleep(5 * time.Second)
	}
}
