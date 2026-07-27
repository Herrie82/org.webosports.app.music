/*globals enyo, $L, event, Utilities, window */

/**
 * kindAutoListView (MPR autolists — the on-screen views)
 * ------------------------------------------------------
 * Surfaces the play-tracking data as MPR-style autolists:
 *   - Recently Played  (playstat orderBy lastPlayed desc)
 *   - Most Played      (playstat orderBy playCount desc)
 *   - Recently Added   (media DB orderBy modifiedTime desc)
 * Tapping a row plays from that point (fires onSetPlaybackList, same as the
 * local/Spotify list views).
 */
enyo.kind({
	name: "kindAutoListView",
	kind: "VFlexBox",
	className: "autolist-view",
	playstatKind: "com.herrie.musicspotify.playstat:1",
	mediaKind: "com.palm.media.audio.file:1",
	events: { onSetPlaybackList: "" },
	tracks: [],
	mode: "recent",

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ content: $L("Auto Playlists"), className: "autolist-title", flex: 1 }
		]},
		{ className: "autolist-tabs", layoutKind: "HFlexLayout", components: [
			{ name: "tabRecent", kind: "Button", flex: 1, content: $L("Recently Played"), onclick: "showRecent" },
			{ name: "tabMost",   kind: "Button", flex: 1, content: $L("Most Played"),     onclick: "showMost" },
			{ name: "tabAdded",  kind: "Button", flex: 1, content: $L("Recently Added"),  onclick: "showAdded" }
		]},
		{ name: "status", className: "autolist-status", content: "" },
		{ name: "scroller", kind: "Scroller", flex: 1, components: [
			{ name: "resultList", className: "autolist-results" }
		]},
		{ name: "svcFind", kind: "PalmService", service: "palm://com.palm.db/", method: "find", onSuccess: "onResults", onFailure: "onFail" }
	],

	rendered: function () { this.inherited(arguments); this.refresh(); },

	showRecent: function () { this.mode = "recent"; this.refresh(); },
	showMost:   function () { this.mode = "most";   this.refresh(); },
	showAdded:  function () { this.mode = "added";  this.refresh(); },

	refresh: function () {
		this.$.status.setContent($L("Loading…"));
		var q;
		if (this.mode === "added") {
			// media kind only indexes _rev (monotonic) — a good "recently added/changed" proxy.
			q = { from: this.mediaKind, orderBy: "_rev", desc: true, limit: 100 };
		} else {
			q = { from: this.playstatKind, orderBy: this.mode === "most" ? "playCount" : "lastPlayed", desc: true, limit: 100 };
		}
		this.$.svcFind.call({ query: q });
	},

	onFail: function (sender, resp) { this.$.status.setContent($L("Nothing yet — play some music first.")); this.tracks = []; this.$.resultList.destroyComponents(); this.$.resultList.render(); },

	onResults: function (sender, resp) {
		var rows = (resp && resp.results) || [];
		// normalise media vs playstat rows to a common shape
		this.tracks = enyo.map(rows, enyo.bind(this, function (o) {
			return {
				path: o.path || (o.trackId && o.trackId.length === 22 ? ("spotify:track:" + o.trackId) : o.path) || "",
				title: o.title || o.name || "",
				artist: o.artist || "",
				album: o.album || "",
				plays: o.playCount || 0
			};
		}));
		this.$.status.setContent(this.tracks.length ? "" : $L("Nothing yet — play some music first."));
		this.renderResults();
	},

	renderResults: function () {
		this.$.resultList.destroyComponents();
		enyo.forEach(this.tracks, function (t, i) {
			var sub = (t.artist || "") + (t.album ? " — " + t.album : "");
			if (this.mode === "most" && t.plays) { sub = t.plays + "×  " + sub; }
			this.$.resultList.createComponent({
				kind: "Item", index: i, layoutKind: "VFlexLayout", className: "autolist-row", onclick: "tapTrack", components: [
					{ content: t.title || $L("(unknown)"), className: "autolist-row-title" },
					{ content: sub, className: "autolist-row-sub" }
				]
			}, { owner: this });
		}, this);
		this.$.resultList.render();
	},

	tapTrack: function (sender) {
		var start = sender.index || 0;
		var list = enyo.map(this.tracks, function (t) {
			return {
				path: t.path, _id: t.path, title: t.title, artist: t.artist, album: t.album,
				duration: 0, thumbnails: []
			};
		});
		// drop any rows without a playable path
		list = enyo.filter(list, function (x) { return x.path; });
		if (!list.length) { this.$.status.setContent($L("These tracks aren't playable from here yet.")); return; }
		this.doSetPlaybackList({
			arSetPlaybackList: list, intStartTrackIndex: start, intStartTrackTime: 0,
			strOriginListID: "autolist-" + this.mode, strListQuery: JSON.stringify({ autolist: this.mode })
		});
	}
});
