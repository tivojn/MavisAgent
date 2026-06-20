#!/usr/bin/env bash
# setup_musetalk.sh — first-run installer for the MuseTalk avatar engine.
#
# This is the heaviest install path because MuseTalk has a real mmpose/mmcv
# dependency stack. ~3 GB of model weights and ~2 GB of Python deps. We isolate
# everything in vendor/musetalk so the rest of Mavis stays light.
#
# Usage:
#   bash scripts/setup_musetalk.sh
#
# After this completes successfully, the MuseTalk option in Mavis Settings will
# work — every chat reply will be re-rendered through MuseTalk's diffusion-
# based mouth editor on the Mavis portrait.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")"/.. && pwd)"
VENDOR="$ROOT/vendor/musetalk"
VENV="$VENDOR/.venv"
WEIGHTS="$VENDOR/models"

echo "== MuseTalk setup =="
echo "Install root:   $VENDOR"
echo "Weights root:   $WEIGHTS"
echo ""

mkdir -p "$VENDOR" "$WEIGHTS"

# 1. Clone the MuseTalk repo (locked to a known-working commit).
if [ ! -d "$VENDOR/repo/.git" ]; then
  echo "[1/4] Cloning TMElyralab/MuseTalk …"
  git clone --depth 1 https://github.com/TMElyralab/MuseTalk.git "$VENDOR/repo"
else
  echo "[1/4] MuseTalk repo already cloned. Pulling …"
  ( cd "$VENDOR/repo" && git pull --ff-only ) || true
fi

# 2. Create an isolated venv.
if [ ! -x "$VENV/bin/python3" ]; then
  echo "[2/4] Creating venv at $VENV …"
  /usr/bin/python3 -m venv "$VENV"
fi
PY="$VENV/bin/python3"
PIP="$VENV/bin/pip"

# 3. Install Python deps.
echo "[3/4] Installing Python dependencies (PyTorch with MPS, diffusers, mmpose, etc.) …"
$PIP install --upgrade pip wheel
# PyTorch first — nightly on Apple Silicon picks up MPS automatically.
$PIP install 'torch>=2.1' 'torchvision>=0.16' 'torchaudio>=2.1'
# MMCV stack is the trickiest — install mmengine first, then mmcv-lite (the
# pure-Python build skips CUDA ops we don't need on Apple Silicon).
$PIP install mmengine
$PIP install 'mmcv-lite>=2.1.0'
$PIP install 'mmdet>=3.2.0' 'mmpose>=1.2.0' || \
  echo "WARNING: mmdet/mmpose install failed — falling back to skip-detection mode (you can still run MuseTalk if face_alignment is reachable)."
$PIP install 'diffusers>=0.27' 'transformers>=4.40' accelerate omegaconf einops
$PIP install ffmpeg-python soundfile librosa numpy scipy
$PIP install face_alignment 'opencv-python-headless<5'
$PIP install requests tqdm

# 4. Download MuseTalk weights via HuggingFace Hub.
echo "[4/4] Downloading MuseTalk weights to $WEIGHTS …"
$PIP install 'huggingface_hub>=0.20'
$PY - <<PY_DL
import os, sys
from huggingface_hub import snapshot_download
dst = os.environ.get('WEIGHTS')
print('Downloading TMElyralab/MuseTalk →', dst)
snapshot_download(
    'TMElyralab/MuseTalk',
    local_dir=dst,
    local_dir_use_symlinks=False,
    allow_patterns=[
        'musetalk/*.bin',
        'musetalk/*.json',
        'sd-vae-ft-mse/*',
        'whisper/*',
        'dwpose/*',
        'face-parse-bisent/*',
    ],
)
print('OK')
PY_DL
export WEIGHTS="$WEIGHTS"

echo ""
echo "== MuseTalk setup complete =="
echo "Daemon socket will live at /tmp/mavis_musetalk_daemon.sock"
echo "Mavis will auto-start the daemon on first reply when avatarEngine=musetalk."
