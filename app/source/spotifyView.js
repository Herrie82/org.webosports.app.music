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
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ content: $L("Spotify"), className: "spotify-title", flex: 1 },
			{ name: "authLabel", content: $L("Checking…"), className: "spotify-authlabel" }
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
		{ name: "searchRow", className: "spotify-searchrow", showing: false, layoutKind: "HFlexLayout", align: "center", components: [
			{ name: "search", kind: "Input", flex: 1, hint: $L("Search Spotify…"), onkeyup: "searchKey" },
			{ name: "btnSearch", kind: "Button", content: $L("Search"), onclick: "doSearch" }
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
		this.$.authLabel.setContent(ok ? $L("Connected ✓") : $L("Not connected"));
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
				className: "spotify-row", onclick: "tapTrack", components: [
					{ kind: "Image", src: t.thumbnail || "", className: "spotify-art" },
					{ kind: "Control", flex: 1, className: "spotify-meta", components: [
						{ content: t.title || "", className: "spotify-row-title" },
						{ content: ((t.artist || "") + " — " + (t.album || "")), className: "spotify-row-sub" }
					]}
				]
			}, { owner: this });
		}, this);
		this.$.resultList.render();
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
		this.$.status.setContent($L("Playing: ") + (this.tracks[start] ? this.tracks[start].title : ""));
		this.doSetPlaybackList({
			arSetPlaybackList: list, intStartTrackIndex: start, intStartTrackTime: 0,
			strOriginListID: "spotify-search", strListQuery: JSON.stringify({ spotify: true })
		});
	}
});
