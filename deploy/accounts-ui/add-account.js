// Add an account.  Show the list of accounts the user is able to add, based on the account templates.
//
// CUSTOMISED (org.webosports.app.music accounts-UX plan, phases 1/2/4): the flat
// template list grew huge (~40 Synergy connectors), so:
//   #2 templates are GROUPED under category headers (Music, Email, Messaging & Chat,
//      Cloud & Photos, Contacts & Calendar, Phone, Other) from their capabilityProviders.
//   #1 each row shows a capability-derived SUBTITLE (e.g. "Music", "Email · Contacts").
//   #4 a SEARCH box filters the list live (by name / subtitle / category).
// Falls back to a flat, unfiltered list if anything goes wrong.
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

	// #1 friendly word per capability + the order they're listed (most identifying first), capped to 3.
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
		// #4 search/filter box
		{kind: "Control", className:"box-center", style:"padding:8px 10px 0 10px", components: [
			{name: "search", kind: "Input", hint: $L("Search"), onkeyup: "searchKey", style:"width:100%; height:34px; font-size:15px;"}
		]},
		{kind: "Scroller", flex: 1, components: [
			{kind:"Control", className:"box-center", style:"margin-top:12px", components: [
				{name: "list", kind: "VirtualRepeater", onSetupRow: "listGetItem", onclick: "templateSelected", className:"accounts-btn-list", components: [
					{name: "rowHeader", showing:false, style:"padding:16px 6px 4px 6px; font-size:13px; font-weight:bold; color:#7c7c7c; letter-spacing:0.04em;"},
					{kind: "Button", name: "Account", allowDrag:true, layoutKind: "HFlexLayout", align:"center", className:"accounts-btn", components: [
						{kind: "Image", name: "templateIcon", className:"icon-image"},
						{kind: "VFlexBox", flex:1, align:"start", components: [
							{name: "templateName"},
							{name: "templateSubtitle", style:"font-size:11px; color:#8a8a8a; margin-top:1px;"}
						]}
					]}
				]},
				{name: "noResults", content: $L("No matching accounts"), showing:false, style:"text-align:center; color:#999; padding:24px;"}
			]},
		]},
		{className:"accounts-footer-shadow"},
		{kind:"Toolbar", className:"enyo-toolbar-light", components:[
			{kind: "Button", label: AccountsUtil.BUTTON_CANCEL, className:"accounts-toolbar-btn", onclick: "doAddAccount_Cancel"}
		]},
		{kind: "PalmService", service: "palm://com.palm.applicationManager/", method: "open", name: "openAppCatalog"}
	],

	// Show the list of available accounts, grouped into category sections.
	showAvailableAccounts: function(templates, capability) {
		this.templates = templates;
		this.capability = capability || this.capability;
		this._filter = "";
		if (this.$.search && this.$.search.setValue) { try { this.$.search.setValue(""); } catch (e) {} }
		this.rebuild();
	},

	// #4 search
	searchKey: function(inSender, inEvent) {
		var v = (this.$.search && this.$.search.getValue) ? this.$.search.getValue() : "";
		this._filter = (v || "").toLowerCase();
		this.rebuild();
	},

	rebuild: function() {
		this.rows = this.buildRows(this.templates || []);
		var empty = true;
		for (var i = 0; i < this.rows.length; i++) { if (this.rows[i].template) { empty = false; break; } }
		if (this.$.noResults) { this.$.noResults.setShowing(empty && !!this._filter); }
		this.$.list.render();
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

	// #2 category label for a template (first matching capability in categoryOrder).
	categoryOf: function(t) {
		var caps = this.capsOf(t);
		for (var i = 0; i < this.categoryOrder.length; i++) {
			if (caps[this.categoryOrder[i].cap]) { return this.categoryOrder[i].label; }
		}
		return this.otherLabel;
	},

	// #1 subtitle for a template.
	subtitleFor: function(t) {
		var caps = this.capsOf(t), seen = {}, parts = [];
		for (var i = 0; i < this.subtitleOrder.length && parts.length < 3; i++) {
			var lbl = this.capLabels[this.subtitleOrder[i]];
			if (caps[this.subtitleOrder[i]] && lbl && !seen[lbl]) { seen[lbl] = true; parts.push(lbl); }
		}
		return parts.join(" · ");
	},

	// True if a template passes the current search filter.
	matchesFilter: function(t) {
		if (!this._filter) { return true; }
		var hay = ((t.loc_name || "") + " " + this.subtitleFor(t) + " " + this.categoryOf(t)).toLowerCase();
		return hay.indexOf(this._filter) >= 0;
	},

	// Build rows: {header} | {template, idx} | {findMore}, grouped by category, filtered by search.
	buildRows: function(templates) {
		var rows = [];
		try {
			var byCat = {};
			for (var i = 0; i < templates.length; i++) {
				if (!this.matchesFilter(templates[i])) { continue; }
				var cat = this.categoryOf(templates[i]);
				if (!byCat[cat]) { byCat[cat] = []; }
				byCat[cat].push({template: templates[i], idx: i});
			}
			var order = [], used = {};
			for (var k = 0; k < this.categoryOrder.length; k++) {
				var lbl = this.categoryOrder[k].label;
				if (byCat[lbl] && !used[lbl]) { order.push(lbl); used[lbl] = true; }
			}
			if (byCat[this.otherLabel]) { order.push(this.otherLabel); }
			for (var o = 0; o < order.length; o++) {
				rows.push({header: order[o]});
				var items = byCat[order[o]];
				for (var m = 0; m < items.length; m++) { rows.push(items[m]); }
			}
		} catch (e) {
			rows = [];
			for (var f = 0; f < templates.length; f++) { rows.push({template: templates[f], idx: f}); }
		}
		// "Find more" only on the unfiltered full list (and not for the Phone app)
		if (!this._filter && this.capability !== "PHONE") { rows.push({findMore: true}); }
		return rows;
	},

	// Render a row (header, template button, or "Find more").
	listGetItem: function(inSender, inIndex) {
		if (!this.rows || inIndex < 0 || inIndex >= this.rows.length) { return false; }
		var row = this.rows[inIndex];
		if (row.header !== undefined) {
			this.$.rowHeader.setContent(row.header);
			this.$.rowHeader.setShowing(true);
			this.$.Account.setShowing(false);
			return true;
		}
		this.$.rowHeader.setShowing(false);
		this.$.Account.setShowing(true);
		if (row.findMore) {
			this.$.templateIcon.setSrc(AccountsUtil.libPath + "images/appcatalog-32x32.png");
			this.$.templateName.setContent(AccountsUtil.TEXT_FIND_MORE);
			this.$.templateSubtitle.setContent("");
			return true;
		}
		var t = row.template;
		if (t.icon) { this.$.templateIcon.setSrc(t.icon.loc_32x32); }
		this.$.templateName.setContent(t.loc_name);
		this.$.templateSubtitle.setContent(this.subtitleFor(t));
		return true;
	},

	// User tapped a row.
	templateSelected: function(inSender, inEvent) {
		if (!inEvent || inEvent.rowIndex === undefined || !this.rows) { return; }
		var row = this.rows[inEvent.rowIndex];
		if (!row || row.header !== undefined) { return; } // headers aren't selectable
		if (row.findMore) {
			this.$.openAppCatalog.call({"id": "com.palm.app.enyo-findapps",	"params": {"common": {"sceneType": "search", "params": {
				"type": "connector",
				"connectorInfo": {
					"searchBarTitle" : AccountsUtil.getSynergyTitle(this.capability),
					"searchBarIcon" : AccountsUtil.libPath + "images/acounts-48x48.png",
					"types": (enyo.isArray(this.capability)? this.capability: [this.capability])
				}}}}});
			return;
		}
		this.doAddAccount_AccountSelected(row.template);
	},
});
