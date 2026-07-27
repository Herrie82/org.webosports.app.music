/*globals enyo, $L, event, Utilities, window */

/**
 * kindPlayStatManager (MPR autolists foundation)
 * ----------------------------------------------
 * Tracks per-track play count + last-played time in our db8 kind
 * com.herrie.musicspotify.playstat:1 { trackId, playCount, lastPlayed, title,
 * artist, album }. This powers MPR-style autolists:
 *   - Recently Played  (orderBy lastPlayed desc)
 *   - Most Played      (orderBy playCount desc)
 * ("Recently Added" comes from the media DB's own date index, no tracking.)
 *
 * app.js records a play on onTrackSrcChanged; the autolist views query via
 * recentlyPlayed()/mostPlayed().
 */
enyo.kind({
	name: "kindPlayStatManager",
	kind: "Component",
	kindId: "com.herrie.musicspotify.playstat:1",
	owner_: "com.herrie.musicspotify",
	events: { onList: "" },
	components: [
		{ name: "svcPutKind", kind: "PalmService", service: "palm://com.palm.db/", method: "putKind", onSuccess: "onKindReady", onFailure: "onDbFail" },
		{ name: "svcFind1",   kind: "PalmService", service: "palm://com.palm.db/", method: "find",    onSuccess: "onFindForRecord", onFailure: "onDbFail" },
		{ name: "svcMerge",   kind: "PalmService", service: "palm://com.palm.db/", method: "merge",                                onFailure: "onDbFail" },
		{ name: "svcPut",     kind: "PalmService", service: "palm://com.palm.db/", method: "put",                                  onFailure: "onDbFail" },
		{ name: "svcQuery",   kind: "PalmService", service: "palm://com.palm.db/", method: "find",    onSuccess: "onQueryResult",  onFailure: "onDbFail" }
	],

	create: function () {
		this.inherited(arguments);
		this.$.svcPutKind.call({
			id: this.kindId,
			owner: this.owner_,
			indexes: [
				{ name: "byTrack",      props: [{ name: "trackId" }] },
				{ name: "byLastPlayed", props: [{ name: "lastPlayed" }] },
				{ name: "byPlayCount",  props: [{ name: "playCount" }] }
			]
		});
	},
	onKindReady: function () { this.log("playstat kind ready"); },
	onDbFail: function (sender, resp) { this.log("playstat db fail: ", resp); },

	// --- record a play (upsert; increments playCount, sets lastPlayed) ---
	recordPlay: function (trackId, title, artist, album, path) {
		if (!trackId) { return; }
		this._rec = { trackId: String(trackId), title: title || "", artist: artist || "", album: album || "", path: path || "" };
		this.$.svcFind1.call({ query: { from: this.kindId, where: [{ prop: "trackId", op: "=", val: this._rec.trackId }] } });
	},
	onFindForRecord: function (sender, resp) {
		var now = (new Date()).getTime();
		var r = this._rec;
		if (resp && resp.results && resp.results.length) {
			var cur = resp.results[0];
			this.$.svcMerge.call({
				query: { from: this.kindId, where: [{ prop: "trackId", op: "=", val: r.trackId }] },
				props: { playCount: (cur.playCount || 0) + 1, lastPlayed: now, path: r.path }
			});
		} else {
			this.$.svcPut.call({ objects: [{
				_kind: this.kindId, trackId: r.trackId, playCount: 1, lastPlayed: now,
				title: r.title, artist: r.artist, album: r.album, path: r.path
			}] });
		}
	},

	// --- autolist queries (-> onList(which, results)) ---
	recentlyPlayed: function (limit) { this._which = "recent"; this._q(limit, "byLastPlayed"); },
	mostPlayed:     function (limit) { this._which = "most";   this._q(limit, "byPlayCount"); },
	_q: function (limit, index) {
		this.$.svcQuery.call({ query: { from: this.kindId, orderBy: index === "byLastPlayed" ? "lastPlayed" : "playCount", desc: true, limit: limit || 50 } });
	},
	onQueryResult: function (sender, resp) {
		this.doList(this._which, (resp && resp.results) || []);
	}
});
