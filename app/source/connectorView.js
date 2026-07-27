/*globals enyo, $L, window, XMLHttpRequest */

/**
 * kindConnectorView — the "Connectors" library view.
 *
 * A generic music-service search view over the Go backend's provider registry
 * (GET /providers). A row of provider tabs (SoundCloud, YouTube, Deezer, Jamendo,
 * Internet Archive, …) picks which service to search; results play through the
 * shared stream player via kindPlayback -> kindAudioRouter -> kindStreamManager
 * (paths look like "<provider>:<id>").
 *
 * Spotify is intentionally excluded here — it has its own view (librespot/Connect).
 * Styling reuses the Spotify view classes/inline styles so the rows match.
 */
enyo.kind({
	name: "kindConnectorView",
	kind: "VFlexBox",
	className: "spotify-view",
	published: { backend: "http://127.0.0.1:8730" },
	events: { onSetPlaybackList: "" },

	tracks: [],
	_provider: "",
	_providerName: "",
	_statusPoll: null,
	_playingIndex: -1,
	_isPlaying: false,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar enyo-toolbar-light list-header", pack: "justify", layoutKind: "HFlexLayout", components: [
			{ kind: "Control", className: "list-header-title-layout", layoutKind: "HLayout", components: [
				{ content: $L("Connectors"), className: "title enyo-text-ellipsis", flex: 1 }
			]},
			{ name: "authLabel", content: "", className: "spotify-authlabel" }
		]},
		// provider tabs (built from /providers)
		{ name: "tabs", className: "connector-tabs", layoutKind: "HFlexLayout", align: "center",
		  style: "padding:6px 8px; border-bottom:1px solid #c3c3c3; background:#ededed; overflow-x:auto;" },
		{ name: "searchRow", className: "spotify-searchrow", layoutKind: "HFlexLayout", align: "center", style: "padding:10px 12px 46px 12px; border-bottom:1px solid #c3c3c3; position:relative;", components: [
			{ name: "search", kind: "Input", flex: 1, hint: $L("Search…"), onkeyup: "searchKey", style: "height:40px; font-size:16px; padding-right:40px;" },
			{ name: "btnSearch", kind: "Image", src: "images/empty-search.png", onclick: "doSearch", style: "position:absolute; right:22px; top:16px; width:28px; height:28px;" }
		]},
		{ name: "status", className: "spotify-status", content: "" },
		{ name: "scroller", kind: "Scroller", flex: 1, components: [
			{ name: "resultList", className: "spotify-results" }
		]}
	],

	create: function () { this.inherited(arguments); this.loadProviders(); },
	rendered: function () { this.inherited(arguments); if (!this._provider) { this.loadProviders(); } },

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
	_post: function (path) {
		try { var x = new XMLHttpRequest(); x.open("POST", this.backend + path, true); x.send(null); } catch (e) {}
	},

	// --- provider tabs ---
	loadProviders: function () {
		this._get("/providers",
			enyo.bind(this, function (d) { this.buildTabs((d && d.providers) || []); }),
			enyo.bind(this, function () { this.$.authLabel.setContent($L("Backend offline")); })
		);
	},
	buildTabs: function (providers) {
		var kids = this.$.tabs.children;
		for (var k = kids.length - 1; k >= 0; k--) { if (kids[k] && kids[k].destroy) { kids[k].destroy(); } }
		// Include Spotify too (unified UI). Its tracks play via librespot rather than
		// the stream player — the router picks the engine by path prefix; only the
		// in-row transport endpoints differ (handled by _isSpotify below).
		var list = [];
		enyo.forEach(providers, function (p) { if (p && p.id) { list.push(p); } });
		if (!list.length) { this.$.authLabel.setContent($L("No connectors")); return; }
		enyo.forEach(list, function (p) {
			this.$.tabs.createComponent({
				kind: "Button", content: p.name || p.id, provId: p.id, provName: p.name || p.id,
				className: "connector-tab", onclick: "selectProvider",
				style: "margin:0 4px; padding:6px 12px; font-size:14px;"
			}, { owner: this });
		}, this);
		this.$.tabs.render();
		if (!this._provider) { this._setProvider(list[0].id, list[0].name || list[0].id); }
		this._highlightTabs();
	},
	selectProvider: function (sender) {
		this._setProvider(sender.provId, sender.provName);
		this._highlightTabs();
		var q = this.$.search.getValue();
		if (q) { this.doSearch(); } else { this._clearRows(); this.$.status.setContent(""); }
	},
	_setProvider: function (id, name) {
		this._provider = id; this._providerName = name;
		this.$.search.setHint($L("Search ") + name + "…");
	},
	_highlightTabs: function () {
		enyo.forEach(this.$.tabs.children, function (b) {
			if (!b.applyStyle) { return; }
			var on = (b.provId === this._provider);
			b.applyStyle("background", on ? "#4b91f7" : "");
			b.applyStyle("color", on ? "#fff" : "");
		}, this);
	},

	// --- search ---
	searchKey: function (sender, ev) { if (ev && ev.keyCode === 13) { this.doSearch(); } },
	doSearch: function () {
		var q = this.$.search.getValue();
		if (!q || !this._provider) { return; }
		// Bump a sequence so each search yields a UNIQUE strListQuery — otherwise
		// kindPlaybackList (which only rebuilds when the origin id/query changes)
		// keeps the PREVIOUS results and switchTrack()s into the stale list, playing
		// the wrong song.
		this._searchSeq = (this._searchSeq || 0) + 1;
		this.$.status.setContent($L("Searching ") + this._providerName + "…");
		this._get("/provider/" + this._provider + "/search?limit=40&q=" + encodeURIComponent(q),
			enyo.bind(this, function (d) { this.renderResults((d && d.tracks) || []); }),
			enyo.bind(this, function (s) { this.$.status.setContent($L("Search failed (") + s + ")"); })
		);
	},

	_fmtDur: function (ms) {
		if (!ms || ms < 0) { return ""; }
		var s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60;
		return m + ":" + (r < 10 ? "0" + r : r);
	},

	_clearRows: function () {
		var kids = this.$.resultList.children;
		for (var k = kids.length - 1; k >= 0; k--) { if (kids[k] && kids[k].destroy) { kids[k].destroy(); } }
	},

	renderResults: function (tracks) {
		this.tracks = tracks;
		this._playingIndex = -1;
		this.$.status.setContent(tracks.length ? "" : $L("No results"));
		this._clearRows();
		enyo.forEach(tracks, function (t, i) {
			this.$.resultList.createComponent({
				kind: "Item", index: i, layoutKind: "HFlexLayout", align: "center",
				style: "background:#e5e5e5; border-bottom:1px solid #c3c3c3; padding:0 12px; height:54px; -webkit-box-sizing:border-box;", className: "spotify-row", tapHighlight: true, tapHighlightClassName: "active", onclick: "tapTrack", components: [
					{ kind: "Image", src: t.thumbnail || "", className: "spotify-art", style: "width:40px; height:40px; margin:0 12px 0 10px;" },
					{ kind: "Control", flex: 1, className: "spotify-meta", components: [
						{ content: t.title || "", className: "spotify-row-title" },
						{ content: ((t.artist || "") + (t.album ? " — " + t.album : "")), className: "spotify-row-sub" }
					]},
					{ name: "pp" + i, kind: "Image", showing: false, onclick: "onPlayPauseTap", style: "width:18px; height:18px; margin-left:12px;" },
					{ content: this._fmtDur(t.duration_ms), className: "spotify-row-time", style: "text-align:right; padding-left:12px;" }
				]
			}, { owner: this });
		}, this);
		this.$.resultList.render();
		this._updatePlayIcons();
	},

	// --- play ---
	tapTrack: function (sender) {
		var start = sender.index || 0;
		var list = enyo.map(this.tracks, function (t) {
			return {
				path: t.path, _id: t.id || t.path,
				title: t.title || "", artist: t.artist || "", album: t.album || "",
				duration: t.duration_ms ? Math.floor(t.duration_ms / 1000) : 0,
				thumbnails: t.thumbnail ? [{ data: t.thumbnail }] : []
			};
		});
		this._playingIndex = start;
		this._isPlaying = true;
		this._updatePlayIcons();
		this._startStatusPoll();
		this.doSetPlaybackList({
			arSetPlaybackList: list, intStartTrackIndex: start, intStartTrackTime: 0,
			strOriginListID: "connector-" + this._provider, strListQuery: JSON.stringify({ connector: this._provider, seq: this._searchSeq || 0 })
		});
	},

	// --- in-row now-playing indicator (the stream player plays one track at a time,
	// so the playing row is simply the one we last started) ---
	_startStatusPoll: function () {
		if (this._statusPoll) { return; }
		this._statusPoll = window.setInterval(enyo.bind(this, this._pollStatus), 1500);
	},
	_stopStatusPoll: function () { if (this._statusPoll) { window.clearInterval(this._statusPoll); this._statusPoll = null; } },
	_isSpotify: function () { return this._provider === "spotify"; },
	_pollStatus: function () {
		var sp = this._isSpotify();
		this._get(sp ? "/player/status" : "/stream/status", enyo.bind(this, function (d) {
			if (!d) { return; }
			// stream player reports `ended` when the pipeline exits; librespot doesn't,
			// so for Spotify just track is_playing on the tapped row.
			if (!sp && d.ended) { this._stopStatusPoll(); this._playingIndex = -1; this._isPlaying = false; this._updatePlayIcons(); return; }
			var playing = !!d.is_playing;
			if (playing !== this._isPlaying) { this._isPlaying = playing; this._updatePlayIcons(); }
		}));
	},
	_updatePlayIcons: function () {
		if (!this.tracks) { return; }
		for (var i = 0; i < this.tracks.length; i++) {
			var img = this.$["pp" + i];
			if (!img) { continue; }
			if (i === this._playingIndex) {
				img.setSrc(this._isPlaying ? "images/pp_pause.png" : "images/pp_play.png");
				img.setShowing(true);
			} else {
				img.setShowing(false);
			}
		}
	},
	onPlayPauseTap: function (sender, ev) {
		var sp = this._isSpotify();
		if (this._isPlaying) { this._post(sp ? "/player/pause" : "/stream/pause"); this._isPlaying = false; }
		else { this._post(sp ? "/player/play" : "/stream/resume"); this._isPlaying = true; }
		this._updatePlayIcons();
		return true; // don't bubble to tapTrack
	}
});
