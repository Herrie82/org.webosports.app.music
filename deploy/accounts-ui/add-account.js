// Add an account.  Show the list of accounts the user is able to add, based on the account templates.
//
// CUSTOMISED (org.webosports.app.music accounts-UX plan, phases 1/2/4): the flat
// template list grew huge (~40 Synergy connectors). Rendered exactly like the
// "SYNERGY ACCOUNTS" list on the main screen — one native RowGroup PER CATEGORY
// (caption = category), rows are native Items (icon + name + capability subtitle):
//   #2 grouped by category (Music, Email, Messaging & Chat, Cloud & Photos,
//      Contacts & Calendar, Phone, Other) from each template's capabilityProviders.
//   #1 per-connector subtitle (e.g. "Music", "Email · Contacts · Calendar").
//   #4 a search box filters the list live (by name / subtitle / category).
// Falls back to a single "OTHER" group if anything goes wrong.
//
// Kind:
// {kind: "Accounts.addAccountView", name: "addAccount", onAddAccount_AccountSelected: "editAccount", onAddAccount_Cancel: "addCancel"}
// this.$.addAccount.showAvailableAccounts(templates, capability);

enyo.kind({
	name: "Accounts.addAccountView",
	kind: "enyo.VFlexBox",
	className:"enyo-bg",
	published: {
		capability:["CALENDAR","CONTACTS","DOCUMENTS","MAIL","MEMOS","MESSAGING","PHONE","PHOTO.UPLOAD","REMOTECONTACTS","TASKS","VIDEO.UPLOAD","IM","SMS"],
	},
	events: {
		onAddAccount_AccountSelected: "",
		onAddAccount_Cancel: ""
	},

	// #2 ordered categories: a template lands in the FIRST category whose capability it provides.
	categoryOrder: [
		{cap: "Music",         label: $L("MUSIC")},
		{cap: "MAIL",          label: $L("EMAIL")},
		{cap: "MESSAGING",     label: $L("MESSAGING & CHAT")},
		{cap: "IM",            label: $L("MESSAGING & CHAT")},
		{cap: "DOCUMENTS",     label: $L("CLOUD & PHOTOS")},
		{cap: "PHOTO.UPLOAD",  label: $L("CLOUD & PHOTOS")},
		{cap: "VIDEO.UPLOAD",  label: $L("CLOUD & PHOTOS")},
		{cap: "CALENDAR",      label: $L("CONTACTS & CALENDAR")},
		{cap: "CONTACTS",      label: $L("CONTACTS & CALENDAR")},
		{cap: "REMOTECONTACTS",label: $L("CONTACTS & CALENDAR")},
		{cap: "TASKS",         label: $L("CONTACTS & CALENDAR")},
		{cap: "MEMOS",         label: $L("CONTACTS & CALENDAR")},
		{cap: "PHONE",         label: $L("PHONE")},
		{cap: "SMS",           label: $L("PHONE")}
	],
	otherLabel: $L("OTHER"),

	// #1 friendly word per capability + the order listed (most identifying first), capped to 3.
	capLabels: {
		"Music": $L("Music"), "MAIL": $L("Email"), "MESSAGING": $L("Messaging"), "IM": $L("Messaging"),
		"CONTACTS": $L("Contacts"), "REMOTECONTACTS": $L("Contacts"), "CALENDAR": $L("Calendar"),
		"TASKS": $L("Tasks"), "MEMOS": $L("Notes"), "DOCUMENTS": $L("Files"),
		"PHOTO.UPLOAD": $L("Photos"), "VIDEO.UPLOAD": $L("Videos"), "PHONE": $L("Calls"), "SMS": $L("SMS")
	},
	subtitleOrder: ["Music","MAIL","MESSAGING","IM","CONTACTS","REMOTECONTACTS","CALENDAR","DOCUMENTS","PHOTO.UPLOAD","VIDEO.UPLOAD","TASKS","MEMOS","PHONE","SMS"],

	_filter: "",

	components: [
		{kind:"Toolbar", className:"enyo-toolbar-light accounts-header", pack:"center", components: [
				{kind: "Image", src: AccountsUtil.libPath + "images/acounts-48x48.png"},
				{kind: "Control", content: AccountsUtil.PAGE_TITLE_ADD_ACCOUNT}
		]},
		{className:"accounts-header-shadow"},
		{kind: "Scroller", flex: 1, components: [
			{kind:"Control", className:"box-center", components: [
				// #4 search box — same centered width as the groups
				{kind: "Control", style:"padding:14px 2px 6px 2px;", components: [
					{name: "search", kind: "Input", hint: $L("Search accounts"), onkeyup: "searchKey",
						style:"width:100%; -webkit-box-sizing:border-box; box-sizing:border-box; height:38px; padding:0 12px; border:1px solid #b6b6b6; border-radius:9px; background:#fff; font-size:15px;"}
				]},
				{name: "groups"},		// native RowGroups built here
				{name: "noResults", content: $L("No matching accounts"), showing:false, style:"text-align:center; color:#999; padding:24px;"}
			]},
		]},
		{className:"accounts-footer-shadow"},
		{kind:"Toolbar", className:"enyo-toolbar-light", components:[
			{kind: "Button", label: AccountsUtil.BUTTON_CANCEL, className:"accounts-toolbar-btn", onclick: "doAddAccount_Cancel"}
		]},
		{kind: "PalmService", service: "palm://com.palm.applicationManager/", method: "open", name: "openAppCatalog"}
	],

	showAvailableAccounts: function(templates, capability) {
		this.templates = templates;
		this.capability = capability || this.capability;
		this._filter = "";
		try { if (this.$.search && this.$.search.setValue) { this.$.search.setValue(""); } } catch (e) {}
		this.rebuild();
	},

	// #4 search
	searchKey: function() {
		var v = (this.$.search && this.$.search.getValue) ? this.$.search.getValue() : "";
		this._filter = (v || "").toLowerCase();
		this.rebuild();
	},

	// Collect the capability ids a template provides.
	capsOf: function(t) {
		var set = {};
		try {
			var cp = t && t.capabilityProviders;
			if (enyo.isArray(cp)) {
				for (var i = 0; i < cp.length; i++) {
					var c = cp[i] && (cp[i].capability || cp[i].id);
					if (c) { set[c] = true; }
				}
			}
			if (enyo.isArray(t && t.capabilities)) {
				for (var j = 0; j < t.capabilities.length; j++) { set[t.capabilities[j]] = true; }
			}
		} catch (e) {}
		return set;
	},

	// #2 category label (first matching capability).
	categoryOf: function(t) {
		var caps = this.capsOf(t);
		for (var i = 0; i < this.categoryOrder.length; i++) {
			if (caps[this.categoryOrder[i].cap]) { return this.categoryOrder[i].label; }
		}
		return this.otherLabel;
	},

	// #1 subtitle.
	subtitleFor: function(t) {
		var caps = this.capsOf(t), seen = {}, parts = [];
		for (var i = 0; i < this.subtitleOrder.length && parts.length < 3; i++) {
			var lbl = this.capLabels[this.subtitleOrder[i]];
			if (caps[this.subtitleOrder[i]] && lbl && !seen[lbl]) { seen[lbl] = true; parts.push(lbl); }
		}
		return parts.join(" · ");
	},

	matchesFilter: function(t) {
		if (!this._filter) { return true; }
		var hay = ((t.loc_name || "") + " " + this.subtitleFor(t) + " " + this.categoryOf(t)).toLowerCase();
		return hay.indexOf(this._filter) >= 0;
	},

	// Group filtered templates -> [{label, items:[{template,idx}]}] in categoryOrder, Other last.
	groupTemplates: function() {
		var byCat = {}, ts = this.templates || [];
		for (var i = 0; i < ts.length; i++) {
			if (!this.matchesFilter(ts[i])) { continue; }
			var cat = this.categoryOf(ts[i]);
			if (!byCat[cat]) { byCat[cat] = []; }
			byCat[cat].push({template: ts[i], idx: i});
		}
		var out = [], used = {};
		for (var k = 0; k < this.categoryOrder.length; k++) {
			var lbl = this.categoryOrder[k].label;
			if (byCat[lbl] && !used[lbl]) { out.push({label: lbl, items: byCat[lbl]}); used[lbl] = true; }
		}
		if (byCat[this.otherLabel]) { out.push({label: this.otherLabel, items: byCat[this.otherLabel]}); }
		return out;
	},

	// Build native RowGroups (one per category) of native Items.
	rebuild: function() {
		// tear down existing groups
		var kids = this.$.groups.children.slice(0);
		for (var d = 0; d < kids.length; d++) { kids[d].destroy(); }

		var any = false;
		try {
			var cats = this.groupTemplates();
			for (var c = 0; c < cats.length; c++) {
				var items = cats[c].items;
				if (!items.length) { continue; }
				any = true;
				var group = this.$.groups.createComponent(
					{kind: "RowGroup", className: "accounts-group", caption: cats[c].label}, {owner: this});
				for (var k = 0; k < items.length; k++) {
					this._makeItem(group, items[k].template, this._rowClass(k, items.length));
				}
			}
		} catch (e) {
			// defensive: one flat group
			var g = this.$.groups.createComponent({kind: "RowGroup", className: "accounts-group"}, {owner: this});
			var all = this.templates || [];
			for (var f = 0; f < all.length; f++) { this._makeItem(g, all[f], this._rowClass(f, all.length)); any = true; }
		}

		// "Find more" (only on the unfiltered full list, not the Phone app)
		if (!this._filter && this.capability !== "PHONE") {
			var fmg = this.$.groups.createComponent({kind: "RowGroup", className: "accounts-group"}, {owner: this});
			fmg.createComponent({kind: "Item", findMore: true, layoutKind: "HFlexLayout", align: "center", tapHighlight: true,
				className: "accounts-list-item enyo-text-ellipsis enyo-single", onclick: "itemTapped", components: [
					{kind: "Image", className: "icon-image", src: AccountsUtil.libPath + "images/appcatalog-32x32.png"},
					{content: AccountsUtil.TEXT_FIND_MORE}
				]}, {owner: this});
		}

		if (this.$.noResults) { this.$.noResults.setShowing(!any && !!this._filter); }
		this.$.groups.render();
	},

	_rowClass: function(i, n) {
		var base = "accounts-list-item enyo-text-ellipsis ";
		if (n === 1) { return base + "enyo-single"; }
		if (i === 0) { return base + "enyo-first"; }
		if (i === n - 1) { return base + "enyo-last"; }
		return base + "enyo-middle";
	},

	_makeItem: function(group, t, cls) {
		group.createComponent({kind: "Item", template: t, layoutKind: "HFlexLayout", align: "center", tapHighlight: true,
			className: cls, onclick: "itemTapped", components: [
				{kind: "Image", className: "icon-image", src: (t.icon && t.icon.loc_32x32) || ""},
				{kind: "VFlexBox", flex: 1, align: "start", components: [
					{content: t.loc_name || ""},
					{content: this.subtitleFor(t), style:"font-size:11px; color:#8a8a8a; margin-top:1px;"}
				]}
			]}, {owner: this});
	},

	itemTapped: function(inSender) {
		if (inSender.findMore) {
			this.$.openAppCatalog.call({"id": "com.palm.app.enyo-findapps",	"params": {"common": {"sceneType": "search", "params": {
				"type": "connector",
				"connectorInfo": {
					"searchBarTitle" : AccountsUtil.getSynergyTitle(this.capability),
					"searchBarIcon" : AccountsUtil.libPath + "images/acounts-48x48.png",
					"types": (enyo.isArray(this.capability)? this.capability: [this.capability])
				}}}}});
			return;
		}
		if (inSender.template) { this.doAddAccount_AccountSelected(inSender.template); }
	},
});
