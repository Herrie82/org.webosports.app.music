/*globals enyo, $L, event, Utilities, window, PalmSystem, XMLHttpRequest */

/**
 * kindSpotifyIndex
 * ----------------
 * Remote data source that mirrors kindMediaIndex (utility/mediaindex.js) but is
 * backed by the Spotify Web API through the on-device Go backend instead of the
 * local com.palm.db media database.
 *
 * It keeps the SAME public surface the list views + app.js use:
 *    requestMedia(objGetMediaRequest)   // {mediaType, order, desc, where, collate}
 *    playSongs(objGetMediaRequest)
 *    event onSetPlaybackList
 * so listViewSongs / listViewAlbums / listViewArtists / listViewGenres and the
 * search box render Spotify results with zero UI changes.
 *
 * Both kindMediaIndex (local) and kindSpotifyIndex (remote) live in the app at
 * once — this is the LOCAL + REMOTE design. app.js instantiates both and a
 * source selector (nav panel "Local" vs "Spotify", or a merged search) decides
 * which index answers a given request.
 *
 * Media objects are normalised to the shape the existing views expect, with the
 * playable "path" set to a Spotify URI so kindAudioRouter sends it to librespot:
 *    { path:"spotify:track:...", title, artist, album, albumId, artistId,
 *      genre, duration (sec), thumbnail (url), spotifyId, source:"spotify" }
 *
 * STATUS: scaffold — HTTP + normalisation wired; paging/collation TODO.
 */
enyo.kind({
	name: "kindSpotifyIndex",
	kind: "Component",
	published: { backend: "http://127.0.0.1:8730" },
	events: { onSetPlaybackList: "", onMediaReady: "", onFailure: "" },

	_call: function (method, path, onOk, onErr) {
		try {
			var xhr = new XMLHttpRequest();
			xhr.open(method, this.backend + path, true);
			xhr.onreadystatechange = enyo.bind(this, function () {
				if (xhr.readyState !== 4) { return; }
				if (xhr.status >= 200 && xhr.status < 300) {
					var d = null;
					try { d = xhr.responseText ? enyo.json.parse(xhr.responseText) : {}; } catch (e) {}
					if (onOk) { onOk(d); }
				} else if (onErr) { onErr(xhr.status, xhr.responseText); }
			});
			xhr.send(null);
		} catch (e) { if (onErr) { onErr(-1, String(e)); } }
	},

	// Map a Spotify Web API "track" object -> the app's media-item shape.
	_normalizeTrack: function (t) {
		var img = (t.album && t.album.images && t.album.images.length) ? t.album.images[0].url : "";
		return {
			path: t.uri,                                   // spotify:track:...
			spotifyId: t.id,
			source: "spotify",
			title: t.name,
			artist: (t.artists && t.artists.length) ? t.artists[0].name : "",
			artistId: (t.artists && t.artists.length) ? t.artists[0].id : "",
			album: t.album ? t.album.name : "",
			albumId: t.album ? t.album.id : "",
			genre: "",                                     // Spotify tracks carry no genre
			duration: t.duration_ms ? Math.floor(t.duration_ms / 1000) : 0,
			thumbnail: img
		};
	},

	/**
	 * requestMedia — same entry point kindMediaIndex exposes.
	 * For Spotify we treat objGetMediaRequest.where as the free-text query and
	 * mediaType as the Spotify search/browse type.
	 */
	requestMedia: function (objGetMediaRequest) {
		var q = encodeURIComponent(objGetMediaRequest.where || objGetMediaRequest.query || "");
		var type = objGetMediaRequest.mediaType || "song";
		var typeMap = { song: "track", artist: "artist", album: "album", genre: "playlist" };
		var path = "/search?type=" + (typeMap[type] || "track") + "&q=" + q + "&limit=50";
		this._call("GET", path,
			enyo.bind(this, function (data) {
				var items = (data && data.tracks ? data.tracks : (data && data.items) || []);
				var media = enyo.map(items, this.bindSafely("_normalizeTrack"));
				this.doMediaReady({ request: objGetMediaRequest, results: media });
			}),
			enyo.bind(this, function (status, text) {
				this.doFailure({ status: status, message: text });
			})
		);
	},

	// Build a playback list out of Spotify results and hand it to playback.js.
	playSongs: function (objGetMediaRequest) {
		this.requestMedia(enyo.mixin(enyo.clone(objGetMediaRequest), {
			_onReady: enyo.bind(this, function (media) {
				this.doSetPlaybackList({ list: media, source: "spotify" });
			})
		}));
	},

	// enyo 0.10 lacks bindSafely on some builds; provide a shim.
	bindSafely: function (fn) { return enyo.bind(this, this[fn]); }
});
