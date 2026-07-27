#!/usr/bin/env bash
# Host-side: build the ARM backend, stage the account template + role + scripts,
# push to the TouchPad, and run the on-device installer. novacom is flaky, so
# every device call is retried and large files go via put (reliable) + md5 verify.
set -euo pipefail

DEVICE="${DEVICE:-topaz-linux}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/service"
DEPLOY="$ROOT/deploy"
GOROOT_BIN="${GOROOT_BIN:-/home/herrie/webos/gotool/go125/bin}"
STAGE_LOCAL="$(mktemp -d)"

nv(){ novacom -d "$DEVICE" "$@"; }
run(){ # run a shell command on device, with retries
  local tries=0
  until timeout 30 novacom -d "$DEVICE" run file:///bin/sh -- -c "$1" </dev/null; do
    tries=$((tries+1)); [ $tries -ge 4 ] && { echo "!! device run failed: $1"; return 1; }
    echo "  (retry $tries…)"; sleep 2
  done
}
push(){ # push $1(local) -> $2(device path), md5-verified
  local tries=0
  until timeout 60 novacom -d "$DEVICE" put "file://$2" < "$1"; do
    tries=$((tries+1)); [ $tries -ge 4 ] && { echo "!! push failed: $2"; return 1; }
    echo "  (retry $tries…)"; sleep 2
  done
  local want have
  want=$(md5sum "$1" | awk '{print $1}')
  have=$(run "md5sum '$2' 2>/dev/null | awk '{print \$1}'" | tr -d '\r')
  [ "$want" = "$have" ] || { echo "!! md5 mismatch on $2 ($want != $have)"; return 1; }
  echo "  ok $2 ($want)"
}

echo "== 1. build ARM backend =="
( cd "$SVC" && PATH="$GOROOT_BIN:$PATH" GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 \
    go build -o "$STAGE_LOCAL/spotify-webos-service" . )
echo "  built $(du -h "$STAGE_LOCAL/spotify-webos-service" | cut -f1)"

echo "== 2. stage payload =="
mkdir -p "$STAGE_LOCAL/mp-accounts"
cp -a "$DEPLOY/accounts"   "$STAGE_LOCAL/mp-accounts/"
cp -a "$DEPLOY/ls2-roles"  "$STAGE_LOCAL/mp-accounts/"
cp -f "$STAGE_LOCAL/spotify-webos-service" "$STAGE_LOCAL/mp-accounts/"
cp -f "$DEPLOY/ondevice-install-accounts.sh" "$DEPLOY/provision-spotify-account.sh" "$STAGE_LOCAL/mp-accounts/"
tar -C "$STAGE_LOCAL" -czf "$STAGE_LOCAL/mp-accounts.tar.gz" mp-accounts
echo "  staged $(du -h "$STAGE_LOCAL/mp-accounts.tar.gz" | cut -f1)"

echo "== 3. push payload =="
push "$STAGE_LOCAL/mp-accounts.tar.gz" /media/internal/mp-accounts.tar.gz

echo "== 4. unpack + run installer on device =="
run "cd /media/internal && rm -rf mp-accounts && tar -xzf mp-accounts.tar.gz && chmod +x mp-accounts/*.sh && sh mp-accounts/ondevice-install-accounts.sh"

echo "== 5. verify account type registered =="
run "luna-send -n 1 -a test palm://com.palm.service.accounts/listAccountTemplates '{}' | tr ',' '\n' | grep -i com.herrie.music || echo 'NOT REGISTERED'"

rm -rf "$STAGE_LOCAL"
echo "== deploy done. To create+verify an account headless, run on device: =="
echo "   sh /media/internal/mp-accounts/provision-spotify-account.sh"
