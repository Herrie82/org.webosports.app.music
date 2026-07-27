#!/bin/sh
# provision-media-perms.sh — grant the Music+Spotify app READ access to the local
# media database so its local-music side works.
#
# WHY: org.webosports.app.music is a third-party app (not trustLevel:trusted, since
# trusted apps must live in /usr/palm). The local media kinds
# (com.palm.media.audio.{file,artist,album,genre}:1) have an EXPLICIT read ACL
# (only ids like com.palm.app.musicplayer are listed), so our id gets
# "db: permission denied" (-3963) on every find.
#
# FIX: the kinds are owned by the media indexer service com.palm.filenotifyd.js,
# which itself grants read via com.palm.db/putPermissions. putPermissions is
# owner-scoped, so we impersonate that owner with `luna-send -a`. The grant is
# written to the db8 permission store and persists across reboots (re-run after a
# db8 wipe / reprovision).
#
# DEPLOY:  novacom -d topaz-linux put file:///media/internal/provision-media-perms.sh < deploy/provision-media-perms.sh
#          novacom -d topaz-linux run file:///bin/sh -- /media/internal/provision-media-perms.sh
set -e
APP=${1:-org.webosports.app.music}
OWNER=com.palm.filenotifyd.js
KINDS="com.palm.media.audio.file:1 com.palm.media.audio.artist:1 com.palm.media.audio.album:1 com.palm.media.audio.genre:1 com.palm.media.playlist.file:1"

PERMS=""
for k in $KINDS; do
	[ -n "$PERMS" ] && PERMS="$PERMS,"
	PERMS="$PERMS{\"type\":\"db.kind\",\"object\":\"$k\",\"caller\":\"$APP\",\"operations\":{\"read\":\"allow\"}}"
done

echo "granting media read to $APP (owner $OWNER)"
luna-send -a "$OWNER" -n 1 -f palm://com.palm.db/putPermissions "{\"permissions\":[$PERMS]}" </dev/null

echo "verify:"
for k in file artist album genre; do
	printf "  audio.%s -> " "$k"
	luna-send -a "$APP" -n 1 -f palm://com.palm.db/find \
		"{\"query\":{\"from\":\"com.palm.media.audio.$k:1\"},\"count\":true}" </dev/null \
		| grep -oE '"count":[0-9]+' || echo "DENIED"
done
