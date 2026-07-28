# Accounts "Add an Account" + existing-accounts UX rework

Customised copies of two enyo accounts-**framework** files + one accounts-**app** file
(originals backed up to `<file>.orig` on-device; revert = copy .orig back + restart LunaSysMgr):

- **add-account.js** (framework `.../lib/accounts/source/`) — the "Add an Account" list:
  - Grouped into native RowGroup boxes **per category** (Email, Contacts & Calendar,
    Messaging & Chat, Cloud & Photos, Music, Phone, Other) derived from each template's
    `capabilityProviders`. Assignment keeps messaging apps in Messaging (not Contacts);
    display order is fixed as above.
  - Per-connector **capability subtitle** (e.g. "Email · Messaging · Contacts").
  - Native **RoundedSearchInput** filter box; no "Find More…" row.
- **accounts-list.js** (framework) — the existing-accounts list, `grouped:true`:
  - **Nested boxes**: an outer **SYNERGY ACCOUNTS** RowGroup containing an inner box
    per category, tightened so the inner boxes sit flush to the outer frame.
  - Rows: icon + [name / capability subtitle] top-aligned; credentials right-aligned.
  - Flat mode kept for the SIM list.
- **AccountManager.js** (app `com.palm.app.accounts/source/`) — synergy list wrapper is a
  plain Control (accounts-list draws its own SYNERGY ACCOUNTS box); `grouped:true` +
  `groupTitle`. Also guards the AppMenu-owned `deleteDataMenuItem` (fixes an Uncaught
  TypeError on launch).

Deploy: `novacom put` the three .js files to /media/internal, then run `deploy-accounts-ui.sh`.
