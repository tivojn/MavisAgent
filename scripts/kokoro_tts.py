#!/usr/bin/env python3
"""Mavis local TTS via Kokoro-82M PyTorch.

Usage:
    kokoro_tts.py <text> <voice> <out.wav>

Kokoro on PyTorch is ~3s cold-start + 0.6s synth for a short phrase. Since
MavisAgent bakes a fresh reply per IPC call, we run a Unix-socket daemon to keep
the KPipeline loaded between bakes. Same pattern as the UE daemon.

Socket: /tmp/mavis_kokoro_daemon.sock
Protocol: send framed `<voice>\x1f<text>\x00\x00END\x00\x00` ; recv `OK <out>` or `ERR <msg>`.
Client (this script in client mode) writes the WAV to the requested path.
"""
from __future__ import annotations
import os, sys, socket, subprocess, time, struct

SOCK_PATH = '/tmp/mavis_kokoro_daemon.sock'
LOG_PATH = '/tmp/mavis_kokoro_daemon.log'
TERM = b'\x00\x00END\x00\x00'
VENV_PY = '/Users/zanearcher/.enconvo/workspace/agent-main/.venv/bin/python3'


def start_daemon_if_needed():
    if os.path.exists(SOCK_PATH):
        try:
            s = socket.socket(socket.AF_UNIX)
            s.settimeout(0.3); s.connect(SOCK_PATH); s.close()
            return
        except Exception:
            try: os.unlink(SOCK_PATH)
            except FileNotFoundError: pass
    env = os.environ.copy()
    env['MAVIS_KOKORO_DAEMON_MODE'] = '1'
    subprocess.Popen([VENV_PY, __file__], env=env, stdout=open(LOG_PATH, 'a'),
                     stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(80):  # 8s
        if os.path.exists(SOCK_PATH):
            try:
                s = socket.socket(socket.AF_UNIX); s.settimeout(0.3); s.connect(SOCK_PATH); s.close(); return
            except Exception: pass
        time.sleep(0.1)
    raise RuntimeError(f'kokoro daemon failed to bind {SOCK_PATH}')


def client(text: str, voice: str, out_path: str) -> None:
    start_daemon_if_needed()
    payload = f'{voice}\x1f{out_path}\x1f{text}'.encode('utf-8') + TERM
    s = socket.socket(socket.AF_UNIX); s.settimeout(60.0); s.connect(SOCK_PATH)
    s.sendall(payload)
    buf = b''
    while True:
        chunk = s.recv(4096)
        if not chunk: break
        buf += chunk
        if buf.endswith(TERM): break
    s.close()
    resp = buf[:-len(TERM)].decode('utf-8', errors='replace') if buf.endswith(TERM) else buf.decode('utf-8', errors='replace')
    if not resp.startswith('OK'):
        raise RuntimeError(f'kokoro daemon error: {resp}')


def daemon() -> None:
    import logging
    logging.basicConfig(format='[%(asctime)s] %(message)s', level=logging.INFO)
    log = logging.info
    log('kokoro daemon starting; loading KPipeline…')
    t0 = time.time()
    # Lazy import — also covers any startup error in the log.
    import warnings; warnings.filterwarnings('ignore')
    import soundfile as sf
    from kokoro import KPipeline
    import numpy as np
    pipeline = KPipeline(lang_code='a')  # American English / Kokoro v1
    log(f'KPipeline ready in {time.time()-t0:.2f}s')

    if os.path.exists(SOCK_PATH):
        try: os.unlink(SOCK_PATH)
        except FileNotFoundError: pass
    srv = socket.socket(socket.AF_UNIX); srv.bind(SOCK_PATH); srv.listen(8)
    log('listening')

    while True:
        try:
            cli, _ = srv.accept()
            cli.settimeout(60.0)
            buf = b''
            while True:
                ch = cli.recv(4096)
                if not ch: break
                buf += ch
                if buf.endswith(TERM): break
            if not buf.endswith(TERM):
                cli.sendall(b'ERR no-terminator' + TERM); cli.close(); continue
            body = buf[:-len(TERM)].decode('utf-8', errors='replace')
            try:
                voice, out_path, text = body.split('\x1f', 2)
            except ValueError:
                cli.sendall(b'ERR bad-format' + TERM); cli.close(); continue
            t1 = time.time()
            try:
                chunks = []
                for result in pipeline(text, voice=voice, speed=1.0):
                    a = result.audio
                    chunks.append(a.numpy() if hasattr(a, 'numpy') else a)
                audio = np.concatenate(chunks) if chunks else np.zeros(0)
                sf.write(out_path, audio, 24000)
                log(f'synth {voice} "{text[:30]}…" -> {out_path} in {time.time()-t1:.2f}s')
                cli.sendall(f'OK {out_path}'.encode() + TERM)
            except Exception as e:
                log(f'synth error: {e}')
                cli.sendall(f'ERR {e}'.encode() + TERM)
            cli.close()
        except Exception as e:
            log(f'accept loop error: {e}')
            time.sleep(0.5)


if __name__ == '__main__':
    if os.environ.get('MAVIS_KOKORO_DAEMON_MODE') == '1':
        daemon()
    else:
        if len(sys.argv) != 4:
            print('usage: kokoro_tts.py <text> <voice> <out.wav>', file=sys.stderr); sys.exit(2)
        client(sys.argv[1], sys.argv[2], sys.argv[3])
