#!/bin/bash
# Package the Music+Spotify Enyo app + shared framework bits into an installable webOS IPK.
#
# Produces build-output/org.webosports.app.music_<ver>_all.ipk in the same ar layout
# as a stock webOS package (debian-binary + control.tar.gz + data.tar.gz).
#
# This is the BASE package: the Enyo UI app, the musicauth validator app (shared OAuth/
# token-capture UI used by every provider), the Go backend binary, and its upstart job.
# Per-provider account types are NOT here — each streaming provider ships as its own
# small connector ipk (see deploy/build-connector-ipk.sh) that just adds an account
# template on top of this base. Install this one first.
#
# Because installing the backend/upstart requires root, this ipk needs a postinst —
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
# The app payloads are staged under media/cryptofs/music-overwrite/<id>/, NOT directly under
# usr/palm/applications/<id> -- see postinst below for the full rationale. Each sub-payload
# (app/, musicauth/) carries its own dest.txt naming the real absolute path postinst installs it
# to; framework-payload/ has no dest.txt of its own since postinst handles its two files
# individually (backend binary -> cryptofs state dir, upstart job -> /etc/event.d).
OV_REL="media/cryptofs/music-overwrite/$ID"
OV="$OUT/stage/data/$OV_REL"
mkdir -p "$OV/app" "$OV/musicauth" "$OV/framework-payload" \
         "$OUT/stage/data/usr/palm/packages/$ID" \
         "$OUT/stage/control"

# ---- app payload (rsync to a scratch copy first -- the localized-appinfo rewrite below needs a
# writable tree to edit before it gets tarred into payload.tar.gz) ----
APP_SCRATCH="$OUT/stage/.scratch/app"
mkdir -p "$APP_SCRATCH"
rsync -a --exclude '.git' --exclude 'spec' --exclude 'mock' "$APP_DIR"/ "$APP_SCRATCH/"
echo "/media/cryptofs/apps/usr/palm/applications/$ID" > "$OV/app/dest.txt"

# ---- musicauth validator app (shared by every provider's connector) ----
AUTH_SCRATCH="$OUT/stage/.scratch/musicauth"
mkdir -p "$AUTH_SCRATCH"
rsync -a --exclude '.git' "$AUTH_DIR"/ "$AUTH_SCRATCH/"
sed -i "s/\"version\"[^,]*/\"version\": \"$VER\"/" "$AUTH_SCRATCH/appinfo.json"
echo "/media/cryptofs/apps/usr/palm/applications/$AUTH_ID" > "$OV/musicauth/dest.txt"

# ---- SAFEGUARD: localized resources/<locale>/appinfo.json must carry OUR id
# and version. The stock fork's localized appinfos declare id
# "com.palm.app.musicplayer"; LunaSysMgr reads the locale appinfo and
# silently refuses to register an app whose localized id collides with the
# installed system Music app. Also keep version in sync so a stale localized
# copy can't confuse install tooling that inspects it. Rewrite both.
python3 - "$APP_SCRATCH" "$ID" "$VER" <<'PY'
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

# ---- framework payload : backend binary + upstart job, moved to their real
# (non-cryptofs-apps) locations by postinst. Staged alongside app/ and musicauth/ under the same
# OV_REL tree (no dest.txt of its own -- postinst installs its two files individually, to two
# different real destinations, not as a single whole-directory replace). ----
#
# NOT shipping deploy/ls2-roles/org.webosports.app.music.service.json here anymore: it
# declares "exeName": "/usr/bin/luna-send", the SAME exeName the stock
# com.palm.lunasend.json role already uses. Two role files claiming the same exeName
# broke ls-hubd's ability to register ANY luna-send identity at all (every `luna-send`
# call, from any caller, failed with "-1027 Invalid permissions for (null)") until the
# conflicting file was removed and the device rebooted. The role file's own comment
# already said "the dev bus is permissive and `luna-send -a` may already succeed
# without this" — the risk far outweighs the benefit, so we don't install it.
FW_PAYLOAD="$OV/framework-payload"

echo ">> building ARM backend (fresh, latest service/ sources)"
( cd "$ROOT/service" && PATH="$GOROOT_BIN:$PATH" GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$FW_PAYLOAD/spotify-webos-service" . )
chmod 0755 "$FW_PAYLOAD/spotify-webos-service"
cp -f "$ROOT/deploy/spotify-webos-service.upstart" "$FW_PAYLOAD/spotify-webos-service.upstart"

# ---- tar the two app scratch copies into their OV sub-payloads ----
# No symlink-exclusion/reconstruction dance (unlike core-apps/webos-synergy-revival's
# stage_whole/stage_root_dir): neither app/ nor app-musicauth/ contains any symlinks today
# (checked at write time). Fail loudly instead of silently shipping something cryptofs can't
# stage (rejects symlink() outright) if that ever changes.
for scratch in "$APP_SCRATCH" "$AUTH_SCRATCH"; do
  if [ -n "$(find "$scratch" -type l -print -quit)" ]; then
    echo "!! $scratch contains a symlink - not handled by this script, see stage_root_dir in" >&2
    echo "   webos-synergy-revival/packaging/lib/common.sh for the pattern to port over" >&2
    exit 1
  fi
done
tar -C "$APP_SCRATCH" --owner=0 --group=0 -czf "$OV/app/payload.tar.gz" .
tar -C "$AUTH_SCRATCH" --owner=0 --group=0 -czf "$OV/musicauth/payload.tar.gz" .
rm -rf "$OUT/stage/.scratch"

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
Description: Music+Spotify — local playback for webOS, plus the shared backend and musicauth validator that per-provider connector ipks (deploy/build-connector-ipk.sh) plug into. Install via Preware / WebOS Quick Install so the postinst runs as root.
webOS-Package-Format-Version: 2
EOF

# ---- postinst / prerm : install/remove the backend daemon ----
cat > "$OUT/stage/control/postinst" <<POSTINST
#!/bin/sh
# Runs as root under ipkg (Preware / WebOS Quick Install). Installs the app + musicauth
# validator from their OV sub-payloads, then the backend binary + upstart job; leaves any
# per-provider account templates to the connector ipks (they only need this daemon to
# already be present). Deliberately does NOT install any custom LS2 role for
# /usr/bin/luna-send — see the comment in build.sh above this heredoc for why that broke
# the whole device's luna-send registration once already.
set -e

# Preware/WebOS Quick Install's offline-root ipkg invocation (\`ipkg -o /media/cryptofs/apps
# install <ipk>\`) prepends /media/cryptofs/apps to EVERY path in data.tar.gz. The OV tree
# staged at media/cryptofs/music-overwrite/$ID/ (see build.sh) is NEVER written directly to
# usr/palm/applications/<id> in the archive for exactly this reason: that path is real
# root-fs (read-only at extraction time, before this script ever runs to remount it), and
# even staged under media/cryptofs/apps/... directly it would double-prefix under offline-root
# install (confirmed live elsewhere in this project family - the App Manager never finds it).
# Staging under a neutral OV path and copying to the literal real destination here, checking
# BOTH where ipkg might have put it, is immune to which install method was used.
OV=""
for base in /media/cryptofs/music-overwrite/$ID /media/cryptofs/apps/media/cryptofs/music-overwrite/$ID; do
    [ -d "\$base" ] && OV="\$base" && break
done
if [ -z "\$OV" ]; then
    # WebOSQuickInstall (confirmed live elsewhere in this project family) runs this SAME
    # pmPostInstall.script a second time itself, after the real App-Installer-driven install
    # already ran it once and cleaned up \$OV (see below) - a second run legitimately finds
    # nothing staged, which is not a real failure if both real destinations are already there.
    if [ -d /media/cryptofs/apps/usr/palm/applications/$ID ] && [ -d /media/cryptofs/apps/usr/palm/applications/$AUTH_ID ]; then
        echo "$ID: nothing newly staged - already installed, treating as a no-op"
        exit 0
    fi
    echo "$ID: !! no media/cryptofs/music-overwrite/$ID staged (checked direct + offline-root paths) - nothing to install" >&2
    exit 1
fi

echo "$ID: installing app + musicauth..."
mount -o remount,rw / 2>/dev/null || true
for sub in app musicauth; do
    DST="\$(cat "\$OV/\$sub/dest.txt")"
    rm -rf "\$DST"
    mkdir -p "\$DST"
    tar -C "\$DST" --no-same-owner -xzf "\$OV/\$sub/payload.tar.gz"
    # This whole script runs under set -e, but a truncated-yet-still-gzip-valid transfer can
    # still exit 0 with partial/no content - confirmed live elsewhere in this project family as
    # a real failure mode (ipkg + postinst both report success into an empty directory).
    if [ -z "\$(ls -A "\$DST" 2>/dev/null)" ]; then
        echo "$ID: !! \$sub extracted empty into \$DST - likely a corrupted/truncated transfer" >&2
        exit 1
    fi
done
sync
mount -o remount,ro / 2>/dev/null || true

echo "$ID: installing backend..."
PAYLOAD="\$OV/framework-payload"
DATADIR=/media/cryptofs/spotify-webos

# backend binary + writable state dir (cryptofs, NOT /media/internal: a binary on the
# USB-exported vfat blocks 'USB drive' unmount). cryptofs is only suspended for MSM and
# persists across reboots.
mkdir -p "\$DATADIR"
install -m 0755 "\$PAYLOAD/spotify-webos-service" "\$DATADIR/spotify-webos-service"

# upstart job lives on rootfs -> remount rw
mount -o remount,rw / 2>/dev/null || true
cp -f "\$PAYLOAD/spotify-webos-service.upstart" /etc/event.d/spotify-webos-service
chmod 644 /etc/event.d/spotify-webos-service
sync
mount -o remount,ro / 2>/dev/null || true

# Clean up our own staged copy now that it's been applied -- if left in place, a stale copy
# here would confuse a later reinstall/upgrade the same way described in core-apps packaging/.
rm -rf "\$OV"

ls-control scan-services 2>/dev/null || true
luna-send -n 1 luna://com.palm.applicationManager/rescan '{}' >/dev/null 2>&1 || true
initctl stop spotify-webos-service 2>/dev/null || true; sleep 1
initctl start spotify-webos-service 2>/dev/null || \\
    ( "\$DATADIR/spotify-webos-service" -addr 127.0.0.1:8730 >/dev/null 2>&1 & ) || true

echo "$ID: done. Install a provider connector ipk to add an account type."
exit 0
POSTINST

cat > "$OUT/stage/control/prerm" <<PRERM
#!/bin/sh
# Runs as root before removal. Stops the daemon, removes the upstart job/binary, and removes
# the app + musicauth directories this package installed. Deliberately LEAVES
# /media/cryptofs/spotify-webos's cached credentials/tokens/library data — those belong to the
# user, not this package, and a reinstall should find them again.
DATADIR=/media/cryptofs/spotify-webos
echo "$ID: removing backend daemon..."
initctl stop spotify-webos-service 2>/dev/null || true
mount -o remount,rw / 2>/dev/null || true
rm -f /etc/event.d/spotify-webos-service
rm -rf /media/cryptofs/apps/usr/palm/applications/$ID
rm -rf /media/cryptofs/apps/usr/palm/applications/$AUTH_ID
sync
mount -o remount,ro / 2>/dev/null || true
rm -f "\$DATADIR/spotify-webos-service"
ls-control scan-services 2>/dev/null || true
luna-send -n 1 luna://com.palm.applicationManager/rescan '{}' >/dev/null 2>&1 || true
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
