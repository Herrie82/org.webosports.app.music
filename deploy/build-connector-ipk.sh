#!/usr/bin/env bash
# build-connector-ipk.sh <provider> — build a small Synergy connector .ipk that adds ONE
# streaming provider's account type, e.g.:
#   ./deploy/build-connector-ipk.sh spotify
#   ./deploy/build-connector-ipk.sh deezer
#
# Requires the BASE package (org.webosports.app.music, built by ../build.sh) to already be
# installed: that's what provides the musicauth validator app, the backend binary, its LS2
# role, and its upstart job. This ipk only adds the account template — no backend binary,
# no validator app, no LS2 role duplicated per provider.
#
# Multiple connector ipks install side by side (e.g. spotify + deezer): each provisions its
# own account template only, so there's nothing shared to step on between them.
#
# INSTALL VIA Preware or WebOS Quick Install (ipkg, runs postinst as root). palm-install will
# NOT run the postinst, so the account template is never provisioned.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PROVIDER="${1:?usage: build-connector-ipk.sh <provider>  (e.g. spotify, apple, deezer, tidal, qobuz, soundcloud, jamendo, archive)}"
PKG_ID="org.webosports.app.music.$PROVIDER"
APP_ID="org.webosports.app.musicauth"
ACCOUNT_DIR="$ROOT/deploy/accounts/$PKG_ID"
ACCOUNT_JSON="$ACCOUNT_DIR/$PKG_ID.json"
[ -d "$ACCOUNT_DIR" ] || { echo "!! no account template at $ACCOUNT_DIR" >&2; exit 1; }

LOC_NAME="$(sed -n 's/.*"loc_name"[^"]*"\([^"]*\)".*/\1/p' "$ACCOUNT_JSON" | head -1)"
[ -n "$LOC_NAME" ] || LOC_NAME="$PROVIDER"

VER="${VER:-0.9.2}"
OUT="$ROOT/build-output"
PKG="${PKG_ID}_${VER}_all.ipk"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo ">> 1. stage data tree"
# Payload rides inside musicauth's own app directory (owned by the base package) so it
# doesn't need — and doesn't get — an app id / launch point of its own.
APPDST="$STAGE/data/usr/palm/applications/$APP_ID"
PKGDST="$STAGE/data/usr/palm/packages/$PKG_ID"
PAYLOAD="$APPDST/connector-payload"
mkdir -p "$PKGDST" "$PAYLOAD/accounts"

cp -a "$ACCOUNT_DIR" "$PAYLOAD/accounts/"

cat > "$PKGDST/packageinfo.json" <<EOF
{ "app": "$APP_ID", "id": "$PKG_ID", "icon": "icon.png", "loc_name": "$LOC_NAME Connector", "package_format_version": 2, "vendor": "WebOS Ports", "version": "$VER" }
EOF

echo ">> 2. control + postinst/prerm"
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
Description: $LOC_NAME Synergy connector — adds a "$LOC_NAME" account type. Requires org.webosports.app.music (base package: validator app + backend + LS2 role) already installed — install that first; not expressed as a package Depends: because webOS ipkg/Preware doesn't reliably resolve deps against side-loaded ipks. Install via Preware / WebOS Quick Install so the postinst runs as root.
webOS-Package-Format-Version: 2
EOF

cat > "$STAGE/control/postinst" <<POSTINST
#!/bin/sh
# Runs as root under ipkg (Preware / WebOS Quick Install). Provisions only the $LOC_NAME
# account template — the backend/role/validator are the base package's job.
set -e
APP=/media/cryptofs/apps/usr/palm/applications/$APP_ID
PAYLOAD="\$APP/connector-payload"
ACCTS=/usr/palm/public/accounts
echo "$PROVIDER-connector: installing account template..."

mount -o remount,rw / 2>/dev/null || true
mkdir -p "\$ACCTS"
cp -a "\$PAYLOAD/accounts/." "\$ACCTS/"
sync
mount -o remount,ro / 2>/dev/null || true

# Dropping the template file isn't enough — the Accounts service caches its template
# list and only re-scans on these triggers (see deploy/ondevice-install-accounts.sh,
# already proven on-device). Without this, the new type stays invisible even after a
# reboot if the service doesn't happen to re-scan the directory on every boot.
ls-control scan-services 2>/dev/null || true
for svc in com.palm.service.accounts com.palm.service.accounts.mojoservice; do
    luna-send -n 1 -a install "palm://com.palm.service.bus/signal/registerServerStatus" "{\"serviceName\":\"\$svc\"}" >/dev/null 2>&1 || true
done
initctl stop LunaSysService 2>/dev/null || true; sleep 1; initctl start LunaSysService 2>/dev/null || true

echo "$PROVIDER-connector: done. Accounts app -> Add account -> $LOC_NAME."
exit 0
POSTINST

cat > "$STAGE/control/prerm" <<PRERM
#!/bin/sh
# Runs as root before removal. Removes ONLY this connector's account template.
ACCTS=/usr/palm/public/accounts
echo "$PROVIDER-connector: removing account template..."
mount -o remount,rw / 2>/dev/null || true
rm -rf "\$ACCTS/$PKG_ID"
sync
mount -o remount,ro / 2>/dev/null || true
ls-control scan-services 2>/dev/null || true
exit 0
PRERM
chmod 0755 "$STAGE/control/postinst" "$STAGE/control/prerm"

echo ">> 3. assemble .ipk (ar: debian-binary + control.tar.gz + data.tar.gz)"
mkdir -p "$OUT"; rm -f "$OUT/$PKG"
( cd "$STAGE" && echo "2.0" > debian-binary \
  && tar --owner=0 --group=0 -czf control.tar.gz -C control . \
  && tar --owner=0 --group=0 -czf data.tar.gz -C data . \
  && ar rc "$OUT/$PKG" debian-binary control.tar.gz data.tar.gz )
echo ">> built $OUT/$PKG ($(du -h "$OUT/$PKG" | cut -f1))"
