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
	className: "streaming-view",
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
			{ name: "authLabel", content: "", className: "streaming-authlabel" }
		]},
		// provider tabs — a native TabGroup (segmented bar, like Messaging), one tab
		// per connector with its logo + name. Built from /providers in buildTabs().
		{ name: "tabs", kind: "TabGroup", onChange: "onTabChange", className: "connector-tabs", pack: "center",
		  style: "border-bottom:1px solid #c3c3c3; background:#ededed;" },
		{ name: "searchRow", className: "streaming-searchrow", layoutKind: "HFlexLayout", align: "center", style: "padding:10px 12px 46px 12px; border-bottom:1px solid #c3c3c3; position:relative;", components: [
			{ name: "search", kind: "Input", flex: 1, hint: $L("Search…"), onkeyup: "searchKey", style: "height:40px; font-size:16px; padding-right:40px;" },
			{ name: "btnSearch", kind: "Image", src: "images/empty-search.png", onclick: "doSearch", style: "position:absolute; right:22px; top:16px; width:28px; height:28px;" }
		]},
		{ name: "status", className: "streaming-status", content: "" },
		{ name: "scroller", kind: "Scroller", flex: 1, components: [
			{ name: "resultList", className: "streaming-results" }
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
	// Short tab captions so long names don't crowd the segmented bar.
	_shortName: function (p) {
		var m = { youtube: "YouTube", archive: "Archive" };
		return m[p.id] || p.name || p.id;
	},
	// Re-fetch /providers so newly-added accounts (e.g. Qobuz/Tidal added while the
	// app was open) show up. Called when the Connectors view is navigated to.
	refreshProviders: function () { this.loadProviders(); },

	buildTabs: function (providers) {
		var prevProvider = this._provider; // preserve the selected tab across a rebuild
		var kids = this.$.tabs.getControls ? this.$.tabs.getControls() : this.$.tabs.children;
		for (var k = kids.length - 1; k >= 0; k--) { if (kids[k] && kids[k].destroy) { kids[k].destroy(); } }
		// Include Spotify too (unified UI). Its tracks play via librespot rather than
		// the stream player — the router picks the engine by path prefix; only the
		// in-row transport endpoints differ (handled by _isSpotify below).
		var list = [];
		enyo.forEach(providers, function (p) { if (p && p.id) { list.push(p); } });
		this._providersList = list;
		if (!list.length) { this.$.authLabel.setContent($L("No connectors")); return; }
		// One TabButton per connector: logo (icon) + name (caption). value = index,
		// which onTabChange maps back to the provider via _providersList.
		enyo.forEach(list, function (p, i) {
			this.$.tabs.createComponent({
				kind: "TabButton", value: i, provId: p.id, provName: p.name || p.id,
				caption: this._shortName(p), icon: "images/connectors/" + p.id + ".png"
			}, { owner: this });
		}, this);
		this.$.tabs.render();
		// Restore the previously-selected provider if it's still present, else the first.
		var idx = 0;
		for (var s = 0; s < list.length; s++) { if (list[s].id === prevProvider) { idx = s; break; } }
		this.$.tabs.setValue(idx);
		this._setProvider(list[idx].id, list[idx].name || list[idx].id);
	},
	// Fired when a tab is tapped; inValue is the selected tab's value (its index).
	onTabChange: function (inSender, inValue) {
		var p = this._providersList && this._providersList[inValue];
		if (!p) { return; }
		this._setProvider(p.id, p.name || p.id);
		var q = this.$.search.getValue();
		if (q) { this.doSearch(); } else { this._clearRows(); this.$.status.setContent(""); }
	},
	_setProvider: function (id, name) {
		this._provider = id; this._providerName = name;
		this.$.search.setHint($L("Search ") + name + "…");
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
				style: "background:#e5e5e5; border-bottom:1px solid #c3c3c3; padding:0 12px; height:54px; -webkit-box-sizing:border-box;", className: "streaming-row", tapHighlight: true, tapHighlightClassName: "active", onclick: "tapTrack", components: [
					{ kind: "Image", src: t.thumbnail || "", className: "streaming-art", style: "width:40px; height:40px; margin:0 12px 0 10px;" },
					{ kind: "Control", flex: 1, className: "streaming-meta", components: [
						{ content: t.title || "", className: "streaming-row-title" },
						{ content: ((t.artist || "") + (t.album ? " — " + t.album : "")), className: "streaming-row-sub" }
					]},
					{ name: "fmt" + i, showing: false, className: "connector-fmt-badge", onclick: "onFmtTap", style: "margin-left:10px; padding:1px 7px; font-size:11px; line-height:16px; border:1px solid #9a9a9a; border-radius:9px; color:#555; background:#f2f2f2; white-space:nowrap;" },
					{ name: "pp" + i, kind: "Image", showing: false, onclick: "onPlayPauseTap", style: "width:32px; height:32px; margin-left:12px;" },
					{ content: this._fmtDur(t.duration_ms), className: "streaming-row-time", style: "text-align:right; padding-left:12px;" }
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
		this._nowFormat = "";
		this._updatePlayIcons();
		this._updateFmtBadge();
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
			if (!sp && d.ended) { this._stopStatusPoll(); this._playingIndex = -1; this._isPlaying = false; this._nowFormat = ""; this._updatePlayIcons(); this._updateFmtBadge(); return; }
			var playing = !!d.is_playing;
			this._nowFormat = d.format || "";
			this._nowFormats = d.formats || [];
			if (playing !== this._isPlaying) { this._isPlaying = playing; this._updatePlayIcons(); }
			this._updateFmtBadge();
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
	// Quality/format badge on the currently-playing row (fed by the backend status),
	// hidden on the rest.
	_updateFmtBadge: function () {
		if (!this.tracks) { return; }
		for (var i = 0; i < this.tracks.length; i++) {
			var b = this.$["fmt" + i];
			if (!b) { continue; }
			if (i === this._playingIndex && this._nowFormat) {
				b.setContent(this._nowFormat);
				b.setShowing(true);
			} else {
				b.setShowing(false);
			}
		}
	},
	onPlayPauseTap: function (sender, ev) {
		var sp = this._isSpotify();
		if (this._isPlaying) { this._post(sp ? "/player/pause" : "/stream/pause"); this._isPlaying = false; }
		else { this._post(sp ? "/player/play" : "/stream/resume"); this._isPlaying = true; }
		this._updatePlayIcons();
		return true; // don't bubble to tapTrack
	},
	// Tap the quality badge to cycle to the next available format and switch to it
	// (re-resolves + restarts the current track in that format via the backend).
	onFmtTap: function (sender, ev) {
		var fmts = this._nowFormats || [];
		if (fmts.length < 2) { return true; }
		var idx = 0;
		for (var k = 0; k < fmts.length; k++) { if (fmts[k] === this._nowFormat) { idx = k; break; } }
		var next = fmts[(idx + 1) % fmts.length];
		this._nowFormat = next; // optimistic; the status poll confirms
		this._updateFmtBadge();
		try { var x = new XMLHttpRequest(); x.open("POST", this.backend + "/stream/switchformat", true); x.setRequestHeader("Content-Type", "application/json"); x.send(JSON.stringify({ format: next })); } catch (e) {}
		return true; // don't bubble to tapTrack
	}
});
