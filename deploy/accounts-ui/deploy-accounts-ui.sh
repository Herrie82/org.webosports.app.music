#!/bin/sh
# push from device /media/internal (files put there by the host) into the framework
AUI=/usr/palm/frameworks/enyo/0.10/framework/lib/accounts/source
mount -o remount,rw / 2>/dev/null
for f in add-account.js accounts-list.js; do
  [ -f "$AUI/$f.orig" ] || cp "$AUI/$f" "$AUI/$f.orig"
  cp "/media/internal/$f" "$AUI/$f" && echo "deployed $f ($(wc -c < $AUI/$f) bytes)"
done
initctl stop LunaSysMgr >/dev/null 2>&1; initctl start LunaSysMgr >/dev/null 2>&1
echo ACCOUNTS_UI_DONE
