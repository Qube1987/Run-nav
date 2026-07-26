#!/usr/bin/env bash
# Compilation + lancement simulateur pour runnav-df.
#
# Prérequis : SDK Connect IQ 9.2.0 installé, et $CIQ_HOME pointant dessus
# (sinon on tente de le déduire de l'emplacement standard).
#
#   ./build.sh              compile
#   ./build.sh sim          compile puis lance le simulateur
#   ./build.sh fit <f.fit>  compile, lance le simulateur et rejoue une activité
#
# La clé développeur est générée automatiquement au premier appel si absente.

set -euo pipefail
cd "$(dirname "$0")"

DEVICE="${DEVICE:-fenix847mm}"
OUT="bin/runnav-df.prg"
KEY="developer_key.der"

# --- localisation du SDK ---
if [[ -z "${CIQ_HOME:-}" ]]; then
  for base in "$HOME/Library/Application Support/Garmin/ConnectIQ/Sdks" \
              "$HOME/.Garmin/ConnectIQ/Sdks" \
              "$APPDATA/Garmin/ConnectIQ/Sdks"; do
    if [[ -d "$base" ]]; then
      CIQ_HOME="$(ls -d "$base"/* 2>/dev/null | sort | tail -1)"
      break
    fi
  done
fi
if [[ -z "${CIQ_HOME:-}" || ! -x "$CIQ_HOME/bin/monkeyc" ]]; then
  echo "SDK introuvable. Renseigne CIQ_HOME, ex :" >&2
  echo "  export CIQ_HOME=\"\$HOME/Library/Application Support/Garmin/ConnectIQ/Sdks/connectiq-sdk-mac-9.2.0\"" >&2
  exit 1
fi
echo "SDK : $CIQ_HOME"

# --- clé développeur (gratuite, générée localement) ---
if [[ ! -f "$KEY" ]]; then
  echo "Génération de la clé développeur…"
  openssl genrsa -out developer_key.pem 4096 2>/dev/null
  openssl pkcs8 -topk8 -inform PEM -outform DER \
    -in developer_key.pem -out "$KEY" -nocrypt 2>/dev/null
  echo "  → $KEY (ne pas committer : déjà dans .gitignore)"
fi

mkdir -p bin
echo "Compilation pour $DEVICE…"
"$CIQ_HOME/bin/monkeyc" \
  -f monkey.jungle \
  -d "$DEVICE" \
  -o "$OUT" \
  -y "$KEY" \
  --warn
echo "OK → $OUT"

case "${1:-}" in
  sim)
    "$CIQ_HOME/bin/connectiq" &
    sleep 4
    "$CIQ_HOME/bin/monkeydo" "$OUT" "$DEVICE"
    ;;
  fit)
    [[ -n "${2:-}" ]] || { echo "usage : ./build.sh fit <activite.fit>" >&2; exit 1; }
    "$CIQ_HOME/bin/connectiq" &
    sleep 4
    "$CIQ_HOME/bin/monkeydo" "$OUT" "$DEVICE" "$2"
    ;;
esac
