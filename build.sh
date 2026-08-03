#!/bin/bash
# Package the Music+Spotify Enyo app + shared framework bits into an installable webOS IPK.
#
# Produces build-output/org.webosports.app.music_<ver>_all.ipk in the same ar layout
# as a stock webOS package (debian-binary + control.tar.gz + data.tar.gz).
#
# This is the BASE package: the Enyo UI app, the musicauth validator app (shared OAuth/
# token-capture UI used by every provider), the Go backend binary, its LS2 role, and its
# upstart job. Per-provider account types are NOT here — each streaming provider ships as
# its own small connector ipk (see deploy/build-connector-ipk.sh) that just adds an account
# template on top of this base. Install this one first.
#
# Because installing the backend/role/upstart requires root, this ipk needs a postinst —
# install via Preware or WebOS Quick Install (ipkg). Plain palm-install will NOT run it,
# so the backend will never start and no connector can do anything useful.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT/app"
AUTH_DIR="$ROOT/app-musicauth"
OUT="$ROOT/build-output"
GOROOT_BIN="${GOROOT_BIN:-/home/herrie/webos/gotool/go125/bin}"

ID="$(sed -n 's/.*"id"[^"]*"\([^"]*\)".*/\1/p' "$APP_DIR/appinfo.json" | head -1)"
VER="$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$APP_DIR/appinfo.json" | head -1)"
AUTH_ID="$(sed -n 's/.*"id"[^"]*"\([^"]*\)".*/\1/p' "$AUTH_DIR/appinfo.json" | head -1)"
PKG="${ID}_${VER}_all.ipk"

echo ">> packaging $ID v$VER (+ $AUTH_ID + backend)"
rm -rf "$OUT/stage"
mkdir -p "$OUT/stage/data/usr/palm/applications/$ID" \
         "$OUT/stage/data/usr/palm/applications/$AUTH_ID" \
         "$OUT/stage/data/usr/palm/packages/$ID" \
         "$OUT/stage/control"

# ---- data.tar.gz : the app payload under /usr/palm/applications/<id> ----
rsync -a --exclude '.git' --exclude 'spec' --exclude 'mock' "$APP_DIR"/ \
	"$OUT/stage/data/usr/palm/applications/$ID/"

# ---- musicauth validator app (shared by every provider's connector) ----
rsync -a --exclude '.git' "$AUTH_DIR"/ \
	"$OUT/stage/data/usr/palm/applications/$AUTH_ID/"
sed -i "s/\"version\"[^,]*/\"version\": \"$VER\"/" \
	"$OUT/stage/data/usr/palm/applications/$AUTH_ID/appinfo.json"

# ---- SAFEGUARD: localized resources/<locale>/appinfo.json must carry OUR id
# and version. The stock fork's localized appinfos declare id
# "com.palm.app.musicplayer"; LunaSysMgr reads the locale appinfo and
# silently refuses to register an app whose localized id collides with the
# installed system Music app. Also keep version in sync so a stale localized
# copy can't confuse install tooling that inspects it. Rewrite both.
APP_STAGE="$OUT/stage/data/usr/palm/applications/$ID"
python3 - "$APP_STAGE" "$ID" "$VER" <<'PY'
import json, glob, os, sys
appdir, newid, newver = sys.argv[1], sys.argv[2], sys.argv[3]
for f in glob.glob(os.path.join(appdir, "resources", "**", "appinfo.json"), recursive=True):
    try:
        a = json.load(open(f))
    except Exception:
        continue
    changed = []
    if a.get("id") and a["id"] != newid:
        a["id"] = newid
        changed.append("id")
    if a.get("version") and a["version"] != newver:
        a["version"] = newver
        changed.append("version")
    if changed:
        json.dump(a, open(f, "w"), indent=1)
        print("   synced localized %s:" % "+".join(changed), os.path.relpath(f, appdir))
PY

# ---- framework payload : backend binary + LS2 role + upstart job, moved to their real
# (non-cryptofs-apps) locations by postinst. Staged inside our own app dir so it travels
# in data.tar.gz without needing a package id of its own. ----
FW_PAYLOAD="$APP_STAGE/framework-payload"
mkdir -p "$FW_PAYLOAD/ls2-roles"

echo ">> building ARM backend (fresh, latest service/ sources)"
( cd "$ROOT/service" && PATH="$GOROOT_BIN:$PATH" GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$FW_PAYLOAD/spotify-webos-service" . )
chmod 0755 "$FW_PAYLOAD/spotify-webos-service"
cp -f "$ROOT/deploy/ls2-roles/org.webosports.app.music.service.json" "$FW_PAYLOAD/ls2-roles/"
cp -f "$ROOT/deploy/spotify-webos-service.upstart" "$FW_PAYLOAD/spotify-webos-service.upstart"

# ---- package metadata : REQUIRED for the installer to register a launch point ----
TITLE="$(sed -n 's/.*"title"[^"]*"\([^"]*\)".*/\1/p' "$APP_DIR/appinfo.json" | head -1)"
cat > "$OUT/stage/data/usr/palm/packages/$ID/packageinfo.json" <<EOF
{
	"app": "$ID",
	"id": "$ID",
	"icon": "icon.png",
	"loc_name": "$TITLE",
	"package_format_version": 2,
	"vendor": "WebOS Ports",
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
Maintainer: Herman van Hazendonk <github.com@herrie.org>
Description: Music+Spotify — local playback for webOS, plus the shared backend, LS2 role and musicauth validator that per-provider connector ipks (deploy/build-connector-ipk.sh) plug into. Install via Preware / WebOS Quick Install so the postinst runs as root.
webOS-Package-Format-Version: 2
EOF

# ---- postinst / prerm : install/remove the backend daemon + LS2 role ----
cat > "$OUT/stage/control/postinst" <<POSTINST
#!/bin/sh
# Runs as root under ipkg (Preware / WebOS Quick Install). Installs the backend binary,
# its LS2 role, and its upstart job; leaves any per-provider account templates to the
# connector ipks (they only need this daemon + role to already be present).
set -e
APP=/media/cryptofs/apps/usr/palm/applications/$ID
PAYLOAD="\$APP/framework-payload"
DATADIR=/media/cryptofs/spotify-webos
echo "$ID: installing backend..."

# backend binary + writable state dir (cryptofs, NOT /media/internal: a binary on the
# USB-exported vfat blocks 'USB drive' unmount). cryptofs is only suspended for MSM and
# persists across reboots.
mkdir -p "\$DATADIR"
install -m 0755 "\$PAYLOAD/spotify-webos-service" "\$DATADIR/spotify-webos-service"

# LS2 role + upstart job live on rootfs -> remount rw
mount -o remount,rw / 2>/dev/null || true
for d in /usr/share/ls2/roles/prv /usr/share/ls2/roles/pub; do
    [ -d "\$d" ] && cp -f "\$PAYLOAD/ls2-roles/"*.json "\$d/" 2>/dev/null || true
done
cp -f "\$PAYLOAD/spotify-webos-service.upstart" /etc/event.d/spotify-webos-service
chmod 644 /etc/event.d/spotify-webos-service
sync
mount -o remount,ro / 2>/dev/null || true

# reclaim the payload copy (already installed to DATADIR)
rm -f "\$PAYLOAD/spotify-webos-service"

ls-control scan-services 2>/dev/null || true
initctl stop spotify-webos-service 2>/dev/null || true; sleep 1
initctl start spotify-webos-service 2>/dev/null || \\
    ( "\$DATADIR/spotify-webos-service" -addr 127.0.0.1:8730 >/dev/null 2>&1 & ) || true

echo "$ID: done. Install a provider connector ipk to add an account type."
exit 0
POSTINST

cat > "$OUT/stage/control/prerm" <<'PRERM'
#!/bin/sh
# Runs as root before removal. Stops the daemon and removes the role/upstart job/binary.
# Deliberately LEAVES /media/cryptofs/spotify-webos's cached credentials/tokens/library
# data — those belong to the user, not this package, and a reinstall should find them again.
DATADIR=/media/cryptofs/spotify-webos
echo "removing backend daemon..."
initctl stop spotify-webos-service 2>/dev/null || true
mount -o remount,rw / 2>/dev/null || true
rm -f /etc/event.d/spotify-webos-service
for d in /usr/share/ls2/roles/prv /usr/share/ls2/roles/pub; do
    rm -f "$d/org.webosports.app.music.service.json" 2>/dev/null || true
done
sync
mount -o remount,ro / 2>/dev/null || true
rm -f "$DATADIR/spotify-webos-service"
ls-control scan-services 2>/dev/null || true
exit 0
PRERM
chmod 0755 "$OUT/stage/control/postinst" "$OUT/stage/control/prerm"

# ---- assemble the ar archive ----
cd "$OUT/stage"
echo "2.0" > debian-binary
tar --owner=0 --group=0 -czf control.tar.gz -C control .
tar --owner=0 --group=0 -czf data.tar.gz    -C data .
mkdir -p "$OUT"
ar rc "$OUT/$PKG" debian-binary control.tar.gz data.tar.gz
cd "$ROOT"
rm -rf "$OUT/stage"
echo ">> built $OUT/$PKG"
