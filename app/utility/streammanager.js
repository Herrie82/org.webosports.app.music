/*globals enyo, $L, window, XMLHttpRequest */

/**
 * kindStreamManager
 * -----------------
 * Drop-in twin of kindAudioManager / kindLibrespotManager for STREAM-URL connectors
 * (YouTube, SoundCloud, Deezer, Jamendo, Internet Archive, Qobuz, Tidal).
 *
 * Paths look like "<provider>:<id>" (e.g. "soundcloud:12345"). To play, it asks the
 * Go backend to resolve + start the stream:
 *    POST /provider/<provider>/play {trackId}
 * and then drives transport via the shared stream player:
 *    POST /stream/pause | /stream/resume | /stream/stop
 *    GET  /stream/status -> {is_playing, position_ms, ended}
 *
 * It exposes the same surface kindAudioManager does so kindAudioRouter can dispatch
 * to it identically.
 */
enyo.kind({
	name: "kindStreamManager",
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

	_currentPath: null,
	_durationSec: 0,
	_positionSec: 0,
	_pollHandle: null,

	create: function () { this.inherited(arguments); },

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
				} else if (onErr) { onErr(xhr.status, xhr.responseText); }
			});
			xhr.send(body ? enyo.json.stringify(body) : null);
		} catch (e) { if (onErr) { onErr(-1, String(e)); } }
	},

	// strPath is "<provider>:<id>"
	playAudio: function (strPath, intStartTime, boolForced) {
		this._currentPath = strPath;
		this._positionSec = 0;
		this.setBoolAudioLoaded(false);
		this.doSrcChanged({ src: strPath, forced: boolForced });
		var colon = (strPath || "").indexOf(":");
		if (colon < 1) {
			this.doAudioError({ source: "stream", message: "bad path: " + strPath });
			return true;
		}
		var provider = strPath.substring(0, colon);
		var id = strPath.substring(colon + 1);
		this._call("POST", "/provider/" + provider + "/play", { trackId: id },
			enyo.bind(this, function () {
				this.setBoolAudioLoaded(true);
				this.setBoolAudioPlaying(true);
				this.setBoolAudioPaused(false);
				this._startPolling();
				this.doPausePlay(this.boolAudioPlaying); // flip transport UI to the pause glyph
				this.doPlaying();
			}),
			enyo.bind(this, function (status, text) {
				this.setBoolAudioPlaying(false);
				this.doAudioError({ source: provider, status: status, message: text });
			})
		);
		return true;
	},

	// returns true when it actually paused (mirrors kindAudioManager contract)
	pauseAudio: function (boolPlayPause) {
		if (this.boolAudioPlaying && !this.boolAudioPaused) {
			this._call("POST", "/stream/pause", null, enyo.bind(this, function () {
				this.setBoolAudioPaused(true);
				this.setBoolAudioPlaying(false);
				this.doPausePlay(this.boolAudioPlaying);
			}));
			return true;
		}
		this._call("POST", "/stream/resume", null, enyo.bind(this, function () {
			this.setBoolAudioPaused(false);
			this.setBoolAudioPlaying(true);
			this.doPausePlay(this.boolAudioPlaying);
		}));
		return false;
	},

	setAudioTime: function (intPos) { /* stream seek not supported yet */ },
	setAudioVolume: function (intPos) { /* system volume handles this */ },

	getAudioCurrentTime: function () { return this._positionSec; },
	getAudioDuration: function () { return this._durationSec; },

	resetAudio: function () { this._stopPolling(); this._positionSec = 0; },
	killAudio: function () {
		this._stopPolling();
		try {
			var x = new XMLHttpRequest();
			x.open("POST", this.backend + "/stream/stop", false); // sync: runs from unload
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
		this._call("GET", "/stream/status", null, enyo.bind(this, function (s) {
			if (!s) { return; }
			if (s.position_ms) { this._positionSec = Math.floor(s.position_ms / 1000); }
			if (s.ended) {
				this._stopPolling();
				this.setBoolAudioPlaying(false);
				this.doEnded();
			}
		}));
	}
});
