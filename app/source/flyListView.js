/*globals enyo, $L, event, Utilities, window */

/**
 * kindFlyListView (MPR flylists — rule-based smart playlists)
 * ----------------------------------------------------------
 * Self-contained: stores flylist definitions in db8
 * (com.herrie.musicspotify.flylist:1 { name, match, rules:[{field,op,value}] })
 * and RUNS them client-side against the local media library — so rules work on
 * any field (title/artist/album/genre) without needing a db8 index per field.
 * Modes: "list" (saved flylists) -> "edit" (create) / "results" (run, tap-to-play).
 */
enyo.kind({
	name: "kindFlyListView",
	kind: "VFlexBox",
	className: "flylist-view",
	kindId: "com.herrie.musicspotify.flylist:1",
	mediaKind: "com.palm.media.audio.file:1",
	owner_: "com.herrie.musicspotify",
	events: { onSetPlaybackList: "" },

	FIELDS: ["artist", "album", "title", "genre"],
	OPS: [{ k: "contains", l: "contains" }, { k: "is", l: "is" }, { k: "isnot", l: "is not" }],

	tracks: [],
	edit: null,

	components: [
		{ kind: "Toolbar", className: "enyo-toolbar-light", components: [
			{ name: "backBtn", kind: "Button", content: $L("‹ Flylists"), showing: false, onclick: "showList" },
			{ name: "title", content: $L("Flylists"), className: "flylist-title", flex: 1 },
			{ name: "newBtn", kind: "Button", content: $L("New"), onclick: "showEdit" }
		]},
		{ name: "status", className: "flylist-status", content: "" },
		{ name: "scroller", kind: "Scroller", flex: 1, components: [
			{ name: "listBox", className: "flylist-list" },      // saved flylists
			{ name: "editBox", className: "flylist-edit", showing: false },  // create form
			{ name: "resultBox", className: "flylist-results" }   // run results
		]},
		{ name: "svcPutKind", kind: "PalmService", service: "palm://com.palm.db/", method: "putKind", onFailure: "onFail" },
		{ name: "svcDefs",    kind: "PalmService", service: "palm://com.palm.db/", method: "find", onSuccess: "onDefs", onFailure: "onFail" },
		{ name: "svcPut",     kind: "PalmService", service: "palm://com.palm.db/", method: "put",  onSuccess: "showList", onFailure: "onFail" },
		{ name: "svcDel",     kind: "PalmService", service: "palm://com.palm.db/", method: "del",  onSuccess: "loadDefs", onFailure: "onFail" },
		{ name: "svcMedia",   kind: "PalmService", service: "palm://com.palm.db/", method: "find", onSuccess: "onMedia",  onFailure: "onFail" }
	],

	create: function () {
		this.inherited(arguments);
		this.$.svcPutKind.call({ id: this.kindId, owner: this.owner_, indexes: [{ name: "byRev", props: [{ name: "_rev" }] }] });
	},
	rendered: function () { this.inherited(arguments); this.showList(); },
	onFail: function (s, r) { this.log("flylist db fail: ", r); this.$.status.setContent($L("Database error")); },

	// ---------- LIST MODE ----------
	showList: function () {
		this.$.backBtn.setShowing(false); this.$.newBtn.setShowing(true);
		this.$.title.setContent($L("Flylists"));
		this.$.editBox.setShowing(false); this.$.resultBox.setShowing(false); this.$.listBox.setShowing(true);
		this.loadDefs();
	},
	loadDefs: function () { this.$.status.setContent($L("Loading…")); this.$.svcDefs.call({ query: { from: this.kindId, orderBy: "_rev", desc: true, limit: 100 } }); },
	onDefs: function (s, r) {
		this.defs = (r && r.results) || [];
		this.$.status.setContent(this.defs.length ? "" : $L("No flylists yet — tap New to make a smart playlist."));
		this.$.listBox.destroyComponents();
		enyo.forEach(this.defs, function (d, i) {
			this.$.listBox.createComponent({
				kind: "Item", index: i, layoutKind: "HFlexLayout", align: "center", className: "flylist-row", onclick: "runDef", components: [
					{ flex: 1, components: [
						{ content: d.name || $L("(unnamed)"), className: "flylist-row-title" },
						{ content: this.rulesSummary(d), className: "flylist-row-sub" }
					]},
					{ kind: "Button", content: $L("✕"), index: i, onclick: "deleteDef", className: "flylist-del" }
				]
			}, { owner: this });
		}, this);
		this.$.listBox.render();
	},
	rulesSummary: function (d) {
		var parts = enyo.map(d.rules || [], function (r) { return r.field + " " + r.op + " " + r.value; });
		return (d.match === "any" ? $L("any: ") : $L("all: ")) + parts.join(", ");
	},
	deleteDef: function (sender, ev) {
		if (ev) { ev.stopPropagation && ev.stopPropagation(); }
		var d = this.defs[sender.index];
		if (d && d._id) { this.$.svcDel.call({ ids: [d._id] }); }
		return true;
	},

	// ---------- EDIT MODE ----------
	showEdit: function () {
		this.edit = { name: "", match: "all", rules: [{ field: "artist", op: "contains", value: "" }, { field: "album", op: "contains", value: "" }] };
		this.$.backBtn.setShowing(true); this.$.newBtn.setShowing(false);
		this.$.title.setContent($L("New Flylist"));
		this.$.status.setContent("");
		this.$.listBox.setShowing(false); this.$.resultBox.setShowing(false); this.$.editBox.setShowing(true);
		this.$.editBox.destroyComponents();
		this.$.editBox.createComponent({ kind: "Input", name: "nameIn", hint: $L("Flylist name"), className: "flylist-name-in" }, { owner: this });
		this.$.editBox.createComponent({ name: "matchBtn", kind: "Button", content: $L("Match: ALL rules"), onclick: "toggleMatch" }, { owner: this });
		enyo.forEach(this.edit.rules, function (r, i) {
			this.$.editBox.createComponent({ layoutKind: "HFlexLayout", align: "center", className: "flylist-rule", components: [
				{ kind: "Button", ruleIx: i, part: "field", content: r.field, onclick: "cycleField" },
				{ kind: "Button", ruleIx: i, part: "op",    content: r.op,    onclick: "cycleOp" },
				{ kind: "Input", ruleIx: i, hint: $L("value"), flex: 1, onchange: "ruleValue", onkeyup: "ruleValue" }
			]}, { owner: this });
		}, this);
		this.$.editBox.createComponent({ name: "saveBtn", kind: "Button", className: "enyo-button-affirmative", content: $L("Save flylist"), onclick: "saveDef" }, { owner: this });
		this.$.editBox.render();
	},
	toggleMatch: function (sender) {
		this.edit.match = this.edit.match === "all" ? "any" : "all";
		sender.setContent(this.edit.match === "all" ? $L("Match: ALL rules") : $L("Match: ANY rule"));
	},
	cycleField: function (sender) {
		var r = this.edit.rules[sender.ruleIx];
		r.field = this.FIELDS[(this.FIELDS.indexOf(r.field) + 1) % this.FIELDS.length];
		sender.setContent(r.field);
	},
	cycleOp: function (sender) {
		var r = this.edit.rules[sender.ruleIx];
		var keys = enyo.map(this.OPS, function (o) { return o.k; });
		r.op = keys[(keys.indexOf(r.op) + 1) % keys.length];
		sender.setContent(r.op);
	},
	ruleValue: function (sender) { this.edit.rules[sender.ruleIx].value = sender.getValue(); },
	saveDef: function () {
		var name = this.$.nameIn ? this.$.nameIn.getValue() : "";
		var rules = enyo.filter(this.edit.rules, function (r) { return r.value; });
		if (!name || !rules.length) { this.$.status.setContent($L("Give it a name and at least one rule with a value.")); return; }
		this.$.svcPut.call({ objects: [{ _kind: this.kindId, name: name, match: this.edit.match, rules: rules }] });
	},

	// ---------- RESULTS MODE (run a flylist) ----------
	runDef: function (sender) {
		this._run = this.defs[sender.index];
		if (!this._run) { return; }
		this.$.backBtn.setShowing(true); this.$.newBtn.setShowing(false);
		this.$.title.setContent(this._run.name);
		this.$.status.setContent($L("Matching…"));
		this.$.listBox.setShowing(false); this.$.editBox.setShowing(false); this.$.resultBox.setShowing(true);
		// pull the library, filter client-side by the rules
		this.$.svcMedia.call({ query: { from: this.mediaKind, orderBy: "_rev", desc: true, limit: 2000 } });
	},
	onMedia: function (s, r) {
		var all = (r && r.results) || [];
		var def = this._run;
		this.tracks = enyo.filter(all, enyo.bind(this, function (t) { return this._matches(t, def); }));
		this.$.status.setContent(this.tracks.length + $L(" tracks"));
		this.$.resultBox.destroyComponents();
		enyo.forEach(this.tracks, function (t, i) {
			this.$.resultBox.createComponent({
				kind: "Item", index: i, layoutKind: "VFlexLayout", className: "flylist-track", onclick: "tapTrack", components: [
					{ content: t.title || "", className: "flylist-row-title" },
					{ content: (t.artist || "") + (t.album ? " — " + t.album : ""), className: "flylist-row-sub" }
				]
			}, { owner: this });
		}, this);
		this.$.resultBox.render();
	},
	_matches: function (t, def) {
		var rules = def.rules || [];
		var any = def.match === "any";
		var ok = !any; // all -> start true; any -> start false
		for (var i = 0; i < rules.length; i++) {
			var r = rules[i], val = String(t[r.field] || "").toLowerCase(), target = String(r.value || "").toLowerCase(), m = false;
			if (r.op === "contains") { m = val.indexOf(target) >= 0; }
			else if (r.op === "is") { m = val === target; }
			else if (r.op === "isnot") { m = val !== target; }
			if (any) { ok = ok || m; } else { ok = ok && m; }
		}
		return ok;
	},
	tapTrack: function (sender) {
		var start = sender.index || 0;
		var list = enyo.map(this.tracks, function (t) {
			return { path: t.path, _id: t.path, title: t.title || "", artist: t.artist || "", album: t.album || "", duration: 0, thumbnails: [] };
		});
		list = enyo.filter(list, function (x) { return x.path; });
		if (!list.length) { return; }
		this.doSetPlaybackList({ arSetPlaybackList: list, intStartTrackIndex: start, intStartTrackTime: 0, strOriginListID: "flylist", strListQuery: JSON.stringify({ flylist: this._run && this._run.name }) });
	}
});
