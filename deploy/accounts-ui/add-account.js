// Add an account.  Show the list of accounts the user is able to add, based on the account templates.
//
// CUSTOMISED (org.webosports.app.music accounts-UX plan, phases 1/2/4): the flat
// template list grew huge (~40 Synergy connectors). Rendered 1:1 like the
// "SYNERGY ACCOUNTS" list (accounts-list.js): one RowGroup PER CATEGORY, each a
// VirtualRepeater.accounts-rowgroup-item of native accounts-list-item rows.
//   #2 grouped by category; #1 per-connector capability subtitle; #4 live search box.
//
// Kind:
// {kind: "Accounts.addAccountView", name: "addAccount", onAddAccount_AccountSelected: "editAccount", onAddAccount_Cancel: "addCancel"}
// this.$.addAccount.showAvailableAccounts(templates, capability);

// One category group — a RowGroup whose rows use the SAME structure/classes as
// accounts-list.js so styling (row height, dividers, rounding) matches exactly.
enyo.kind({
	name: "Accounts.addAccountGroup",
	kind: "enyo.Control",
	style: "margin-top:15px;",
	published: { items: [], ownerView: null, caption: "" },
	events: { onGroupItem_Selected: "" },
	components: [
		{name: "grp", kind: "RowGroup", className: "accounts-group", components: [
			{name: "list", kind: "VirtualRepeater", className: "accounts-rowgroup-item", onSetupRow: "setupRow", onclick: "rowTapped", components: [
				{kind: "Item", name: "Account", layoutKind: "HFlexLayout", align: "center", tapHighlight: true, className: "accounts-list-item enyo-text-ellipsis", style: "padding-top:5px; padding-bottom:5px;", components: [
					{kind: "Image", name: "icon", className: "icon-image"},
					{kind: "HFlexBox", style: "width:420px", align: "center", components: [
						{kind: "VFlexBox", align: "start", components: [
							{name: "nm"},
							{name: "sub", style: "font-size:11px; color:#8a8a8a; line-height:13px;"}
						]}
					]}
				]}
			]}
		]}
	],
	create: function() { this.inherited(arguments); this.captionChanged(); },
	captionChanged: function() { try { if (this.$.grp && this.$.grp.setCaption) { this.$.grp.setCaption(this.caption); } } catch (e) {} },
	setItems: function(v) {
		this.items = v || [];
		this.$.list.setStripSize(this.items.length);
		this.$.list.render();
	},
	setupRow: function(inSender, inIndex) {
		if (!this.items || inIndex >= this.items.length) { return false; }
		var t = this.items[inIndex].template;
		if (t.icon && t.icon.loc_32x32) { this.$.icon.setSrc(t.icon.loc_32x32); }
		this.$.nm.setContent(t.loc_name || "");
		this.$.sub.setContent(this.ownerView ? this.ownerView.subtitleFor(t) : "");
		return true;
	},
	rowTapped: function(inSender, inEvent) {
		var it = this.items[inEvent.rowIndex];
		if (it) { this.doGroupItem_Selected({template: it.template}); }
	}
});

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

	// ASSIGNMENT priority — a template lands in the FIRST category whose capability it
	// provides (messaging before contacts so WhatsApp/Telegram land in Messaging).
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
	// DISPLAY order of the groups (user-requested): Email, Contacts, Messaging, Cloud, Music, Phone, Other.
	displayOrder: [$L("EMAIL"), $L("CONTACTS & CALENDAR"), $L("MESSAGING & CHAT"), $L("CLOUD & PHOTOS"), $L("MUSIC"), $L("PHONE")],
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
				{kind: "Control", style:"padding:6px 0 8px 0;", components: [		// #4 search box (centered to group width)
					{name: "search", kind: "Input", hint: $L("Search accounts"), onkeyup: "searchKey",
						style:"width:100%; -webkit-box-sizing:border-box; box-sizing:border-box; height:38px; padding:0 12px; border:1px solid #b6b6b6; border-radius:9px; background:#fff; font-size:15px;"}
				]},
				{name: "groups"},
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

	searchKey: function() {
		var v = (this.$.search && this.$.search.getValue) ? this.$.search.getValue() : "";
		this._filter = (v || "").toLowerCase();
		this.rebuild();
	},

	capsOf: function(t) {
		var set = {};
		try {
			var cp = t && t.capabilityProviders;
			if (enyo.isArray(cp)) { for (var i = 0; i < cp.length; i++) { var c = cp[i] && (cp[i].capability || cp[i].id); if (c) { set[c] = true; } } }
			if (enyo.isArray(t && t.capabilities)) { for (var j = 0; j < t.capabilities.length; j++) { set[t.capabilities[j]] = true; } }
		} catch (e) {}
		return set;
	},
	categoryOf: function(t) {
		var caps = this.capsOf(t);
		for (var i = 0; i < this.categoryOrder.length; i++) { if (caps[this.categoryOrder[i].cap]) { return this.categoryOrder[i].label; } }
		return this.otherLabel;
	},
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

	// [{label, items:[{template}]}] in DISPLAY order, Other last.
	groupTemplates: function() {
		var byCat = {}, ts = this.templates || [];
		for (var i = 0; i < ts.length; i++) {
			if (!this.matchesFilter(ts[i])) { continue; }
			var cat = this.categoryOf(ts[i]);
			if (!byCat[cat]) { byCat[cat] = []; }
			byCat[cat].push({template: ts[i]});
		}
		var out = [];
		for (var k = 0; k < this.displayOrder.length; k++) {
			var lbl = this.displayOrder[k];
			if (byCat[lbl]) { out.push({label: lbl, items: byCat[lbl]}); delete byCat[lbl]; }
		}
		if (byCat[this.otherLabel]) { out.push({label: this.otherLabel, items: byCat[this.otherLabel]}); }
		return out;
	},

	rebuild: function() {
		var kids = this.$.groups.children.slice(0);
		for (var d = 0; d < kids.length; d++) { kids[d].destroy(); }

		var any = false;
		try {
			var cats = this.groupTemplates();
			for (var c = 0; c < cats.length; c++) {
				if (!cats[c].items.length) { continue; }
				any = true;
				var g = this.$.groups.createComponent(
					{kind: "Accounts.addAccountGroup", caption: cats[c].label, ownerView: this, onGroupItem_Selected: "groupItemSelected"},
					{owner: this});
				g.setItems(cats[c].items);
			}
		} catch (e) {
			var fg = this.$.groups.createComponent({kind: "Accounts.addAccountGroup", ownerView: this, onGroupItem_Selected: "groupItemSelected"}, {owner: this});
			var all = [];
			for (var f = 0; f < (this.templates || []).length; f++) { all.push({template: this.templates[f]}); }
			fg.setItems(all); any = all.length > 0;
		}

		// "Find more" as its own single-row group (not for the Phone app / not while filtering)
		if (!this._filter && this.capability !== "PHONE") {
			var fmg = this.$.groups.createComponent({kind: "RowGroup", className: "accounts-group"}, {owner: this});
			fmg.createComponent({kind: "Control", className: "accounts-rowgroup-item", components: [
				{kind: "Item", findMore: true, layoutKind: "HFlexLayout", align: "center", tapHighlight: true,
					className: "accounts-list-item enyo-text-ellipsis enyo-single", onclick: "findMoreTapped", components: [
						{kind: "Image", className: "icon-image", src: AccountsUtil.libPath + "images/appcatalog-32x32.png"},
						{content: AccountsUtil.TEXT_FIND_MORE}
					]}
			]}, {owner: this});
		}

		if (this.$.noResults) { this.$.noResults.setShowing(!any && !!this._filter); }
		this.$.groups.render();
	},

	groupItemSelected: function(inSender, inEvent) {
		if (inEvent && inEvent.template) { this.doAddAccount_AccountSelected(inEvent.template); }
	},

	findMoreTapped: function() {
		this.$.openAppCatalog.call({"id": "com.palm.app.enyo-findapps",	"params": {"common": {"sceneType": "search", "params": {
			"type": "connector",
			"connectorInfo": {
				"searchBarTitle" : AccountsUtil.getSynergyTitle(this.capability),
				"searchBarIcon" : AccountsUtil.libPath + "images/acounts-48x48.png",
				"types": (enyo.isArray(this.capability)? this.capability: [this.capability])
			}}}}});
	}
});
