#!/bin/sh
# Runs ON the TouchPad. One-shot migration of the Music+Spotify backend off the
# USB-exported vfat partition (/media/internal) onto /media/cryptofs, so entering
# "USB drive" mode no longer fails with "USB drive Connection failed".
#
# WHY: storaged unmounts /media/internal for Mass Storage Mode via force-unmount.sh,
# which REFUSES to kill any holder whose executable lives on cryptofs. The backend +
# librespot run from /media/internal and keep librespot.log open there, so the unmount
# fails. /media/cryptofs is only SUSPENDED (not unmounted) for MSM and persists across
# reboots, so everything belongs there. (Secrets moved too; only the user-facing
# Downloads dir and a user-supplied device.wvd stay on /media/internal.)
#
# PREREQUISITE: a backend REBUILT from the updated source (paths now point at
# /media/cryptofs/spotify-webos — see service/paths.go) staged at:
#     /media/internal/spotify-webos-service.new
#   Build:  GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -ldflags="-s -w" \
#               -o spotify-webos-service.new .
#   Push:   novacom -d topaz-linux put file:///media/internal/spotify-webos-service.new < spotify-webos-service.new
set -e
SRC=/media/internal
DST=/media/cryptofs/spotify-webos
NEWBIN=$SRC/spotify-webos-service.new

echo "== 0. sanity: rebuilt backend staged? =="
if [ ! -f "$NEWBIN" ]; then
    echo "!! $NEWBIN not found. Build the ARM backend from the updated source and push it there first."
    echo "   (Without the rebuilt binary the old one still reads /media/internal and this migration would break playback.)"
    exit 1
fi

echo "== 1. stop the backend (takes librespot + gst down with it) =="
initctl stop spotify-webos-service 2>/dev/null || true
sleep 1
# belt-and-suspenders: clear any orphaned librespot/gst still holding /media/internal
for p in $(pidof spotify-webos-service librespot gst-launch-0.10 2>/dev/null); do kill "$p" 2>/dev/null || true; done
sleep 1

echo "== 2. create the cryptofs home =="
mkdir -p "$DST"

echo "== 3. install the rebuilt backend -> cryptofs =="
install -m 0755 "$NEWBIN" "$DST/spotify-webos-service"

echo "== 4. move librespot binary + cache + all token/credential files -> cryptofs =="
# binaries + cache (the actual USB-mode blockers) + secrets. Keep Downloads + device.wvd.
for f in librespot librespot-cache \
         spotify-token.json spotify-client-id \
         jamendo-clientid deezer-arl qobuz-auth youtube-oauth.json tidal-token \
         apple-music-user-token apple-webtoken.json; do
    if [ -e "$SRC/$f" ]; then
        rm -rf "$DST/$f"
        mv "$SRC/$f" "$DST/$f"
        echo "   moved $f"
    fi
done

echo "== 5. drop the stale log on the exported partition =="
rm -f "$SRC/librespot.log"

echo "== 6. install the updated upstart job (rootfs rw) =="
mount -o remount,rw / 2>/dev/null || true
cat > /etc/event.d/spotify-webos-service <<'EOF'
description "Music+Spotify backend (Spotify search + Connect playback control)"

start on started LunaSysMgr
stop on stopping LunaSysMgr

respawn

# Backend + librespot + log + cache + all token/credential files live under
# /media/cryptofs/spotify-webos (NOT /media/internal — that vfat partition is exported
# in USB drive mode; a binary/log/open-fd there blocks the unmount). cryptofs is only
# suspended for MSM and persists across reboots.
exec /media/cryptofs/spotify-webos/spotify-webos-service -addr 127.0.0.1:8730
EOF
sync
mount -o remount,ro / 2>/dev/null || true

echo "== 7. clean up the old backend binary + staged copy on /media/internal =="
rm -f "$SRC/spotify-webos-service" "$NEWBIN"

echo "== 8. start the relocated backend =="
initctl start spotify-webos-service 2>/dev/null || \
    ("$DST/spotify-webos-service" >/var/log/spotify-webos-service.log 2>&1 &) || true

echo "== DONE. Verify nothing spotify-related still holds /media/internal: =="
echo "   ls -l /proc/\$(pidof spotify-webos-service librespot)/fd 2>/dev/null | grep /media/internal   (expect none)"
echo "   then try Settings > Device > 'USB drive' — it should connect now."
