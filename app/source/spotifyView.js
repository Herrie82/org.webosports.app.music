/*globals enyo, $L, window, XMLHttpRequest, PalmSystem */

/**
 * kindSpotifyView — the "Spotify" library view.
 *
 * Talks only to the on-device Go backend (127.0.0.1:8730) over XHR; to play a
 * track it fires onSetPlaybackList (same as the local list views) so audio goes
 * through kindPlayback -> kindAudioRouter -> kindLibrespotManager.
 *
 * Login uses an EMBEDDED Atlas WebView (the modern WPE engine, TLS 1.3) rather
 * than launching a separate browser — the stock/old webkit can't do Spotify's
 * OAuth, and Atlas deregistered itself as the default URL handler. This mirrors
 * Herrie's com.palm.app.cloud-auth pattern:
 *   - patch enyo.BasicWebView's plugin mime to application/x-atlas-browser,
 *   - openURL("atlas-simple:" + authUrl),
 *   - watch onUrlRedirected/onPageTitleChanged for the redirect back to our
 *     backend's /auth/callback (which does the PKCE exchange server-side),
 *   - tear the WebView down OUT of the nav-event callback (setTimeout 0) or
 *     destroying the live plugin re-enters it and restarts LunaSysMgr.
 */

// Route enyo.BasicWebView to the Atlas/WPE engine (once, at load).
(function () {
	function patch() {
		if (!(window.enyo && enyo.BasicWebView && enyo.BasicWebView.prototype)) { return false; }
		if (enyo.BasicWebView.prototype.__atlasPatched) { return true; }
		enyo.BasicWebView.prototype.__atlasPatched = true;
		var origCreate = enyo.BasicWebView.prototype.create;
		enyo.BasicWebView.prototype.create = function () {
			origCreate.apply(this, arguments);
			this.domAttributes.type = "application/x-atlas-browser";
		};
		return true;
	}
	if (!patch() && window.enyo) {
		var t = window.setInterval(function () { if (patch()) { window.clearInterval(t); } }, 50);
	}
})();

enyo.kind({
	name: "kindSpotifyView",
	kind: "VFlexBox",
	className: "spotify-view",
	published: { backend: "http://127.0.0.1:8730" },
	events: { onSetPlaybackList: "" },

	tracks: [],
	_poll: null,
	_oauthDone: false,

	components: [
		// Header styled exactly like the stock Songs header (ctrlListViewHeader):
		// list-header toolbar with a left-aligned .title. authLabel stays empty
		// unless action is needed (no "Checking…").
		{ kind: "Toolbar", className: "enyo-toolbar enyo-toolbar-light list-header", pack: "justify", layoutKind: "HFlexLayout", components: [
			{ kind: "Control", className: "list-header-title-layout", layoutKind: "HLayout", components: [
				{ content: $L("Spotify"), className: "title enyo-text-ellipsis", flex: 1 }
			]},
			{ name: "authLabel", content: "", className: "spotify-authlabel" }
		]},
		{ name: "loginRow", className: "spotify-loginrow", showing: false, layoutKind: "HFlexLayout", align: "center", components: [
			{ name: "btnLogin", kind: "Button", className: "enyo-button-affirmative", content: $L("Log in with Spotify"), onclick: "login" },
			{ content: $L("  Requires a running backend + Spotify Premium"), className: "spotify-hint" }
		]},
		// embedded Atlas WebView for the OAuth sign-in (created lazily in login())
		{ name: "oauthBox", kind: "VFlexBox", flex: 1, showing: false, components: [
			{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
				{ content: $L("Sign in to Spotify"), flex: 1 },
				{ kind: "Button", content: $L("Cancel"), onclick: "cancelLogin" }
			]}
		]},
		// Search field with the original webOS magnifier overlaid inside on the right
		// (Messaging-style). The icon is absolutely positioned over the input.
		{ name: "searchRow", className: "spotify-searchrow", showing: false, layoutKind: "HFlexLayout", align: "center", style: "padding:10px 12px 46px 12px; border-bottom:1px solid #c3c3c3; position:relative;", components: [
			{ name: "search", kind: "Input", flex: 1, hint: $L("Search Spotify…"), onkeyup: "searchKey", style: "height:40px; font-size:16px; padding-right:40px;" },
			{ name: "btnSearch", kind: "Image", src: "images/empty-search.png", onclick: "doSearch", style: "position:absolute; right:22px; top:16px; width:28px; height:28px;" }
		]},
		{ name: "status", className: "spotify-status", content: "" },
		{ name: "scroller", kind: "Scroller", flex: 1, components: [
			{ name: "resultList", className: "spotify-results" }
		]}
	],

	create: function () { this.inherited(arguments); this.checkAuth(); },
	// Panes may instantiate views lazily; re-check when actually shown.
	rendered: function () { this.inherited(arguments); if (!this._oauthDone) { this.checkAuth(); } },

	// --- tiny JSON XHR helper (framework-version-safe) ---
	_get: function (path, onOk, onErr) {
		try {
			var xhr = new XMLHttpRequest();
			xhr.open("GET", this.backend + path, true);
			xhr.onreadystatechange = enyo.bind(this, function () {
				if (xhr.readyState !== 4) { return; }
				var data = null;
				try { data = xhr.responseText ? enyo.json.parse(xhr.responseText) : {}; } catch (e) {}
				if (xhr.status >= 200 && xhr.status < 300) { if (onOk) { onOk(data); } }
				else if (onErr) { onErr(xhr.status, data); }
			});
			xhr.send(null);
		} catch (e) { if (onErr) { onErr(-1, null); } }
	},

	// --- auth state ---
	checkAuth: function () {
		this._get("/auth/status",
			enyo.bind(this, function (d) { this.setAuthed(!!(d && d.authenticated)); }),
			enyo.bind(this, function () {
				this.$.authLabel.setContent($L("Backend offline"));
				this.$.loginRow.setShowing(true);
				this.$.searchRow.setShowing(false);
			})
		);
	},

	setAuthed: function (ok) {
		// Empty when signed in (no clutter); only speak up when action is needed.
		this.$.authLabel.setContent(ok ? "" : $L("Not connected"));
		this.$.loginRow.setShowing(!ok && !this.$.oauthBox.showing);
		this.$.searchRow.setShowing(ok);
		if (ok) { this.stopPolling(); this.teardownWeb(); }
	},

	// --- login via embedded Atlas WebView ---
	login: function () {
		this._oauthDone = false;
		this.$.authLabel.setContent($L("Opening…"));
		this.$.status.setContent($L("Contacting backend…"));
		this._get("/auth/login",
			enyo.bind(this, function (d) {
				if (d && d.authUrl) { this.startEmbeddedAuth(d.authUrl); }  // in-app atlas-simple WebView
				else { this.needClientId(); }
			}),
			enyo.bind(this, function (s) {
				if (s === 412) { this.needClientId(); }
				else { this.$.authLabel.setContent($L("Backend offline")); this.$.status.setContent($L("⚠ Backend not reachable at ") + this.backend); }
			})
		);
	},

	// Launch the FULL Atlas browser (persistent cookies/storage) for the Spotify
	// login, then poll /auth/status. When Spotify redirects Atlas to our
	// /auth/callback, the backend does the PKCE exchange; the user returns here
	// and the poll flips the UI to Connected.
	openInAtlas: function (authUrl) {
		this._oauthDone = false;
		this.$.authLabel.setContent($L("Signing in…"));
		this.$.status.setContent($L("Sign in to Spotify in the Atlas browser that just opened, approve access, then switch back here — this screen will update automatically."));
		this.$.svcOpen.call({ id: "org.webosports.app.atlas", params: { target: authUrl } });
		this.startPolling();
	},

	needClientId: function () {
		this.$.authLabel.setContent($L("No Client ID"));
		this.$.status.setContent($L("⚠ No Spotify Client ID on the backend. Put it in /media/internal/spotify-client-id (and register redirect http://127.0.0.1:8730/auth/callback), then restart the service."));
	},

	startEmbeddedAuth: function (authUrl) {
		this._authUrl = authUrl;
		this.redirectPrefix = this.backend + "/auth/callback";
		this.$.loginRow.setShowing(false);
		this.$.searchRow.setShowing(false);
		this.$.oauthBox.setShowing(true);
		this.$.status.setContent($L("Loading Spotify sign-in…"));
		if (!this.$.oauthWeb) {
			this.$.oauthBox.createComponent({
				name: "oauthWeb", kind: "WebView", width: "100%", height: "600px",
				url: "atlas-simple:about:blank",
				onConnected: "oauthConnected", onError: "oauthWebError",
				onUrlRedirected: "oauthNav", onPageTitleChanged: "oauthTitleNav",
				onLoadStarted: "oauthLoadStarted", onLoadComplete: "oauthLoadDone", onLoadStopped: "oauthLoadDone"
			}, { owner: this });
			this.$.oauthBox.render();
		} else {
			this.oauthConnected();
		}
		// onConnected is unreliable (enyo 0.10) — fall back to firing openURL after 3s.
		this.clearLoadTimer();
		var self = this;
		this._loadTimer = window.setTimeout(function () { self.log("oauth fallback -> openURL"); self.oauthConnected(); }, 3000);
		this.startPolling(); // backend exchange happens on redirect; poll confirms
	},

	clearLoadTimer: function () { if (this._loadTimer) { window.clearTimeout(this._loadTimer); this._loadTimer = null; } },

	oauthConnected: function () {
		if (this._oauthLoaded || !this._authUrl || !this.$.oauthWeb) { return; }
		this._oauthLoaded = true;
		this.clearLoadTimer();
		this.log("oauthConnected -> openURL atlas-simple:" + this._authUrl.substring(0, 50));
		try { this.$.oauthWeb.callBrowserAdapter("openURL", ["atlas-simple:" + this._authUrl]); }
		catch (e) { this.log("openURL failed: " + e); this._oauthLoaded = false; this.oauthWebError(); }
	},

	oauthLoadStarted: function () { if (!this._oauthDone) { this.$.status.setContent(""); } },
	oauthLoadDone: function () { /* page painted */ },
	oauthNav: function (inSender, inUrl) { this.checkRedirect(inUrl); },
	oauthTitleNav: function (inSender, inTitle, inUrl) { this.checkRedirect(inUrl); },
	oauthWebError: function () { this.$.authLabel.setContent($L("Browser engine error")); this.$.status.setContent($L("⚠ Atlas WebView engine error")); },

	// When the WebView reaches our /auth/callback, the backend has (or is about to)
	// exchange the code server-side. Defer teardown OUT of this nav callback.
	checkRedirect: function (url) {
		if (this._oauthDone || !url || url.indexOf(this.redirectPrefix) !== 0) { return; }
		this._oauthDone = true;
		var self = this;
		window.setTimeout(function () {
			self.teardownWeb();
			self.$.authLabel.setContent($L("Finishing sign-in…"));
			self.checkAuth();
		}, 500);
	},

	cancelLogin: function () { this._oauthDone = true; this.teardownWeb(); this.checkAuth(); },

	teardownWeb: function () {
		this.$.oauthBox.setShowing(false);
		if (this.$.oauthWeb) { this.$.oauthWeb.destroy(); this._oauthLoaded = false; }
	},

	startPolling: function () {
		if (this._poll) { return; }
		this._poll = window.setInterval(enyo.bind(this, this.checkAuth), 2000);
	},
	stopPolling: function () { if (this._poll) { window.clearInterval(this._poll); this._poll = null; } },

	// --- search ---
	searchKey: function (sender, ev) { if (ev && ev.keyCode === 13) { this.doSearch(); } },
	doSearch: function () {
		var q = this.$.search.getValue();
		if (!q) { return; }
		this.$.status.setContent($L("Searching…"));
		this._get("/search?type=track&limit=50&q=" + encodeURIComponent(q),
			enyo.bind(this, function (d) { this.renderResults((d && d.tracks) || []); }),
			enyo.bind(this, function (s) { this.$.status.setContent($L("Search failed (") + s + ")"); })
		);
	},

	// duration_ms -> "M:SS"
	_fmtDur: function (ms) {
		if (!ms || ms < 0) { return ""; }
		var s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60;
		return m + ":" + (r < 10 ? "0" + r : r);
	},

	renderResults: function (tracks) {
		this.tracks = tracks;
		this.$.status.setContent(tracks.length ? "" : $L("No results"));
		// Clear previous rows. They're created with {owner:this} (so onclick resolves
		// to this view), so they live in the view's $ hash, not resultList's —
		// resultList.destroyComponents() wouldn't clear them (2nd search would stack).
		// This Enyo 0.10 has no destroyClientControls(), so destroy resultList's child
		// controls directly (reverse — destroy() splices the child from .children).
		var kids = this.$.resultList.children;
		for (var k = kids.length - 1; k >= 0; k--) {
			if (kids[k] && kids[k].destroy) { kids[k].destroy(); }
		}
		enyo.forEach(tracks, function (t, i) {
			this.$.resultList.createComponent({
				kind: "Item", index: i, layoutKind: "HFlexLayout", align: "center",
				style: "background:#e5e5e5; border-bottom:1px solid #c3c3c3; padding:0 12px; height:54px; -webkit-box-sizing:border-box;", className: "spotify-row", tapHighlight: true, tapHighlightClassName: "active", onclick: "tapTrack", components: [
					{ kind: "Image", src: t.thumbnail || "", className: "spotify-art", style: "width:40px; height:40px; margin:0 12px 0 10px;" },
					{ kind: "Control", flex: 1, className: "spotify-meta", components: [
						{ content: t.title || "", className: "spotify-row-title" },
						{ content: ((t.artist || "") + " — " + (t.album || "")), className: "spotify-row-sub" }
					]},
					{ name: "pp" + i, kind: "Image", showing: false, onclick: "onPlayPauseTap", style: "width:18px; height:18px; margin-left:12px;" },
						{ content: this._fmtDur(t.duration_ms), className: "spotify-row-time", style: "text-align:right; padding-left:12px;" }
				]
			}, { owner: this });
		}, this);
		this.$.resultList.render();
		this._updatePlayIcons();
		this._startStatusPoll();
	},

	// --- play: build a playback list from the results, start at the tapped one ---
	tapTrack: function (sender) {
		var start = sender.index || 0;
		var list = enyo.map(this.tracks, function (t) {
			return {
				path: t.path, _id: t.spotifyId || t.path,
				title: t.title || "", artist: t.artist || "", album: t.album || "",
				duration: t.duration_ms ? Math.floor(t.duration_ms / 1000) : 0,
				thumbnails: t.thumbnail ? [{ data: t.thumbnail }] : []
			};
		});
		this._playingUri = this.tracks[start] ? this.tracks[start].path : "";
		this._expectedUri = this._playingUri; this._expectedTries = 0; // backend still reports old track briefly
		this._isPlaying = true;
		this._updatePlayIcons();
		this._startStatusPoll();
		this.doSetPlaybackList({
			arSetPlaybackList: list, intStartTrackIndex: start, intStartTrackTime: 0,
			strOriginListID: "spotify-search", strListQuery: JSON.stringify({ spotify: true })
		});
	},

	// --- in-row now-playing indicator + play/pause toggle (left of the duration) ---
	_post: function (path) {
		try { var x = new XMLHttpRequest(); x.open("POST", this.backend + path, true); x.send(null); } catch (e) {}
	},
	_startStatusPoll: function () {
		if (this._statusPoll) { return; }
		this._statusPoll = window.setInterval(enyo.bind(this, this._pollStatus), 1500);
	},
	_stopStatusPoll: function () { if (this._statusPoll) { window.clearInterval(this._statusPoll); this._statusPoll = null; } },
	_pollStatus: function () {
		this._get("/player/status", enyo.bind(this, function (d) {
			if (!d) { return; }
			var uri = d.uri || "", playing = !!d.is_playing;
			// After a tap we optimistically light up the NEW row, but the backend
			// keeps reporting the PREVIOUS track for ~1s until /player/load lands.
			// Suppress the stale uri until it catches up (bounded to a few polls so
			// it can't get stuck) so the indicator doesn't jump back to the old song.
			if (this._expectedUri && uri !== this._expectedUri) {
				if ((this._expectedTries = (this._expectedTries || 0) + 1) <= 4) {
					if (playing !== this._isPlaying) { this._isPlaying = playing; this._updatePlayIcons(); }
					return;
				}
			}
			this._expectedUri = null; this._expectedTries = 0;
			if (uri !== this._playingUri || playing !== this._isPlaying) {
				this._playingUri = uri; this._isPlaying = playing; this._updatePlayIcons();
			}
		}));
	},
	// || (pause) on the playing row, ▶ (play) when paused; hidden on the rest
	_updatePlayIcons: function () {
		if (!this.tracks) { return; }
		for (var i = 0; i < this.tracks.length; i++) {
			var img = this.$["pp" + i];
			if (!img) { continue; }
			if (this._playingUri && this.tracks[i].path === this._playingUri) {
				img.setSrc(this._isPlaying ? "images/pp_pause.png" : "images/pp_play.png");
				img.setShowing(true);
			} else {
				img.setShowing(false);
			}
		}
	},
	onPlayPauseTap: function (sender, ev) {
		if (this._isPlaying) { this._post("/player/pause"); this._isPlaying = false; }
		else { this._post("/player/play"); this._isPlaying = true; }
		this._updatePlayIcons();
		return true; // don't bubble to the row's tapTrack (would restart the track)
	}
});
