# Accounts "Add an Account" + existing-accounts UX rework

Customised copies of two enyo accounts-framework files on the device at
`/usr/palm/frameworks/enyo/0.10/framework/lib/accounts/source/`:

- **add-account.js** — the "Add an Account" list. Phases:
  - #2 grouped into category headers (Music, Email, Messaging & Chat, Cloud & Photos,
    Contacts & Calendar, Phone, Other) derived from each template's capabilityProviders.
  - #1 per-connector subtitle (e.g. "Music", "Email · Contacts · Calendar").
  - #4 live search/filter box.
- **accounts-list.js** — the existing-accounts list. Phase #3: a category subtitle
  under each account name (e.g. Spotify → "Music").

Deploy with `deploy-accounts-ui.sh`. Originals are backed up to `<file>.orig` on-device.
Revert: copy the .orig back and restart LunaSysMgr.
