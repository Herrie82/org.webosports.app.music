/*globals enyo, $L, event, Utilities, window, PalmSystem, XMLHttpRequest */

/**
 * kindLibrespotManager
 * ---------------------
 * Drop-in twin of kindAudioManager (utility/audiomanager.js) for SPOTIFY tracks.
 *
 * Instead of an HTML5 <audio> element playing a local file, this drives
 * playback on the device's librespot Spotify Connect receiver through the
 * on-device Go backend (see ../../service). librespot decodes the full track
 * to ALSA/PulseAudio; the backend forwards transport commands via the Spotify
 * Connect Web API and reports position/state.
 *
 * It MUST expose the same surface kindAudioManager does, because playback.js
 * (via kindAudioRouter) calls into it identically:
 *    playAudio(strUri, intStartTime, boolForced)
 *    pauseAudio(boolPlayPause)  -> returns bool "did pause"
 *    setAudioTime(intPos)       // 0..100 percent
 *    setAudioVolume(intPos)     // 0..100
 *    getAudioCurrentTime()      // seconds
 *    getAudioDuration()         // seconds
 *    resetAudio() / killAudio()
 *  properties: boolAudioPlaying, boolAudioPaused, boolAudioLoaded
 *  events:     onPlaying, onEnded, onSrcChanged, onPausePlay, onAudioError
 *
 * STATUS: scaffold. HTTP plumbing + state machine are wired; field mapping and
 * error paths are marked TODO for on-device iteration.
 */
enyo.kind({
	name: "kindLibrespotManager",
	kind: "Component",
	published: {
		backend: "http://127.0.0.1:8730",
		boolAudioPlaying: false,
		boolAudioPaused: false,
		boolAudioLoaded: false
	},
	events: {
		onPlaying: "",
		onEnded: "",
		onSrcChanged: "",
		onPausePlay: "",
		onAudioError: ""
	},

	_currentUri: null,
	_durationSec: 0,
	_positionSec: 0,
	_pollHandle: null,

	create: function () {
		this.inherited(arguments);
	},

	// --- tiny framework-agnostic JSON helper (works on any Enyo 1.x/0.10) ---
	_call: function (method, path, body, onOk, onErr) {
		try {
			var xhr = new XMLHttpRequest();
			xhr.open(method, this.backend + path, true);
			xhr.setRequestHeader("Content-Type", "application/json");
			xhr.onreadystatechange = enyo.bind(this, function () {
				if (xhr.readyState !== 4) { return; }
				if (xhr.status >= 200 && xhr.status < 300) {
					var data = null;
					try { data = xhr.responseText ? enyo.json.parse(xhr.responseText) : {}; } catch (e) {}
					if (onOk) { onOk(data); }
				} else if (onErr) {
					onErr(xhr.status, xhr.responseText);
				}
			});
			xhr.send(body ? enyo.json.stringify(body) : null);
		} catch (e) {
			if (onErr) { onErr(-1, String(e)); }
		}
	},

	// strUri is a Spotify URI, e.g. "spotify:track:6rqhFgbbKwnb9MLmUQDhG6"
	playAudio: function (strUri, intStartTime, boolForced) {
		this._currentUri = strUri;
		this.setBoolAudioLoaded(false);
		this.doSrcChanged({ src: strUri, forced: boolForced });
		this._call("POST", "/player/load",
			{ uri: strUri, position_ms: (intStartTime || 0) * 1000 },
			enyo.bind(this, function (resp) {
				this._durationSec = resp && resp.duration_ms ? Math.floor(resp.duration_ms / 1000) : 0;
				this.setBoolAudioLoaded(true);
				this.setBoolAudioPlaying(true);
				this.setBoolAudioPaused(false);
				this._startPolling();
				this.doPlaying();
			}),
			enyo.bind(this, function (status, text) {
				this.doAudioError({ source: "librespot", status: status, message: text });
			})
		);
		return true;
	},

	// returns true when it actually paused (mirrors kindAudioManager contract)
	pauseAudio: function (boolPlayPause) {
		if (this.boolAudioPlaying && !this.boolAudioPaused) {
			this._call("POST", "/player/pause", null, enyo.bind(this, function () {
				this.setBoolAudioPaused(true);
				this.setBoolAudioPlaying(false);
				this.doPausePlay({ paused: true });
			}));
			return true;
		}
		// resume
		this._call("POST", "/player/play", null, enyo.bind(this, function () {
			this.setBoolAudioPaused(false);
			this.setBoolAudioPlaying(true);
			this.doPausePlay({ paused: false });
		}));
		return false;
	},

	setAudioTime: function (intPos) { // 0..100 percent
		var ms = Math.floor(this._durationSec * (intPos / 100) * 1000);
		this._call("POST", "/player/seek", { position_ms: ms });
	},

	setAudioVolume: function (intPos) { // 0..100
		this._call("POST", "/player/volume", { volume: intPos });
	},

	getAudioCurrentTime: function () { return this._positionSec; },
	getAudioDuration: function () { return this._durationSec; },

	resetAudio: function () { this._stopPolling(); this._positionSec = 0; },
	killAudio: function () {
		this._stopPolling();
		// SYNCHRONOUS pause: killAudio runs from the app's unload handler, and an
		// async XHR wouldn't complete before the WebKit context is torn down — so
		// librespot (which plays on the backend, independent of the app) would keep
		// playing after the app is closed. A sync request blocks until it lands.
		try {
			var x = new XMLHttpRequest();
			x.open("POST", this.backend + "/player/pause", false); // false = synchronous
			x.setRequestHeader("Content-Type", "application/json");
			x.send(null);
		} catch (e) {}
		this.setBoolAudioPlaying(false);
	},

	// --- poll backend for position / end-of-track ---
	_startPolling: function () {
		this._stopPolling();
		this._pollHandle = window.setInterval(enyo.bind(this, this._poll), 1000);
	},
	_stopPolling: function () {
		if (this._pollHandle) { window.clearInterval(this._pollHandle); this._pollHandle = null; }
	},
	_poll: function () {
		this._call("GET", "/player/status", null, enyo.bind(this, function (s) {
			if (!s) { return; }
			this._positionSec = s.position_ms ? Math.floor(s.position_ms / 1000) : this._positionSec;
			if (s.duration_ms) { this._durationSec = Math.floor(s.duration_ms / 1000); }
			if (s.state === "ended" || (s.is_playing === false && s.position_ms === 0 && this.boolAudioPlaying)) {
				this._stopPolling();
				this.setBoolAudioPlaying(false);
				this.doEnded();
			}
		}));
	}
});
