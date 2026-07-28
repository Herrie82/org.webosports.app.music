#!/bin/sh
AUI=/usr/palm/frameworks/enyo/0.10/framework/lib/accounts/source
APP=/usr/palm/applications/com.palm.app.accounts/source
mount -o remount,rw / 2>/dev/null
[ -f "$APP/AccountManager.js.orig" ] || cp "$APP/AccountManager.js" "$APP/AccountManager.js.orig"
cp /media/internal/accounts-list.js "$AUI/accounts-list.js" && echo "accounts-list.js $(wc -c < $AUI/accounts-list.js)b"
cp /media/internal/AccountManager.js "$APP/AccountManager.js" && echo "AccountManager.js $(wc -c < $APP/AccountManager.js)b"
initctl stop LunaSysMgr >/dev/null 2>&1; initctl start LunaSysMgr >/dev/null 2>&1
echo GROUPED_DONE
