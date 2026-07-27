/*globals enyo, $L, event, Utilities, window */

/**
 * kindBookmarkManager (MPR feature port)
 * -------------------------------------
 * Auto + manual bookmarks so playback resumes where you left off (great for
 * podcasts/audiobooks/long mixes). Stores one row per track id in our own db8
 * kind com.herrie.musicspotify.bookmark:1 { trackId, position(sec), duration }.
 *
 * app.js wiring:
 *   - onUpdateTrackTime (throttled ~10s)  -> save(trackId, pos, dur)
 *   - onTrackSrcChanged (track started)   -> fetch(trackId) -> onBookmark event
 *   - onTrackEnded / finished             -> clear(trackId)
 * The app seeks to the bookmark on onBookmark.
 */
enyo.kind({
	name: "kindBookmarkManager",
	kind: "Component",
	kindId: "com.herrie.musicspotify.bookmark:1",
	owner_: "com.herrie.musicspotify",
	events: { onBookmark: "" },
	components: [
		{ name: "svcPutKind", kind: "PalmService", service: "palm://com.palm.db/", method: "putKind", onSuccess: "onKindReady", onFailure: "onDbFail" },
		{ name: "svcFind",    kind: "PalmService", service: "palm://com.palm.db/", method: "find",    onSuccess: "onFound",    onFailure: "onDbFail" },
		{ name: "svcMerge",   kind: "PalmService", service: "palm://com.palm.db/", method: "merge",   onSuccess: "onMerged",   onFailure: "onDbFail" },
		{ name: "svcPut",     kind: "PalmService", service: "palm://com.palm.db/", method: "put",                              onFailure: "onDbFail" },
		{ name: "svcDel",     kind: "PalmService", service: "palm://com.palm.db/", method: "del",                              onFailure: "onDbFail" }
	],

	create: function () {
		this.inherited(arguments);
		this._pendingTrack = null;
		this.$.svcPutKind.call({
			id: this.kindId,
			owner: this.owner_,
			indexes: [{ name: "byTrack", props: [{ name: "trackId" }] }]
		});
	},

	onKindReady: function () { this.log("bookmark kind ready"); },
	onDbFail: function (sender, resp) { this.log("bookmark db fail: ", resp); },

	// --- save (upsert by trackId) ---
	save: function (trackId, position, duration) {
		if (!trackId || position === undefined) { return; }
		this._save = { trackId: String(trackId), position: Math.floor(position), duration: Math.floor(duration || 0) };
		this.$.svcMerge.call({
			query: { from: this.kindId, where: [{ prop: "trackId", op: "=", val: this._save.trackId }] },
			props: { position: this._save.position, duration: this._save.duration }
		});
	},
	onMerged: function (sender, resp) {
		// nothing matched -> insert a new row
		if (this._save && resp && resp.count === 0) {
			var o = this._save;
			this.$.svcPut.call({ objects: [{ _kind: this.kindId, trackId: o.trackId, position: o.position, duration: o.duration }] });
		}
	},

	// --- fetch (-> onBookmark(trackId, position, duration)) ---
	fetch: function (trackId) {
		if (!trackId) { return; }
		this._pendingTrack = String(trackId);
		this.$.svcFind.call({ query: { from: this.kindId, where: [{ prop: "trackId", op: "=", val: this._pendingTrack }] } });
	},
	onFound: function (sender, resp) {
		var pos = 0, dur = 0;
		if (resp && resp.results && resp.results.length) {
			pos = resp.results[0].position || 0;
			dur = resp.results[0].duration || 0;
		}
		this.doBookmark(this._pendingTrack, pos, dur);
	},

	// --- clear (track finished) ---
	clear: function (trackId) {
		if (!trackId) { return; }
		this.$.svcDel.call({ query: { from: this.kindId, where: [{ prop: "trackId", op: "=", val: String(trackId) }] } });
	}
});
