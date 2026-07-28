/* MusicAuth — customUI validator for the music account types (com.herrie.music.*).
 *
 * The Accounts app launches this with the template being added. Behaviour branches
 * on the service id (last dotted segment of the templateId):
 *   spotify -> OAuth: fetch the token from the on-device backend (owns PKCE) and
 *              return it as the account "common" credentials.
 *   tidal   -> OAuth device-code: backend /tidalauth/start gives a code + link.tidal.com
 *              URL; the user approves on another device; we poll /tidalauth/poll.
 *   qobuz   -> email + password -> backend /qobuzauth/login (validates + stores).
 *   deezer  -> ARL cookie       -> backend /dzauth/save    (validates + stores).
 *   others  -> no credentials (youtube/soundcloud/jamendo/archive): register directly.
 * In every case we return via enyo.CrossAppResult.sendResult -> Accounts createAccount.
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
		// Tidal device-code display
		{ name: "codeInstr", showing: false, style: "padding:6px 24px;font-size:17px;text-align:center;color:#333;" },
		{ name: "codeBig", showing: false, style: "font-size:40px;font-weight:bold;text-align:center;letter-spacing:6px;padding:6px;color:#000;" },
		// Qobuz / Deezer credential form
		{ name: "emailInput", kind: "enyo.Input", showing: false, hint: "Email", type: "text",
			autocapitalize: "lowercase", spellcheck: false, style: "margin:10px 24px;padding:10px;font-size:18px;" },
		{ name: "passwordInput", kind: "enyo.Input", showing: false, hint: "Password", type: "password",
			style: "margin:10px 24px;padding:10px;font-size:18px;" },
		{ name: "arlInput", kind: "enyo.Input", showing: false, hint: "ARL cookie", type: "text",
			autocapitalize: "none", spellcheck: false, style: "margin:10px 24px;padding:10px;font-size:16px;" },
		{ name: "submitBtn", kind: "enyo.Button", showing: false, caption: "Sign In", onclick: "onSubmit", style: "margin:16px 24px;" },
		{ name: "addBtn", kind: "enyo.Button", caption: "Add Account", onclick: "onAddTap", style: "margin:16px;" },
		{ name: "web", kind: "enyo.BasicWebView", showing: false, flex: 1, mimeType: "application/x-atlas-browser", onLoadURL: "onWebLoad" }
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
		this.authMode = this.modeFor(this.serviceId);
		this.needsOAuth = (this.authMode === "spotify"); // kept for compatibility
		this.$.addBtn.setCaption("Add " + this.serviceName + " Account");
		mlog("create; mode=" + p.mode + " templateId=" + this.templateId +
			" service=" + this.serviceId + " authMode=" + this.authMode);

		switch (this.authMode) {
			case "spotify":
				// Backend usually already holds a session; try to finish immediately,
				// else fall back to the WebView login.
				this.attemptFinish(true);
				break;
			case "tidal":
				this.$.addBtn.setShowing(false);
				this.startTidalDevice();
				break;
			case "qobuz":
				this.$.addBtn.setShowing(false);
				this.showQobuzForm();
				break;
			case "deezer":
				this.$.addBtn.setShowing(false);
				this.showDeezerForm();
				break;
			default:
				// No credentials for this service — register it right away.
				this.setStatus("Adding " + this.serviceName + "…");
				this.finishNoAuth();
		}
	},

	modeFor: function (id) {
		if (id === "spotify") { return "spotify"; }
		if (id === "tidal") { return "tidal"; }
		if (id === "qobuz") { return "qobuz"; }
		if (id === "deezer") { return "deezer"; }
		return "noauth"; // youtube, soundcloud, jamendo, archive
	},

	setStatus: function (s) { this.$.status.setContent(s); mlog("status: " + s); },

	// ---- No-credential services: create the account immediately ----
	finishNoAuth: function () {
		mlog("finishNoAuth for " + this.serviceId);
		this.finishService(this.serviceName);
	},

	// Generic account creation for services whose auth (if any) already succeeded.
	finishService: function (username) {
		this.finish({
			returnValue: true,
			templateId: this.templateId,
			template: this.templateObj,
			username: username || this.serviceName,
			alias: this.serviceName,
			config: {},
			credentials: { common: { service: this.serviceId } }
		});
	},

	// ---- Tidal: OAuth device-code flow ----
	startTidalDevice: function () {
		this.$.codeInstr.setShowing(false);
		this.$.codeBig.setShowing(false);
		this.setStatus("Getting a Tidal sign-in code…");
		this.post(BACKEND + "/tidalauth/start", {}, enyo.bind(this, function (ok, j) {
			if (!ok || !j || !j.user_code) {
				this.setStatus("Couldn't start Tidal sign-in. Tap ‘Add’ to retry.");
				this.$.addBtn.setShowing(true);
				return;
			}
			var link = j.verification_url || "link.tidal.com";
			this.$.codeInstr.setContent("On your phone or computer, go to  " + link + "  and enter:");
			this.$.codeInstr.setShowing(true);
			this.$.codeBig.setContent(j.user_code);
			this.$.codeBig.setShowing(true);
			this.setStatus("Waiting for you to approve on Tidal…");
			var ms = Math.max(2, (j.interval || 5)) * 1000;
			this.startPollFn("tidalPollOnce", ms);
		}));
	},
	tidalPollOnce: function () {
		this.post(BACKEND + "/tidalauth/poll", {}, enyo.bind(this, function (ok, j) {
			if (ok && j && j.status === "ok") {
				this.stopPoll();
				this.setStatus("Tidal connected!");
				this.finishService("Tidal");
			} else if (j && j.status === "error") {
				this.stopPoll();
				this.setStatus("Tidal sign-in failed: " + (j.error || "please retry"));
				this.$.addBtn.setShowing(true);
			}
		}));
	},

	// ---- Qobuz: email + password ----
	showQobuzForm: function () {
		this.setStatus("Sign in to Qobuz");
		this.$.emailInput.setShowing(true);
		this.$.passwordInput.setShowing(true);
		this.$.submitBtn.setCaption("Sign In");
		this.$.submitBtn.setShowing(true);
	},

	// ---- Deezer: ARL cookie ----
	showDeezerForm: function () {
		this.setStatus("Paste your Deezer ARL cookie");
		this.$.arlInput.setShowing(true);
		this.$.submitBtn.setCaption("Save");
		this.$.submitBtn.setShowing(true);
	},

	onSubmit: function () {
		if (this.authMode === "qobuz") {
			var email = this.$.emailInput.getValue(), pw = this.$.passwordInput.getValue();
			if (!email || !pw) { this.setStatus("Enter your Qobuz email and password."); return true; }
			this.$.submitBtn.setDisabled(true);
			this.setStatus("Signing in to Qobuz…");
			this.post(BACKEND + "/qobuzauth/login", { email: email, password: pw }, enyo.bind(this, function (ok, j) {
				this.$.submitBtn.setDisabled(false);
				if (ok && j && j.ok) { this.setStatus("Qobuz connected!"); this.finishService(j.username || email); }
				else { this.setStatus("Qobuz sign-in failed: " + ((j && j.error) || "check your credentials")); }
			}));
		} else if (this.authMode === "deezer") {
			var arl = this.$.arlInput.getValue();
			if (!arl) { this.setStatus("Paste your Deezer ARL cookie."); return true; }
			this.$.submitBtn.setDisabled(true);
			this.setStatus("Checking your Deezer account…");
			this.post(BACKEND + "/dzauth/save", { arl: arl }, enyo.bind(this, function (ok, j) {
				this.$.submitBtn.setDisabled(false);
				if (ok && j && j.ok) { this.setStatus("Deezer connected!"); this.finishService("Deezer"); }
				else { this.setStatus("Deezer ARL invalid: " + ((j && j.error) || "please re-copy it")); }
			}));
		}
		return true;
	},

	onAddTap: function () {
		mlog("Add button tapped (mode " + this.authMode + ")");
		switch (this.authMode) {
			case "spotify": this.attemptFinish(true); break;
			case "tidal": this.$.addBtn.setShowing(false); this.startTidalDevice(); break;
			case "qobuz": case "deezer": this.onSubmit(); break;
			default: this.finishNoAuth();
		}
		return true;
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

	startLogin: function () {
		this.setStatus("Sign in to " + this.serviceName + "…");
		try {
			this.$.web.setShowing(true);
			this.$.web.setUrl("atlas-simple:" + BACKEND + "/login");
			this.$.web.render();
		} catch (e) { mlog("web render err: " + e); }
		this.startPollFn("attemptFinishPoll", 2000);
	},
	attemptFinishPoll: function () { this.attemptFinish(false); },

	// Shared single-timer poll used by Spotify and Tidal.
	startPollFn: function (method, ms) {
		if (this.pollId) { return; }
		mlog("startPoll " + method + " @" + ms + "ms");
		this.pollId = window.setInterval(enyo.bind(this, method), ms);
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

	// GET helper (JSON).
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
	},

	// POST helper (JSON body + JSON response). cb(ok, json, status).
	post: function (url, obj, cb) {
		try {
			var x = new XMLHttpRequest();
			x.open("POST", url, true);
			x.setRequestHeader("Content-Type", "application/json");
			x.onreadystatechange = function () {
				if (x.readyState !== 4) { return; }
				var j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
				cb(x.status >= 200 && x.status < 300, j, x.status);
			};
			x.onerror = function () { mlog("post error for " + url); cb(false, null, 0); };
			x.send(JSON.stringify(obj || {}));
		} catch (e) { mlog("post exception for " + url + ": " + e); cb(false, null, 0); }
	}
});
