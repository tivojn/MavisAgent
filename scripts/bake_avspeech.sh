#!/usr/bin/env bash
# bake_avspeech.sh — "talking portrait" mode, fully native macOS
#
# Pipeline (no UE, no models, no network):
#   text -> macOS `say` (AVSpeechSynthesizer under the hood) -> AIFF
#         -> ffmpeg -> 48kHz mono PCM WAV
#         -> stdout: absolute path to .wav
#
# The renderer then plays the WAV in a <audio> element while running a Web
# Audio AnalyserNode over the same audio in real time. F1/F2/HF formant energy
# drives an SVG mouth-morph overlaid on the Mavis portrait — real phoneme-
# aware visemes (jaw open from F1, lip round/spread from F2, teeth-show from HF)
# without any alignment step.
#
# Wall-clock: 0.3–0.6s for a 1–3 sentence reply. No GPU. No model downloads.
set -euo pipefail

REPLY_TEXT="${1:-}"
VOICE_NAME="${2:-Samantha}"     # macOS say voice. Samantha ships on every Mac.
OUTDIR="${3:-/tmp/mavis-avspeech}"
FFMPEG="${FFMPEG_PATH:-/Users/zanearcher/.config/enconvo/bin/ffmpeg}"
[ -x "$FFMPEG" ] || FFMPEG="$(command -v ffmpeg || true)"
[ -x "$FFMPEG" ] || { echo "ffmpeg not found" >&2; exit 1; }

if [ -z "$REPLY_TEXT" ]; then
  echo "usage: bake_avspeech.sh <text> [voice=Samantha] [outdir]" >&2; exit 2
fi

mkdir -p "$OUTDIR"
ID="r$(date +%s)$RANDOM"
AIFF="$OUTDIR/raw_${ID}.aiff"
WAV="$OUTDIR/avspeech_${ID}.wav"

# `say` writes a high-quality 22050Hz AIFF. -r controls speech rate (words/min).
# Default Samantha is 175wpm — we nudge to 185 for Mavis's brisker register.
# Voices that are NOT installed will be ignored silently; we re-run with the
# safe Samantha fallback if needed.
if ! say -v "$VOICE_NAME" -r 185 -o "$AIFF" "$REPLY_TEXT" 2>/dev/null; then
  say -r 185 -o "$AIFF" "$REPLY_TEXT"
fi

# Convert to a clean 48kHz mono PCM WAV. Renderer audio-graph works best with
# the same sample rate the AudioContext is initialized at (Mac default 48kHz).
# loglevel error so the path on stdout stays clean for Node to consume.
"$FFMPEG" -y -loglevel error -i "$AIFF" -ar 48000 -ac 1 -c:a pcm_s16le "$WAV"
rm -f "$AIFF"

# Final line of stdout must be the absolute WAV path (main.js reads .pop()).
echo "$WAV"
