#!/usr/bin/env bash
# Rebuild the com.herrie.musicauth validator IPK, push it, install on-device via
# ipkg offline-root (hub-independent), and restart LunaSysMgr to re-register.
# Usage: DEVICE=topaz-linux bash deploy/rebuild-musicauth.sh
set -euo pipefail
DEVICE="${DEVICE:-topaz-linux}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="$ROOT/app-musicauth"; ID=com.herrie.musicauth
OUT="$ROOT/build-output"
VER="$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$APPDIR/appinfo.json" | head -1)"
TITLE="$(sed -n 's/.*"title"[^"]*"\([^"]*\)".*/\1/p' "$APPDIR/appinfo.json" | head -1)"
PKG="${ID}_${VER}_all.ipk"
STAGE="$OUT/stage-auth"

echo ">> packaging $ID v$VER"
rm -rf "$STAGE"
mkdir -p "$STAGE/data/usr/palm/applications/$ID" "$STAGE/data/usr/palm/packages/$ID" "$STAGE/control"
rsync -a --exclude '.git' "$APPDIR"/ "$STAGE/data/usr/palm/applications/$ID/"
cat > "$STAGE/data/usr/palm/packages/$ID/packageinfo.json" <<EOF
{ "app": "$ID", "id": "$ID", "icon": "icon.png", "loc_name": "$TITLE", "package_format_version": 2, "vendor": "Herrie", "version": "$VER" }
EOF
KB=$(du -sk "$STAGE/data" | cut -f1)
cat > "$STAGE/control/control" <<EOF
Package: $ID
Version: $VER
Section: misc
Priority: optional
Architecture: all
Installed-Size: $KB
Maintainer: Herrie <nobody@example.com>
Description: Music account validator (customUI) for com.herrie.music.* account types.
webOS-Package-Format-Version: 2
EOF
( cd "$STAGE" && echo "2.0" > debian-binary \
  && tar czf control.tar.gz -C control . && tar czf data.tar.gz -C data . \
  && ar rc "$OUT/$PKG" debian-binary control.tar.gz data.tar.gz )
rm -rf "$STAGE"
echo ">> built $OUT/$PKG"

echo ">> push"
timeout 60 novacom -d "$DEVICE" put "file:///media/internal/$PKG" < "$OUT/$PKG"

# on-device installer written to a file and run by path (novacom re-splits spaces)
TMP="$(mktemp)"
cat > "$TMP" <<EOF
#!/bin/sh
D=/media/cryptofs/apps
rm -rf "\$D/usr/palm/applications/$ID" "\$D/usr/palm/packages/$ID"
ipkg -o "\$D" install /media/internal/$PKG 2>&1 | tail -3
echo "files:"; ls "\$D/usr/palm/applications/$ID"
initctl stop LunaSysMgr 2>&1 | tail -1; sleep 2; initctl start LunaSysMgr 2>&1 | tail -1
EOF
timeout 30 novacom -d "$DEVICE" put file:///media/internal/_install_auth.sh < "$TMP"
rm -f "$TMP"
echo ">> install + LunaSysMgr restart"
timeout 90 novacom -d "$DEVICE" run file:///bin/sh -- /media/internal/_install_auth.sh </dev/null 2>&1 | head -20
echo ">> done — wait for UI, then tap Add account -> Spotify"
