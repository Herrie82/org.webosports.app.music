#!/bin/sh
# Runs ON the TouchPad. Installs the music account type(s) + ls2 role, then
# restarts the Accounts service so it picks up the new template, and restarts
# the backend so it re-reads credentials. Idempotent.
#
# Expects the staging payload already pushed to /media/internal/mp-accounts/:
#   accounts/com.herrie.music.spotify/...   (template + images)
#   ls2-roles/org.webosports.app.music.service.json
#   spotify-webos-service                   (rebuilt ARM backend, optional)
set -e
STAGE=/media/internal/mp-accounts
ACCTS=/usr/palm/public/accounts
ROLES_PRV=/usr/share/ls2/roles/prv
ROLES_PUB=/usr/share/ls2/roles/pub

echo "== remount rootfs rw =="
mount -o remount,rw / 2>/dev/null || true

echo "== install account template(s) -> $ACCTS =="
mkdir -p "$ACCTS"
cp -a "$STAGE"/accounts/. "$ACCTS"/
ls -la "$ACCTS"/com.herrie.music.spotify/ || true

echo "== install ls2 role (both bus dirs) =="
for d in "$ROLES_PRV" "$ROLES_PUB"; do
    if [ -d "$d" ]; then
        cp -f "$STAGE"/ls2-roles/org.webosports.app.music.service.json "$d"/ 2>/dev/null || true
    fi
done

echo "== install rebuilt backend (if staged) -> /media/cryptofs (NOT /media/internal: =="
echo "   a binary/log on the USB-exported vfat blocks 'USB drive' unmount) =="
if [ -f "$STAGE/spotify-webos-service" ]; then
    mkdir -p /media/cryptofs/spotify-webos
    install -m 0755 "$STAGE/spotify-webos-service" /media/cryptofs/spotify-webos/spotify-webos-service
fi

echo "== sync + remount ro =="
sync
mount -o remount,ro / 2>/dev/null || true

echo "== refresh ls2 + Accounts service so the new type registers =="
ls-control scan-services 2>/dev/null || true
# restart the accounts service (name differs across builds; try the known ones)
for svc in com.palm.service.accounts com.palm.service.accounts.mojoservice; do
    luna-send -n 1 -a install "palm://com.palm.service.bus/signal/registerServerStatus" "{\"serviceName\":\"$svc\"}" >/dev/null 2>&1 || true
done
initctl stop LunaSysService 2>/dev/null || true; sleep 1; initctl start LunaSysService 2>/dev/null || true

echo "== restart backend =="
initctl stop spotify-webos-service 2>/dev/null || true
sleep 1
initctl start spotify-webos-service 2>/dev/null || \
    (/media/cryptofs/spotify-webos/spotify-webos-service >/var/log/spotify-webos-service.log 2>&1 &) || true

echo "== DONE. Verify the type is registered: =="
echo 'luna-send -n 1 -a test palm://com.palm.service.accounts/listAccountTemplates "{}"'
