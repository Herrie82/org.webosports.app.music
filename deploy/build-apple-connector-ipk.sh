#!/usr/bin/env bash
# build-apple-connector-ipk.sh — build a STANDALONE Apple Music Synergy connector .ipk.
#
# Contents (self-contained; only external dep is Atlas, which the user already has):
#   - validator web app  org.webosports.app.musicauth  (generic; only the Apple template is installed)
#   - account template   org.webosports.app.music.apple -> /usr/palm/public/accounts  (via postinst, rootfs)
#   - LS2 role           org.webosports.app.music.service.json -> /usr/share/ls2/roles/{prv,pub}
#   - backend service    spotify-webos-service (ARM) -> /media/cryptofs/spotify-webos  (serves
#                        127.0.0.1:8730/appleauth/* that the validator drives) + its upstart job
#
# The account template, role, backend binary and upstart job cannot live in data.tar.gz (ipkg's
# offline-root is /media/cryptofs/apps, so data lands under there) — they must go to rootfs / cryptofs
# roots. So they ship as a connector-payload inside the app bundle and the postinst copies them out.
#
# INSTALL VIA Preware or WebOS Quick Install (ipkg, runs postinst as root). palm-install will NOT run
# the postinst, so the template/service/role are never provisioned.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GOROOT_BIN="${GOROOT_BIN:-/home/herrie/webos/gotool/go125/bin}"
PKG_ID="org.webosports.app.music.apple"
APP_ID="org.webosports.app.musicauth"
VER="${VER:-0.9.0}"
OUT="$ROOT/build-output"
PKG="${PKG_ID}_${VER}_all.ipk"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo ">> 1. build ARM backend (fresh, latest applemusic.go)"
( cd "$ROOT/service" && PATH="$GOROOT_BIN:$PATH" GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$STAGE/spotify-webos-service" . )
echo "   backend $(du -h "$STAGE/spotify-webos-service" | cut -f1)"

echo ">> 2. stage data tree"
APPDST="$STAGE/data/usr/palm/applications/$APP_ID"
PKGDST="$STAGE/data/usr/palm/packages/$PKG_ID"
PAYLOAD="$APPDST/connector-payload"
mkdir -p "$APPDST" "$PKGDST" "$PAYLOAD/accounts" "$PAYLOAD/ls2-roles"

# validator app (generic; supports all services, but only the Apple template is provisioned)
rsync -a --exclude '.git' "$ROOT/app-musicauth"/ "$APPDST"/
sed -i "s/\"version\"[^,]*/\"version\": \"$VER\"/" "$APPDST/appinfo.json"

# connector payload — postinst moves these to their real (non-cryptofs-apps) locations
cp -a "$ROOT/deploy/accounts/org.webosports.app.music.apple"                      "$PAYLOAD/accounts/"
cp -f "$ROOT/deploy/ls2-roles/org.webosports.app.music.service.json"      "$PAYLOAD/ls2-roles/"
cp -f "$ROOT/deploy/spotify-webos-service.upstart"                        "$PAYLOAD/spotify-webos-service.upstart"
install -m 0755 "$STAGE/spotify-webos-service"                           "$PAYLOAD/spotify-webos-service"

cat > "$PKGDST/packageinfo.json" <<EOF
{ "app": "$APP_ID", "id": "$PKG_ID", "icon": "icon.png", "loc_name": "Apple Music Connector", "package_format_version": 2, "vendor": "WebOS Ports", "version": "$VER" }
EOF

echo ">> 3. control + postinst/prerm"
mkdir -p "$STAGE/control"
KB=$(du -sk "$STAGE/data" | cut -f1)
cat > "$STAGE/control/control" <<EOF
Package: $PKG_ID
Version: $VER
Section: misc
Priority: optional
Architecture: all
Installed-Size: $KB
Maintainer: Herman van Hazendonk <github.com@herrie.org>
Description: Apple Music Synergy connector (account template + validator + local backend). Adds an "Apple Music" account type; sign-in runs through Atlas MusicKit against the backend on 127.0.0.1:8730. Requires Atlas. Install via Preware / WebOS Quick Install so the postinst runs as root.
webOS-Package-Format-Version: 2
EOF

cat > "$STAGE/control/postinst" <<'POSTINST'
#!/bin/sh
# Runs as root under ipkg (Preware / WebOS Quick Install). Provisions the Apple Music account type,
# LS2 role, and the local backend service that serves the MusicKit sign-in the validator drives.
set -e
APP=/media/cryptofs/apps/usr/palm/applications/org.webosports.app.musicauth
PAYLOAD="$APP/connector-payload"
ACCTS=/usr/palm/public/accounts
DATADIR=/media/cryptofs/spotify-webos
echo "apple-connector: installing device components..."

# backend binary + writable state dir (cryptofs, NOT /media/internal: a binary on the USB-exported
# vfat blocks 'USB drive' unmount). cryptofs is only suspended for MSM and persists across reboots.
mkdir -p "$DATADIR"
[ -f "$PAYLOAD/spotify-webos-service" ] && install -m 0755 "$PAYLOAD/spotify-webos-service" "$DATADIR/spotify-webos-service"

# account template + LS2 role + upstart job live on rootfs -> remount rw
mount -o remount,rw / 2>/dev/null || true
mkdir -p "$ACCTS"
cp -a "$PAYLOAD/accounts/." "$ACCTS/"
for d in /usr/share/ls2/roles/prv /usr/share/ls2/roles/pub; do
    [ -d "$d" ] && cp -f "$PAYLOAD/ls2-roles/"*.json "$d/" 2>/dev/null || true
done
cp -f "$PAYLOAD/spotify-webos-service.upstart" /etc/event.d/spotify-webos-service
chmod 644 /etc/event.d/spotify-webos-service
sync
mount -o remount,ro / 2>/dev/null || true

# reclaim the 20MB payload copy (already installed to DATADIR)
rm -f "$PAYLOAD/spotify-webos-service"

# register the new account type + start the backend
ls-control scan-services 2>/dev/null || true
initctl stop LunaSysService 2>/dev/null || true; sleep 1; initctl start LunaSysService 2>/dev/null || true
initctl stop spotify-webos-service 2>/dev/null || true; sleep 1
initctl start spotify-webos-service 2>/dev/null || \
    ( "$DATADIR/spotify-webos-service" -addr 127.0.0.1:8730 >/dev/null 2>&1 & ) || true

echo "apple-connector: done. Accounts app -> Add account -> Apple Music."
exit 0
POSTINST

cat > "$STAGE/control/prerm" <<'PRERM'
#!/bin/sh
# Runs as root before removal. Removes the Apple template + backend + upstart; LEAVES the shared LS2
# role (a co-installed full music app may still need it — harmless to leave).
ACCTS=/usr/palm/public/accounts
DATADIR=/media/cryptofs/spotify-webos
echo "apple-connector: removing device components..."
initctl stop spotify-webos-service 2>/dev/null || true
mount -o remount,rw / 2>/dev/null || true
rm -rf "$ACCTS/org.webosports.app.music.apple"
rm -f /etc/event.d/spotify-webos-service
sync
mount -o remount,ro / 2>/dev/null || true
rm -rf "$DATADIR"
ls-control scan-services 2>/dev/null || true
exit 0
PRERM
chmod 0755 "$STAGE/control/postinst" "$STAGE/control/prerm"

echo ">> 4. assemble .ipk (ar: debian-binary + control.tar.gz + data.tar.gz)"
mkdir -p "$OUT"; rm -f "$OUT/$PKG"
( cd "$STAGE" && echo "2.0" > debian-binary \
  && tar --owner=0 --group=0 -czf control.tar.gz -C control . \
  && tar --owner=0 --group=0 -czf data.tar.gz -C data . \
  && ar rc "$OUT/$PKG" debian-binary control.tar.gz data.tar.gz )
echo ">> built $OUT/$PKG ($(du -h "$OUT/$PKG" | cut -f1))"
