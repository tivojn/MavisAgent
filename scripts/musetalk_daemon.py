#!/usr/bin/env python3
"""musetalk_daemon.py — persistent inference loop for the MuseTalk avatar engine.

MuseTalk is the closest open-source approximation to MetaHuman lipsync quality:
Whisper extracts audio features, a latent diffusion U-Net edits only the mouth
region of the source frames. ~5-10 fps on M-series via PyTorch MPS, so a 3s clip
takes ~10-20s warm.

We run it as a long-lived daemon over a UNIX domain socket (same pattern as
the UE 5.8 daemon and the Kokoro TTS daemon) so the heavy model load only
happens once. main.js spawns this if `~/...musetalk_daemon.sock` doesn't exist.

Protocol (JSON over UDS, newline-delimited):
  request:  {"cmd": "bake", "portrait": <abs path>, "audio": <abs WAV path>,
             "out": <abs MP4 path>, "fps": 25}
  response: {"ok": true, "out": <path>, "duration": <sec>}
             or {"ok": false, "error": <msg>}

First-use:
  bash scripts/setup_musetalk.sh
  python3 scripts/musetalk_daemon.py    # auto-starts on demand from Electron
"""
import json
import os
import socket
import socketserver
import subprocess
import sys
import time
import traceback
from pathlib import Path

VENDOR = Path(__file__).resolve().parent.parent / 'vendor' / 'musetalk'
REPO = VENDOR / 'repo'
VENV = VENDOR / '.venv'
WEIGHTS = VENDOR / 'models'
SOCK = '/tmp/mavis_musetalk_daemon.sock'

# Make sure we're running under the dedicated MuseTalk venv — if not, re-exec.
if not sys.executable.startswith(str(VENV)):
    py = VENV / 'bin' / 'python3'
    if py.exists():
        os.execv(str(py), [str(py), __file__] + sys.argv[1:])
    else:
        print(f'ERROR: MuseTalk venv missing at {VENV}. Run scripts/setup_musetalk.sh first.', file=sys.stderr)
        sys.exit(1)

# Add MuseTalk repo to path so we can `from musetalk import ...`.
sys.path.insert(0, str(REPO))

# `load_all_model()` upstream uses *relative* weight paths ("models/musetalkV15/unet.pth",
# "models/sd-vae/...", etc.) anchored at the process CWD. We chdir into the repo
# root and ensure `<repo>/models` resolves to our WEIGHTS dir via a symlink, so
# the upstream loader finds everything without code edits.
os.chdir(str(REPO))
_models_link = REPO / 'models'
if not _models_link.exists() and not _models_link.is_symlink():
    try:
        WEIGHTS.mkdir(parents=True, exist_ok=True)
        os.symlink(str(WEIGHTS), str(_models_link))
    except OSError as _e:
        print(f'[musetalk] WARN: could not link weights into repo: {_e}', file=sys.stderr)

# Heavy imports — done once at daemon startup so /bake calls are fast.
import torch
import numpy as np
import cv2
import soundfile as sf

DEVICE = 'mps' if torch.backends.mps.is_available() else 'cpu'
print(f'[musetalk] device = {DEVICE}', flush=True)

# These imports may fail if user hasn't run setup_musetalk.sh yet. We don't
# eagerly load weights here — only on first bake.
_models = None


def _load_models():
    global _models
    if _models is not None:
        return _models
    # MuseTalk's own loader — reads the unet/vae/whisper weights from disk.
    # The exact module path depends on the upstream commit.
    try:
        from musetalk.utils.utils import load_all_model  # type: ignore
    except Exception as e:
        raise RuntimeError(f'MuseTalk modules not importable: {e}. Run scripts/setup_musetalk.sh.')
    # Some versions of MuseTalk hard-code weight paths; we point WEIGHTS via env.
    os.environ.setdefault('MUSETALK_WEIGHTS', str(WEIGHTS))
    # Sanity-check that the upstream weights are present before invoking the
    # loader — otherwise the user gets HF's confusing "not a valid model id"
    # error instead of a clear "weights not downloaded" message.
    _required = [
        REPO / 'models' / 'musetalkV15' / 'unet.pth',
        REPO / 'models' / 'sd-vae' / 'diffusion_pytorch_model.bin',
        REPO / 'models' / 'whisper' / 'pytorch_model.bin',
    ]
    _missing = [str(p.relative_to(REPO)) for p in _required if not p.exists()]
    if _missing:
        raise RuntimeError(
            'MuseTalk weights not installed. Missing: '
            + ', '.join(_missing)
            + '. Run: bash scripts/setup_musetalk.sh (re-downloads via upstream download_weights.sh, ~3 GB).'
        )
    audio_processor, vae, unet, pe = load_all_model()
    if DEVICE == 'mps':
        vae = vae.to(DEVICE)
        unet.model = unet.model.to(DEVICE)
        pe = pe.to(DEVICE)
    _models = dict(audio_processor=audio_processor, vae=vae, unet=unet, pe=pe)
    print('[musetalk] models loaded', flush=True)
    return _models


def bake(portrait_path: str, audio_path: str, out_path: str, fps: int = 25) -> dict:
    """Run a single MuseTalk inference pass. Returns dict for the JSON response."""
    t0 = time.monotonic()
    if not os.path.exists(portrait_path):
        raise FileNotFoundError(f'portrait not found: {portrait_path}')
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f'audio not found: {audio_path}')

    models = _load_models()

    # 1. Read audio (16kHz mono for Whisper).
    waveform, sr = sf.read(audio_path)
    if sr != 16000:
        # MuseTalk's audio_processor expects 16kHz Whisper input.
        import librosa
        waveform = librosa.resample(waveform.astype(np.float32), orig_sr=sr, target_sr=16000)
        sr = 16000
    duration = float(len(waveform)) / sr
    n_frames = int(np.ceil(duration * fps))

    # 2. Whisper-extract per-frame audio features.
    whisper_feature = models['audio_processor'].audio2feat(audio_path)
    chunks = models['audio_processor'].feature2chunks(feature_array=whisper_feature, fps=fps)

    # 3. Detect face landmarks once on the still portrait, duplicate across frames.
    from musetalk.utils.preprocessing import get_landmark_and_bbox  # type: ignore
    coord_list, frame_list = get_landmark_and_bbox([portrait_path], upperbondrange=0)
    if not coord_list:
        raise RuntimeError('no face detected in portrait')
    # MuseTalk duplicates the single frame to match audio length.
    frame_list = (frame_list * n_frames)[:n_frames]
    coord_list = (coord_list * n_frames)[:n_frames]

    # 4. Diffusion inference — edits mouth region of each frame.
    from musetalk.utils.blending import get_image  # type: ignore
    vae, unet, pe = models['vae'], models['unet'], models['pe']
    edited_frames = []
    for i, (frame, coord, audio_chunk) in enumerate(zip(frame_list, coord_list, chunks)):
        # Crop face -> encode -> diffuse with audio condition -> decode -> blend back.
        x1, y1, x2, y2 = coord
        crop = frame[y1:y2, x1:x2]
        crop = cv2.resize(crop, (256, 256))
        # Tensor prep.
        crop_t = torch.from_numpy(crop).permute(2, 0, 1).unsqueeze(0).float() / 255.0
        crop_t = (crop_t - 0.5) / 0.5  # [-1,1]
        crop_t = crop_t.to(DEVICE)
        latent = vae.encode(crop_t).latent_dist.sample() * 0.18215
        audio_t = torch.from_numpy(audio_chunk).unsqueeze(0).to(DEVICE).float()
        # Run UNet conditional on audio.
        with torch.no_grad():
            pred_latents = unet.model(latent, 0, encoder_hidden_states=pe(audio_t)).sample
        decoded = vae.decode(pred_latents / 0.18215).sample
        decoded = ((decoded.clamp(-1, 1) + 1) * 127.5).cpu().permute(0, 2, 3, 1).numpy()[0].astype(np.uint8)
        decoded = cv2.resize(decoded, (x2 - x1, y2 - y1))
        blended = get_image(frame, decoded, coord)
        edited_frames.append(blended)

    # 5. Encode as MP4 + mux original audio.
    h, w = edited_frames[0].shape[:2]
    tmp_silent = out_path + '.silent.mp4'
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(tmp_silent, fourcc, fps, (w, h))
    for f in edited_frames:
        writer.write(cv2.cvtColor(f, cv2.COLOR_RGB2BGR))
    writer.release()
    ffmpeg = os.environ.get('FFMPEG_PATH', '/Users/zanearcher/.config/enconvo/bin/ffmpeg')
    subprocess.run([
        ffmpeg, '-y', '-loglevel', 'error',
        '-i', tmp_silent, '-i', audio_path,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
        '-c:a', 'aac', '-b:a', '128k', '-shortest', out_path,
    ], check=True)
    os.unlink(tmp_silent)

    return dict(ok=True, out=out_path, duration=duration, elapsed=time.monotonic() - t0)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            line = self.rfile.readline().decode('utf-8').strip()
            req = json.loads(line)
            if req.get('cmd') == 'ping':
                resp = dict(ok=True, pong=True, device=DEVICE)
            elif req.get('cmd') == 'bake':
                resp = bake(req['portrait'], req['audio'], req['out'], fps=req.get('fps', 25))
            else:
                resp = dict(ok=False, error=f"unknown cmd: {req.get('cmd')!r}")
        except Exception as e:
            resp = dict(ok=False, error=str(e), trace=traceback.format_exc()[-1500:])
        self.wfile.write((json.dumps(resp) + '\n').encode('utf-8'))


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    try:
        os.unlink(SOCK)
    except FileNotFoundError:
        pass
    print(f'[musetalk] listening on {SOCK}', flush=True)
    UnixServer(SOCK, Handler).serve_forever()
