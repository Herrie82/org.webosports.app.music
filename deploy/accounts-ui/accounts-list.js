// Show the list of accounts. Accounts with hidden templates / no validator are excluded.
// A watch keeps the list in sync as accounts are added/removed.
//
// CUSTOMISED (org.webosports.app.music accounts UX): with grouped:true the accounts are
// split into native RowGroups PER CATEGORY (Email/Contacts/Messaging/Cloud/Music/…) like
// the Add-Account list. Rows: icon + [name / category] left & TOP-aligned (not vertically
// centered), credentials RIGHT-aligned (matching the left whitespace), error triangle last.

// One category group of accounts (composed RowGroup + VirtualRepeater), reused per category.
enyo.kind({
	name: "Accounts.accountGroup",
	kind: "enyo.Control",
	style: "margin-top:15px;",
	published: { accounts: [], caption: "", ownerList: null },
	events: { onAccountRow_Selected: "" },
	components: [
		{name: "grp", kind: "RowGroup", className: "accounts-group", components: [
			{name: "list", kind: "VirtualRepeater", className: "accounts-rowgroup-item", onSetupRow: "setupRow", onclick: "rowTapped", components: [
				{kind: "Item", name: "Account", layoutKind: "HFlexLayout", align: "start", tapHighlight: true, className: "accounts-list-item enyo-text-ellipsis", style: "padding-top:6px; padding-bottom:6px;", components: [
					{kind: "Image", name: "accountIcon", className: "icon-image"},
					{kind: "VFlexBox", align: "start", components: [
						{name: "accountName"},
						{name: "accountCategory", style: "font-size:11px; color:#8a8a8a; margin-top:1px;"}
					]},
					{kind: "Control", flex: 1},
					{name: "emailAddress", className: "email-address enyo-text-ellipsis", style: "text-align:right;"},
					{kind: "Image", name: "errorIcon", src: AccountsUtil.libPath + "images/header-warning-icon.png", className: "warning-icon"}
				]}
			]}
		]}
	],
	create: function() { this.inherited(arguments); this.captionChanged(); },
	captionChanged: function() { try { if (this.$.grp && this.$.grp.setCaption) { this.$.grp.setCaption(this.caption); } } catch (e) {} },
	setAccounts: function(v) { this.accounts = v || []; this.$.list.setStripSize(this.accounts.length); this.$.list.render(); },
	setupRow: function(inSender, inIndex) {
		if (!this.accounts || inIndex >= this.accounts.length) { return false; }
		if (this.ownerList) { this.ownerList.fillRow(this.$, this.accounts[inIndex]); }
		return true;
	},
	rowTapped: function(inSender, inEvent) {
		var a = this.accounts[inEvent.rowIndex];
		if (a) { this.doAccountRow_Selected({account: a}); }
	}
});

enyo.kind({
	name: "Accounts.accountsList",
	kind: enyo.Control,
	published: { grouped: false, groupTitle: "" },
	events: {
		onAccountsList_AccountSelected: "",
		onAccountsList_AddAccountTemplates: "",
		onAccountsList_Ready: ""
	},
	components: [
		{name: "accounts", kind: "Accounts.getAccounts", onGetAccounts_AccountsAvailable: "onAccountsAvailable"},
		{name: "groups"},		// grouped rendering (per-category RowGroups)
		{name: "list", kind: "VirtualRepeater", onSetupRow: "listGetItem", onclick: "accountSelected", className:"accounts-rowgroup-item", components: [
			{kind: "Item", name: "Account", layoutKind: "HFlexLayout", align:"start", tapHighlight:true, className:"accounts-list-item enyo-text-ellipsis", style: "padding-top:6px; padding-bottom:6px;", components: [
				{kind: "Image", name: "accountIcon", className: "icon-image"},
				{kind: "VFlexBox", align: "start", components: [
					{name: "accountName"},
					{name: "accountCategory", style: "font-size:11px; color:#8a8a8a; margin-top:1px;"}
				]},
				{kind: "Control", flex: 1},
				{name: "emailAddress", className: "email-address enyo-text-ellipsis", style: "text-align:right;"},
				{kind: "Image", name: "errorIcon", src: AccountsUtil.libPath + "images/header-warning-icon.png", className: "warning-icon"}
			]}
		]},
		{name: "getSyncStatus", kind: "TempDbService", dbKind: "com.palm.account.syncstate:1", subscribe: true, method: "find", onResponse: "receivedSyncStatus", reCallWatches: true}
	],

	// --- category derivation (shared with the Add-Account grouping) ---
	categoryOrder: [
		{cap: "Music", label: $L("MUSIC")}, {cap: "MAIL", label: $L("EMAIL")},
		{cap: "MESSAGING", label: $L("MESSAGING & CHAT")}, {cap: "IM", label: $L("MESSAGING & CHAT")},
		{cap: "DOCUMENTS", label: $L("CLOUD & PHOTOS")}, {cap: "PHOTO.UPLOAD", label: $L("CLOUD & PHOTOS")}, {cap: "VIDEO.UPLOAD", label: $L("CLOUD & PHOTOS")},
		{cap: "CALENDAR", label: $L("CONTACTS & CALENDAR")}, {cap: "CONTACTS", label: $L("CONTACTS & CALENDAR")}, {cap: "REMOTECONTACTS", label: $L("CONTACTS & CALENDAR")},
		{cap: "TASKS", label: $L("CONTACTS & CALENDAR")}, {cap: "MEMOS", label: $L("CONTACTS & CALENDAR")},
		{cap: "PHONE", label: $L("PHONE")}, {cap: "SMS", label: $L("PHONE")}
	],
	displayOrder: [$L("EMAIL"), $L("CONTACTS & CALENDAR"), $L("MESSAGING & CHAT"), $L("CLOUD & PHOTOS"), $L("MUSIC"), $L("PHONE")],
	otherLabel: $L("OTHER"),
	// Per-row subtitle: list up to 3 of the connector's capabilities (like Add-Account).
	capLabels: {
		"Music": $L("Music"), "MAIL": $L("Email"), "MESSAGING": $L("Messaging"), "IM": $L("Messaging"),
		"CONTACTS": $L("Contacts"), "REMOTECONTACTS": $L("Contacts"), "CALENDAR": $L("Calendar"),
		"TASKS": $L("Tasks"), "MEMOS": $L("Notes"), "DOCUMENTS": $L("Files"),
		"PHOTO.UPLOAD": $L("Photos"), "VIDEO.UPLOAD": $L("Videos"), "PHONE": $L("Calls"), "SMS": $L("SMS")
	},
	subtitleOrder: ["Music","MAIL","MESSAGING","IM","CONTACTS","REMOTECONTACTS","CALENDAR","DOCUMENTS","PHOTO.UPLOAD","VIDEO.UPLOAD","TASKS","MEMOS","PHONE","SMS"],

	getAccountsList: function (capability, exclude, dontDisplayErrors) {
		this.dontDisplayErrors = dontDisplayErrors;
		if (capability && !enyo.isArray(capability) && capability.indexOf("com.") === 0)
			this.$.accounts.getAccounts({templateId: capability}, exclude);
		else
			this.$.accounts.getAccounts({capability: capability}, exclude);
	},

	onAccountsAvailable: function(inSender, inResponse) {
		this.accounts = inResponse.accounts;
		this._buildCapsMap(inResponse.templates);
		if (this.grouped) {
			this.$.list.hide();
			this.renderGrouped();
		} else {
			this.$.groups.hide();
			this.$.list.setStripSize(this.accounts.length);
			this.$.list.render();
		}
		this.doAccountsList_AddAccountTemplates(inResponse.templates);
		if (!this.accountStatus && !this.dontDisplayErrors) {
			this.accountStatus = {};
			this.$.getSyncStatus.call();
		}
	},

	// --- grouped rendering ---
	renderGrouped: function() {
		var kids = this.$.groups.children.slice(0);
		for (var d = 0; d < kids.length; d++) { kids[d].destroy(); }
		if (this.groupTitle) {		// overall section heading (e.g. "SYNERGY ACCOUNTS")
			this.$.groups.createComponent({content: this.groupTitle, className: "box-center",
				style: "margin-top:16px; padding:0 3px 2px 3px; font-size:12px; font-weight:bold; color:#7c7c7c; letter-spacing:0.05em;"}, {owner: this});
		}
		var byCat = {};
		for (var i = 0; i < this.accounts.length; i++) {
			var cat = this._categoryCaption(this.accounts[i]);
			if (!byCat[cat]) { byCat[cat] = []; }
			byCat[cat].push(this.accounts[i]);
		}
		var order = [];
		for (var k = 0; k < this.displayOrder.length; k++) { if (byCat[this.displayOrder[k]]) { order.push(this.displayOrder[k]); } }
		if (byCat[this.otherLabel]) { order.push(this.otherLabel); }
		for (var o = 0; o < order.length; o++) {
			var g = this.$.groups.createComponent(
				{kind: "Accounts.accountGroup", caption: order[o], ownerList: this, onAccountRow_Selected: "onGroupAccountSelected"}, {owner: this});
			g.setAccounts(byCat[order[o]]);
		}
		this.$.groups.render();
	},
	onGroupAccountSelected: function(inSender, inEvent) {
		var account = inEvent.account;
		account.credentialError = this.accountStatus && this.accountStatus[account._id] && this.accountStatus[account._id].currentError;
		this.doAccountsList_AccountSelected({account: account});
	},

	// Fill a rendered row's controls ($ hash) from an account (shared by flat + grouped).
	fillRow: function($, a) {
		if (a.icon && a.icon.loc_32x32) { $.accountIcon.setSrc(a.icon.loc_32x32); }
		$.accountName.setContent(a.alias || a.loc_name);
		$.accountCategory.setContent(this.subtitleFor(a));
		$.emailAddress.setContent(a.username);
		if (this.accountStatus && this.accountStatus[a._id] && this.accountStatus[a._id].currentError) { $.errorIcon.show(); }
		else { $.errorIcon.hide(); }
	},

	// --- flat rendering (SIM etc.) ---
	listGetItem: function(inSender, inIndex) {
		if (!this.accounts || inIndex >= this.accounts.length) { return false; }
		if (this.accounts.length == 1) { this.$.Account.addClass("enyo-single"); }
		else if (inIndex == 0) { this.$.Account.addClass("enyo-first"); }
		else if (inIndex == this.accounts.length - 1) { this.$.Account.addClass("enyo-last"); this.$.Account.removeClass("enyo-first enyo-middle"); }
		else { this.$.Account.addClass("enyo-item enyo-middle"); this.$.Account.removeClass("enyo-first enyo-last"); }
		this.fillRow(this.$, this.accounts[inIndex]);
		return true;
	},
	accountSelected: function(inSender, inEvent) {
		var account = this.accounts[inEvent.rowIndex];
		account.credentialError = this.accountStatus && this.accountStatus[account._id] && this.accountStatus[account._id].currentError;
		this.doAccountsList_AccountSelected({account: account});
	},

	// --- category helpers ---
	_buildCapsMap: function(templates) {
		this._capsByTemplate = {};
		if (!enyo.isArray(templates)) { return; }
		for (var i = 0; i < templates.length; i++) { var t = templates[i]; if (t && t.templateId) { this._capsByTemplate[t.templateId] = this._capsOf(t); } }
	},
	_capsOf: function(t) {
		var set = {};
		try {
			var cp = t && t.capabilityProviders;
			if (enyo.isArray(cp)) { for (var i = 0; i < cp.length; i++) { var c = cp[i] && (cp[i].capability || cp[i].id); if (c) { set[c] = true; } } }
			if (enyo.isArray(t && t.capabilities)) { for (var j = 0; j < t.capabilities.length; j++) { set[t.capabilities[j]] = true; } }
		} catch (e) {}
		return set;
	},
	_capsForAccount: function(a) {
		return (a && a.capabilityProviders) ? this._capsOf(a) : ((this._capsByTemplate && a && this._capsByTemplate[a.templateId]) || {});
	},
	_categoryCaption: function(a) {
		var caps = this._capsForAccount(a);
		for (var i = 0; i < this.categoryOrder.length; i++) { if (caps[this.categoryOrder[i].cap]) { return this.categoryOrder[i].label; } }
		return this.otherLabel;
	},
	subtitleFor: function(a) {
		var caps = this._capsForAccount(a), seen = {}, parts = [];
		for (var i = 0; i < this.subtitleOrder.length && parts.length < 3; i++) {
			var lbl = this.capLabels[this.subtitleOrder[i]];
			if (caps[this.subtitleOrder[i]] && lbl && !seen[lbl]) { seen[lbl] = true; parts.push(lbl); }
		}
		return parts.join(" · ");
	},

	receivedSyncStatus: function(inSender, inResponse, inRequest) {
		if (!inResponse || !inResponse.returnValue) { return; }
		var needsRedraw = false;
		for (var i = 0, l = inResponse.results.length; i < l; i++) {
			var syncSource = inResponse.results[i];
			var account = AccountsUtil.getAccount(this.accounts, syncSource.accountId);
			if (!account) { if (this.accountStatus[syncSource.accountId]) { delete this.accountStatus[syncSource.accountId]; } continue; }
			var error = (syncSource.syncState === "ERROR" && (syncSource.errorCode === "401_UNAUTHORIZED" || syncSource.errorCode === "CREDENTIALS_NOT_FOUND"));
			if (!this.accountStatus[syncSource.accountId]) { this.accountStatus[syncSource.accountId] = {error: error}; if (error) { needsRedraw = true; } continue; }
			if (!this.accountStatus[syncSource.accountId].error) { this.accountStatus[syncSource.accountId].error = error; }
		}
		for (var accountId in this.accountStatus) {
			if (this.accountStatus[accountId].error != !!this.accountStatus[accountId].currentError) { needsRedraw = true; }
			this.accountStatus[accountId].currentError = this.accountStatus[accountId].error;
			this.accountStatus[accountId].error = false;
		}
		if (needsRedraw) { if (this.grouped) { this.renderGrouped(); } else { this.$.list.render(); } }
		this.doAccountsList_Ready();
	}
});
