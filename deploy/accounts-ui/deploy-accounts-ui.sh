#!/bin/sh
# Deploy the Accounts UX rework. Host first `novacom put`s the three files to
# /media/internal, then runs this on-device. Originals are backed up to <file>.orig.
FW=/usr/palm/frameworks/enyo/0.10/framework/lib/accounts/source
APP=/usr/palm/applications/com.palm.app.accounts/source
mount -o remount,rw / 2>/dev/null
[ -f "$FW/add-account.js.orig" ]    || cp "$FW/add-account.js"    "$FW/add-account.js.orig"
[ -f "$FW/accounts-list.js.orig" ]  || cp "$FW/accounts-list.js"  "$FW/accounts-list.js.orig"
[ -f "$APP/AccountManager.js.orig" ]|| cp "$APP/AccountManager.js" "$APP/AccountManager.js.orig"
cp /media/internal/add-account.js    "$FW/add-account.js"    && echo "add-account.js    -> framework"
cp /media/internal/accounts-list.js  "$FW/accounts-list.js"  && echo "accounts-list.js  -> framework"
cp /media/internal/AccountManager.js "$APP/AccountManager.js" && echo "AccountManager.js -> app"
initctl stop LunaSysMgr >/dev/null 2>&1; initctl start LunaSysMgr >/dev/null 2>&1
echo ACCOUNTS_UI_DEPLOYED
