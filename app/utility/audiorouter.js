/*globals enyo, $L, event, Utilities, window, PalmSystem */

/**
 * kindAudioRouter
 * ---------------
 * Facade that lets the app play BOTH local files and Spotify tracks through the
 * exact same interface playback.js already expects from kindAudioManager.
 *
 * playback.js is changed in ONE place:
 *    {name: "AudioManager", kind: "kindAudioManager", ...}
 * becomes
 *    {name: "AudioManager", kind: "kindAudioRouter",  ...}
 *
 * The router owns both real backends and dispatches every call to the one that
 * matches the current track:
 *    - path/URI starting with "spotify:"  -> kindLibrespotManager (remote)
 *    - anything else (a local file path)  -> kindAudioManager      (local)
 *
 * Events from whichever backend is active are re-emitted upward unchanged, so
 * playback.js / the dashboard / now-playing UI never know there are two engines.
 */
enyo.kind({
	name: "kindAudioRouter",
	kind: "Component",
	// mirrored from the active backend so playback.js can read them directly
	boolAudioPlaying: false,
	boolAudioPaused: false,
	boolAudioLoaded: false,
	events: {
		onPlaying: "",
		onEnded: "",
		onSrcChanged: "",
		onPausePlay: "",
		onAudioError: ""
	},
	components: [
		{ name: "local", kind: "kindAudioManager",
		  onPlaying: "_relayPlaying", onEnded: "_relayEnded", onSrcChanged: "_relaySrcChanged",
		  onPausePlay: "_relayPausePlay", onAudioError: "_relayError" },
		{ name: "spotify", kind: "kindLibrespotManager",
		  onPlaying: "_relayPlaying", onEnded: "_relayEnded", onSrcChanged: "_relaySrcChanged",
		  onPausePlay: "_relayPausePlay", onAudioError: "_relayError" },
		{ name: "stream", kind: "kindStreamManager",
		  onPlaying: "_relayPlaying", onEnded: "_relayEnded", onSrcChanged: "_relaySrcChanged",
		  onPausePlay: "_relayPausePlay", onAudioError: "_relayError" }
	],

	// stream-URL connectors routed to kindStreamManager (Spotify -> librespot; a local
	// file path -> kindAudioManager).
	_streamRe: /^(youtube|soundcloud|deezer|jamendo|archive|qobuz|tidal):/,

	_active: null, // reference to whichever backend is currently in charge

	_pick: function (strPathOrUri) {
		if (typeof strPathOrUri === "string") {
			if (strPathOrUri.indexOf("spotify:") === 0) { return this.$.spotify; }
			if (this._streamRe.test(strPathOrUri)) { return this.$.stream; }
		}
		return this.$.local;
	},

	// --- kindAudioManager-compatible surface -> dispatched ---
	playAudio: function (strPathOrUri, intStartTime, boolForced) {
		var next = this._pick(strPathOrUri);
		// switching engines: definitively silence the outgoing one WITHOUT ever
		// resuming it. Both managers' pauseAudio are quirky: kindAudioManager
		// INVERTS the flag (false = pause, true = play) while kindLibrespotManager
		// IGNORES the flag and TOGGLES — so a blind call could RESUME the outgoing
		// engine and steal the audio device (that stopped local from starting).
		// Only act when it's actually playing, and use each one's pause form.
		if (this._active && this._active !== next && this._active.boolAudioPlaying) {
			if (this._active === this.$.spotify || this._active === this.$.stream) {
				this._active.pauseAudio();      // librespot/stream toggle; playing -> pause
			} else {
				this._active.pauseAudio(false); // local: false = pause
			}
		}
		this._active = next;
		return next.playAudio(strPathOrUri, intStartTime, boolForced);
	},
	pauseAudio:       function (b) { return this._active ? this._active.pauseAudio(b) : false; },
	setAudioTime:     function (p) { if (this._active) { this._active.setAudioTime(p); } },
	setAudioVolume:   function (p) { if (this._active) { this._active.setAudioVolume(p); } },
	getAudioCurrentTime: function () { return this._active ? this._active.getAudioCurrentTime() : 0; },
	getAudioDuration:    function () { return this._active ? this._active.getAudioDuration() : 0; },
	resetAudio:       function () { if (this._active) { this._active.resetAudio(); } this._sync(); },
	killAudio:        function () { this.$.local.killAudio(); this.$.spotify.killAudio(); this.$.stream.killAudio(); this._sync(); },

	// copy the active backend's state flags up so playback.js sees them
	_sync: function () {
		var a = this._active;
		this.boolAudioPlaying = a ? a.boolAudioPlaying : false;
		this.boolAudioPaused  = a ? a.boolAudioPaused  : false;
		this.boolAudioLoaded  = a ? a.boolAudioLoaded  : false;
	},

	// --- event relays (sync flags, then bubble up) ---
	_relayPlaying:  function () { this._sync(); this.doPlaying(); },
	_relayEnded:    function () { this._sync(); this.doEnded(); },
	_relaySrcChanged: function (s, a) { this._sync(); this.doSrcChanged(a); },
	_relayPausePlay: function (s, a) { this._sync(); this.doPausePlay(a); },
	_relayError:    function (s, a) { this._sync(); this.doAudioError(a); }
});
