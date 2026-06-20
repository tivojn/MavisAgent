#!/usr/bin/env bash
# bake_musetalk.sh — talking-portrait via MuseTalk (audio-driven diffusion lipsync).
#
# Pipeline:
#   text  -> existing TTS engine (edge|kokoro|xai) -> WAV (48kHz mono)
#   audio -> MuseTalk daemon (UDS /tmp/mavis_musetalk_daemon.sock)
#         -> MP4 with edited mouth region on the Mavis portrait
#
# Wall-clock (M-series, MPS): ~8-15s warm for a 3-second reply, ~30s cold (model load).
# Falls back gracefully: if the daemon isn't installed/running, exits with a
# clear "setup required" message that main.js surfaces in the chat.
set -euo pipefail

REPLY_TEXT="${1:-}"
VOICE="${2:-en-US-AvaMultilingualNeural}"
OUTDIR="${3:-/tmp/mavis-musetalk}"
ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
PORTRAIT="${MAVIS_PORTRAIT:-$ROOT/renderer/assets/portrait.jpg}"
FPS="${MAVIS_FPS:-25}"
SOCK="/tmp/mavis_musetalk_daemon.sock"
VENV="$ROOT/vendor/musetalk/.venv"

if [ -z "$REPLY_TEXT" ]; then
  echo "usage: bake_musetalk.sh <text> [voice] [outdir]" >&2; exit 2
fi
mkdir -p "$OUTDIR"
ID="r$(date +%s)$RANDOM"
WAV="$OUTDIR/audio_${ID}.wav"
MP4="$OUTDIR/musetalk_${ID}.mp4"

# 1. Generate the audio using whatever TTS engine is active. We reuse the
#    existing UE bake script's TTS path by sourcing its top half... but that's
#    too tangled. Simpler: just call the right TTS binary directly.
TTS_ENGINE="${MAVIS_TTS:-edge}"
case "$TTS_ENGINE" in
  edge)
    EDGE_TTS="${EDGE_TTS_BIN:-/Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/edge-tts}"
    TMP_MP3="$OUTDIR/raw_${ID}.mp3"
    "$EDGE_TTS" --voice "$VOICE" --text "$REPLY_TEXT" --write-media "$TMP_MP3"
    /Users/zanearcher/.config/enconvo/bin/ffmpeg -y -loglevel error -i "$TMP_MP3" -ar 48000 -ac 1 -c:a pcm_s16le "$WAV"
    rm -f "$TMP_MP3"
    ;;
  kokoro)
    # Reach the persistent Kokoro daemon (already used by bake_reply.sh).
    KOK_SOCK=/tmp/mavis_kokoro_daemon.sock
    /Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/python3 -c "import socket, json, sys, os; s=socket.socket(socket.AF_UNIX); s.connect('$KOK_SOCK'); s.sendall((json.dumps({'cmd':'tts','text':sys.argv[1],'voice':sys.argv[2],'out':sys.argv[3]})+'\n').encode()); print(s.recv(4096).decode())" "$REPLY_TEXT" "${KOKORO_VOICE:-af_heart}" "$WAV"
    ;;
  xai)
    PY=/Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/python3
    TMP_MP3="$OUTDIR/raw_${ID}.mp3"
    TEXT="$REPLY_TEXT" VOICE="${XAI_VOICE:-ara}" ENDPOINT="${ENCONVO_API_URL:-http://localhost:54535}/tts/features/xai/create" \
      $PY -c 'import os,json,urllib.request; body=json.dumps({"text":os.environ["TEXT"],"voice":os.environ["VOICE"],"format":"mp3"}).encode(); req=urllib.request.Request(os.environ["ENDPOINT"], data=body, headers={"Content-Type":"application/json"}, method="POST"); resp=json.loads(urllib.request.urlopen(req, timeout=30).read()); print(resp["path"])' > "$OUTDIR/xai_path_${ID}"
    XAI_MP3=$(cat "$OUTDIR/xai_path_${ID}"); rm -f "$OUTDIR/xai_path_${ID}"
    /Users/zanearcher/.config/enconvo/bin/ffmpeg -y -loglevel error -i "$XAI_MP3" -ar 48000 -ac 1 -c:a pcm_s16le "$WAV"
    ;;
  *)
    echo "unknown TTS engine: $TTS_ENGINE" >&2; exit 3 ;;
esac

# 2. Auto-start the MuseTalk daemon if not already running.
if [ ! -S "$SOCK" ]; then
  if [ ! -x "$VENV/bin/python3" ]; then
    echo "MuseTalk not installed. Run: bash scripts/setup_musetalk.sh" >&2
    exit 10
  fi
  echo "Starting MuseTalk daemon…" >&2
  nohup "$VENV/bin/python3" "$(dirname "$0")/musetalk_daemon.py" \
    > "$OUTDIR/musetalk_daemon.log" 2>&1 &
  # Wait up to 60s for the daemon to bind the socket (model load is heavy).
  for i in $(seq 1 60); do
    [ -S "$SOCK" ] && break
    sleep 1
  done
  if [ ! -S "$SOCK" ]; then
    echo "MuseTalk daemon failed to start — see $OUTDIR/musetalk_daemon.log" >&2
    exit 11
  fi
fi

# 3. Send the bake request as one JSON line on the UDS, read the response.
REQ=$(printf '{"cmd":"bake","portrait":"%s","audio":"%s","out":"%s","fps":%s}' "$PORTRAIT" "$WAV" "$MP4" "$FPS")
RESP=$(printf '%s\n' "$REQ" | nc -U "$SOCK")
echo "$RESP" >&2
echo "$RESP" | /Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/python3 -c "import sys,json; r=json.loads(sys.stdin.read()); sys.exit(0 if r.get('ok') else 1); " && OK=1 || OK=0
if [ "$OK" != "1" ]; then
  echo "musetalk daemon error: $RESP" >&2; exit 12
fi

echo "$MP4"
