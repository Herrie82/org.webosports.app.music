#!/bin/sh
# Runs ON the TouchPad. Headless PoC substitute for the Accounts-app "Add account"
# UI: creates a Spotify account of type com.herrie.music.spotify and stores the
# EXISTING working token (/media/internal/spotify-token.json) as its credentials.
# Then reads it back to prove the backend's account path.
#
# The exact addAccount signature varies across webOS builds, so this prints every
# raw reply — if addAccount is rejected, copy the reply here and we adapt.
set -e
TEMPLATE=com.herrie.music.spotify
TOKENFILE=/media/internal/spotify-token.json
A(){ luna-send -n 1 -a com.herrie.musicspotify.service "$@"; }

echo "== 1. is our account type registered? =="
A palm://com.palm.service.accounts/listAccountTemplates '{}' | tr ',' '\n' | grep -i "$TEMPLATE" || \
    echo "!! template not listed — run ondevice-install-accounts.sh first"

echo "== 2. read existing token file -> credential fields =="
if [ ! -f "$TOKENFILE" ]; then echo "!! no $TOKENFILE (log in first)"; exit 1; fi
# oauth2.Token json uses access_token/refresh_token/expiry
AT=$(sed -n 's/.*"access_token"[ :]*"\([^"]*\)".*/\1/p'  "$TOKENFILE" | head -1)
RT=$(sed -n 's/.*"refresh_token"[ :]*"\([^"]*\)".*/\1/p' "$TOKENFILE" | head -1)
EX=$(sed -n 's/.*"expiry"[ :]*"\([^"]*\)".*/\1/p'        "$TOKENFILE" | head -1)
echo "access_token=${AT%${AT#?????}}…  refresh_token set=$([ -n "$RT" ] && echo yes)  expiry=$EX"

echo "== 3. create the account =="
ADD=$(A palm://com.palm.service.accounts/addAccount "{\"templateId\":\"$TEMPLATE\",\"username\":\"spotify\"}" 2>&1)
echo "addAccount reply: $ADD"
AID=$(echo "$ADD" | sed -n 's/.*"accountId"[ :]*"\([^"]*\)".*/\1/p' | head -1)
[ -z "$AID" ] && AID=$(echo "$ADD" | sed -n 's/.*"_id"[ :]*"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$AID" ]; then echo "!! no accountId parsed — see reply above; adapt addAccount signature"; exit 1; fi
echo "accountId=$AID"

echo "== 4. store token as the account's 'common' credentials =="
CREDS="{\"accountId\":\"$AID\",\"name\":\"common\",\"credentials\":{\"common\":{\"accessToken\":\"$AT\",\"refreshToken\":\"$RT\",\"expiry\":\"$EX\"}}}"
A palm://com.palm.service.accounts/writeCredentials "$CREDS"

echo "== 5. read it back (proves the backend's readCredentials path) =="
A palm://com.palm.service.accounts/readCredentials "{\"accountId\":\"$AID\",\"name\":\"common\"}"

echo "== 6. list music accounts =="
A palm://com.palm.service.accounts/listAccounts '{}'
echo "== DONE =="
