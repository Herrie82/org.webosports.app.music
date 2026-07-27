#!/bin/bash
# Package the Music+Spotify Enyo app into an installable webOS IPK.
#
# Produces build-output/com.herrie.spotify_<ver>_all.ipk in the same ar layout
# as a stock webOS package (debian-binary + control.tar.gz + data.tar.gz).
#
# The Go backend service (service/) and librespot are deployed separately as
# native components — see docs/ARCHITECTURE.md. This script packages the UI app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT/app"
OUT="$ROOT/build-output"
ID="$(sed -n 's/.*"id"[^"]*"\([^"]*\)".*/\1/p' "$APP_DIR/appinfo.json" | head -1)"
VER="$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$APP_DIR/appinfo.json" | head -1)"
PKG="${ID}_${VER}_all.ipk"

echo ">> packaging $ID v$VER"
rm -rf "$OUT/stage"
mkdir -p "$OUT/stage/data/usr/palm/applications/$ID" \
         "$OUT/stage/data/usr/palm/packages/$ID" \
         "$OUT/stage/control"

# ---- data.tar.gz : the app payload under /usr/palm/applications/<id> ----
rsync -a --exclude '.git' --exclude 'spec' --exclude 'mock' "$APP_DIR"/ \
	"$OUT/stage/data/usr/palm/applications/$ID/"

# ---- SAFEGUARD: localized resources/<locale>/appinfo.json must carry OUR id.
# The stock fork's localized appinfos declare id "com.palm.app.musicplayer";
# LunaSysMgr reads the locale appinfo and silently refuses to register an app
# whose localized id collides with the installed system Music app. Rewrite them.
APP_STAGE="$OUT/stage/data/usr/palm/applications/$ID"
python3 - "$APP_STAGE" "$ID" <<'PY'
import json, glob, os, sys
appdir, newid = sys.argv[1], sys.argv[2]
for f in glob.glob(os.path.join(appdir, "resources", "**", "appinfo.json"), recursive=True):
    try:
        a = json.load(open(f))
    except Exception:
        continue
    if a.get("id") and a["id"] != newid:
        a["id"] = newid
        json.dump(a, open(f, "w"), indent=1)
        print("   synced localized id:", os.path.relpath(f, appdir))
PY

# ---- package metadata : REQUIRED for the installer to register a launch point ----
TITLE="$(sed -n 's/.*"title"[^"]*"\([^"]*\)".*/\1/p' "$APP_DIR/appinfo.json" | head -1)"
cat > "$OUT/stage/data/usr/palm/packages/$ID/packageinfo.json" <<EOF
{
	"app": "$ID",
	"id": "$ID",
	"icon": "icon.png",
	"loc_name": "$TITLE",
	"package_format_version": 2,
	"vendor": "Herrie",
	"version": "$VER"
}
EOF

INSTALLED_KB=$(du -sk "$OUT/stage/data" | cut -f1)

# ---- control : package metadata ----
cat > "$OUT/stage/control/control" <<EOF
Package: $ID
Version: $VER
Section: misc
Priority: optional
Architecture: all
Installed-Size: $INSTALLED_KB
Maintainer: Herrie <nobody@example.com>
Description: Music+Spotify — local + Spotify playback for webOS.
webOS-Package-Format-Version: 2
EOF

# ---- assemble the ar archive ----
cd "$OUT/stage"
echo "2.0" > debian-binary
tar czf control.tar.gz -C control .
tar czf data.tar.gz    -C data .
mkdir -p "$OUT"
ar rc "$OUT/$PKG" debian-binary control.tar.gz data.tar.gz
cd "$ROOT"
rm -rf "$OUT/stage"
echo ">> built $OUT/$PKG"
