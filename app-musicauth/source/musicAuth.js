/* MusicAuth — customUI validator for the music account types (com.herrie.music.*).
 *
 * The Accounts app launches this with the template being added. Behaviour branches
 * on the template:
 *   - com.herrie.music.spotify  -> OAuth flow: obtain the token from the on-device
 *     backend (which owns PKCE) and return it as the account "common" credentials.
 *   - any other com.herrie.music.* (e.g. youtube) -> no OAuth: create the account
 *     immediately with a minimal credential stub so the service shows up as a source.
 * In both cases we return via enyo.CrossAppResult.sendResult -> Accounts createAccount.
 *
 * Heavily logged (prefix "MUSICAUTH:") so the flow is visible in /var/log/messages
 * as "com.herrie.musicauth: MUSICAUTH: ...".
 */
var BACKEND = "http://127.0.0.1:8730";

function mlog(s) {
	try { enyo.log("MUSICAUTH: " + s); } catch (e) {}
	try { console.log("MUSICAUTH: " + s); } catch (e2) {}
}

enyo.kind({
	name: "MusicAuth",
	kind: enyo.VFlexBox,
	components: [
		{ name: "xresult", kind: "enyo.CrossAppResult" },
		{ name: "status", content: "Connecting…", style: "padding:24px;font-size:22px;text-align:center;" },
		{ name: "addBtn", kind: "enyo.Button", caption: "Add Account", onclick: "onAddTap", style: "margin:16px;" },
		{ name: "web", kind: "enyo.BasicWebView", flex: 1, mimeType: "application/x-atlas-browser", onLoadURL: "onWebLoad" }
	],

	create: function () {
		this.inherited(arguments);
		this.done = false;
		var p = enyo.windowParams || {};
		this.templateObj = p.template || null;
		this.templateId = (this.templateObj && this.templateObj.templateId) || p.templateId || "com.herrie.music.spotify";
		// Service id is the last dotted segment: com.herrie.music.spotify -> "spotify".
		this.serviceId = this.templateId.split(".").pop();
		// Display name from the template loc_name, else a title-cased service id.
		this.serviceName = (this.templateObj && this.templateObj.loc_name) ||
			(this.serviceId.charAt(0).toUpperCase() + this.serviceId.slice(1));
		// Only Spotify has an OAuth/token flow today; other services just register.
		this.needsOAuth = (this.templateId === "com.herrie.music.spotify");
		this.$.addBtn.setCaption("Add " + this.serviceName + " Account");
		mlog("create; mode=" + p.mode + " templateId=" + this.templateId +
			" service=" + this.serviceId + " needsOAuth=" + this.needsOAuth);

		if (this.needsOAuth) {
			// Backend usually already holds a session; try to finish immediately,
			// else fall back to the WebView login.
			this.attemptFinish(true);
		} else {
			// No OAuth for this service — register it right away.
			this.setStatus("Adding " + this.serviceName + "…");
			this.finishNoAuth();
		}
	},

	setStatus: function (s) { this.$.status.setContent(s); mlog("status: " + s); },

	// ---- No-OAuth services (e.g. YouTube Music): create the account immediately ----
	finishNoAuth: function () {
		mlog("finishNoAuth for " + this.serviceId);
		this.finish({
			returnValue: true,
			templateId: this.templateId,
			template: this.templateObj,
			username: this.serviceName,
			alias: this.serviceName,
			config: {},
			credentials: { common: { service: this.serviceId } }
		});
	},

	// ---- Spotify OAuth flow ----
	// Try to fetch a token and return it to Accounts. If not authenticated and
	// startLoginIfNeeded is true, launch the WebView OAuth + poll.
	attemptFinish: function (startLoginIfNeeded) {
		mlog("attemptFinish; checking /auth/status");
		this.xhr(BACKEND + "/auth/status", enyo.bind(this, function (ok, j) {
			mlog("auth/status ok=" + ok + " body=" + JSON.stringify(j));
			if (ok && j && j.authenticated) {
				this.fetchTokenAndFinish();
			} else if (startLoginIfNeeded) {
				this.startLogin();
			} else {
				this.setStatus("Tap ‘Add " + this.serviceName + " Account’ after signing in.");
			}
		}));
	},

	onAddTap: function () {
		mlog("Add button tapped");
		if (this.needsOAuth) { this.attemptFinish(true); } else { this.finishNoAuth(); }
		return true;
	},

	startLogin: function () {
		this.setStatus("Sign in to " + this.serviceName + "…");
		try {
			this.$.web.setUrl("atlas-simple:" + BACKEND + "/login");
			this.$.web.render();
		} catch (e) { mlog("web render err: " + e); }
		this.startPoll();
	},

	startPoll: function () {
		if (this.pollId) { return; }
		mlog("startPoll");
		this.pollId = window.setInterval(enyo.bind(this, function () { this.attemptFinish(false); }), 2000);
	},
	stopPoll: function () {
		if (this.pollId) { window.clearInterval(this.pollId); this.pollId = null; }
	},

	onWebLoad: function (inSender, inUrl) {
		mlog("web loaded: " + inUrl);
		if (inUrl && inUrl.indexOf("/auth/callback") !== -1) { this.setStatus("Finishing sign-in…"); }
		return true;
	},

	fetchTokenAndFinish: function () {
		mlog("fetchTokenAndFinish; GET /auth/token");
		this.xhr(BACKEND + "/auth/token", enyo.bind(this, function (ok, j) {
			mlog("auth/token ok=" + ok + " hasRefresh=" + (!!(j && j.refreshToken)));
			if (!(ok && j && j.refreshToken)) { this.finish({ returnValue: false, errorCode: "NO_TOKEN" }); return; }
			var tok = j;
			// Fetch the real Spotify identity so the account is labelled with the
			// user's email/display name instead of a generic "Spotify".
			this.xhr(BACKEND + "/me", enyo.bind(this, function (mok, me) {
				mlog("me ok=" + mok + " body=" + JSON.stringify(me));
				var name = (me && (me.email || me.displayName || me.id)) || this.serviceName;
				var alias = (me && (me.displayName || me.email)) || this.serviceName;
				this.finish({
					returnValue: true,
					templateId: this.templateId,
					template: this.templateObj,
					username: name,
					alias: alias,
					config: {},
					credentials: { common: { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiry: tok.expiry } }
				});
			}));
		}));
	},

	finish: function (result) {
		if (this.done) { return; }
		this.done = true;
		this.stopPoll();
		mlog("sendResult: " + JSON.stringify(result));
		try {
			this.$.xresult.sendResult(result);
			mlog("sendResult returned");
		} catch (e) { mlog("sendResult threw: " + e); }
	},

	xhr: function (url, cb) {
		try {
			var x = new XMLHttpRequest();
			x.open("GET", url, true);
			x.onreadystatechange = function () {
				if (x.readyState !== 4) { return; }
				var j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
				cb(x.status >= 200 && x.status < 300, j);
			};
			x.onerror = function () { mlog("xhr error for " + url); cb(false, null); };
			x.send();
		} catch (e) { mlog("xhr exception for " + url + ": " + e); cb(false, null); }
	}
});
