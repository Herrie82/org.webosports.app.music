/*globals enyo, $L, event, Utilities, window, XMLHttpRequest */

/**
 * kindAccountManager (Music-as-a-webOS-Account bridge)
 * ----------------------------------------------------
 * Lets the app source its Spotify session from a webOS Account instead of an
 * in-app login. On startup syncSpotify() runs:
 *   1. listAccounts (capability "Music", fallback: all accounts filtered by the
 *      com.herrie.music.* templateId prefix) via com.palm.service.accounts
 *   2. readCredentials {accountId, name:"common"} for the first Spotify account
 *   3. normalise the stored token (3 nesting shapes) and POST it to the local Go
 *      backend's /session so playback + search work with no separate sign-in.
 *
 * The account credentials are stored camelCase (accessToken/refreshToken/expiry,
 * matching the cloud-auth "common" convention); /session wants snake_case
 * (access_token/refresh_token/expiry), so we map on the way out.
 *
 * Everything is best-effort: no Music account -> just log and stop; the backend
 * already falls back to its persisted /media/internal token file.
 */
enyo.kind({
	name: "kindAccountManager",
	kind: "Component",
	published: { backend: "http://127.0.0.1:8730" },
	events: { onSynced: "" },   // onSynced(ok, accountId)

	templatePrefix: "com.herrie.music.",
	spotifyTemplate: "com.herrie.music.spotify",

	components: [
		// Prefer a capability-filtered list; fall back to an unfiltered list.
		{ name: "svcListByCap", kind: "PalmService", service: "palm://com.palm.service.accounts/", method: "listAccountsPublic", onSuccess: "onListByCap", onFailure: "onListCapFail" },
		{ name: "svcListAll",   kind: "PalmService", service: "palm://com.palm.service.accounts/", method: "listAccountsPublic", onSuccess: "onListAll",  onFailure: "onSvcFail" },
		{ name: "svcCreds",     kind: "PalmService", service: "palm://com.palm.service.accounts/", method: "readCredentialsPublic", onSuccess: "onCreds", onFailure: "onSvcFail" }
	],

	// --- entry point: find a Music account and hand its token to the backend ---
	syncSpotify: function () {
		this.log("accountmanager: syncSpotify start");
		this.$.svcListByCap.call({ capability: "Music" });
	},

	// capability filter returned -> use it if it has rows, else try the full list
	onListByCap: function (sender, resp) {
		var accts = (resp && resp.accounts) || [];
		this.log("accountmanager: listAccounts(capability=Music) -> " + accts.length);
		if (accts.length) { this._pickAndRead(accts); }
		else { this.$.svcListAll.call({}); }
	},
	onListCapFail: function (sender, resp) {
		// Older builds may reject an unknown capability filter; fall back cleanly.
		this.log("accountmanager: capability filter failed, trying full list");
		this.$.svcListAll.call({});
	},

	// unfiltered list -> keep only our music templates
	onListAll: function (sender, resp) {
		var accts = (resp && resp.accounts) || [];
		var mine = [];
		for (var i = 0; i < accts.length; i++) {
			var tid = accts[i].templateId || "";
			if (tid.indexOf(this.templatePrefix) === 0) { mine.push(accts[i]); }
		}
		this.log("accountmanager: listAccounts(all) -> " + accts.length + ", music=" + mine.length);
		this._pickAndRead(mine);
	},

	// choose the first Spotify account and read its credentials
	_pickAndRead: function (accts) {
		var chosen = null;
		for (var i = 0; i < accts.length; i++) {
			if (accts[i].templateId === this.spotifyTemplate) { chosen = accts[i]; break; }
		}
		if (!chosen) { this.log("accountmanager: no Spotify account found"); this.doSynced(false, null); return; }
		this._accountId = chosen._id || chosen.accountId || "";
		if (!this._accountId) { this.log("accountmanager: account has no id"); this.doSynced(false, null); return; }
		this.log("accountmanager: reading credentials for " + this._accountId);
		this.$.svcCreds.call({ accountId: this._accountId, name: "common" });
	},

	// credentials -> normalise the nesting -> POST to /session
	onCreds: function (sender, resp) {
		var c = this._normaliseCreds(resp);
		if (!c || !c.refreshToken) { this.log("accountmanager: no usable token in credentials"); this.doSynced(false, this._accountId); return; }
		this._postSession(c);
	},

	// readCredentials may return the creds directly, wrapped as {credentials:...},
	// or still nested under {common:...}; normalise all three to the common blob.
	_normaliseCreds: function (resp) {
		var node = resp || {};
		if (node.credentials) { node = node.credentials; }
		if (node.common) { node = node.common; }
		return node;
	},

	_postSession: function (c) {
		var body = { access_token: c.accessToken || "", refresh_token: c.refreshToken || "", expiry: c.expiry || "" };
		this.log("accountmanager: POST /session from account " + this._accountId);
		try {
			var xhr = new XMLHttpRequest();
			xhr.open("POST", this.backend + "/session", true);
			xhr.setRequestHeader("Content-Type", "application/json");
			xhr.onreadystatechange = enyo.bind(this, function () {
				if (xhr.readyState !== 4) { return; }
				var ok = (xhr.status >= 200 && xhr.status < 300);
				this.log("accountmanager: /session -> " + xhr.status);
				this.doSynced(ok, this._accountId);
			});
			xhr.send(enyo.json.stringify(body));
		} catch (e) {
			this.log("accountmanager: /session post error: " + e);
			this.doSynced(false, this._accountId);
		}
	},

	onSvcFail: function (sender, resp) {
		this.log("accountmanager: accounts service error: ", resp);
		this.doSynced(false, this._accountId || null);
	}
});
