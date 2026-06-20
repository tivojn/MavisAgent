#!/usr/bin/env python3
"""Persistent UE bridge daemon for Mavis Agent.

Problem: spinning up Python + UDP discovery + TCP connect for every bake costs
~1.2s of dead time per call (~20% of a 6s bake). Solution: keep a single
UnrealBridge connection alive in a daemon process; bake script sends scripts
to it over a Unix domain socket.

Protocol (each request is a single connection):
  CLIENT → DAEMON: <utf-8 python source> + b'\x00\x00END\x00\x00'
  DAEMON → CLIENT: <utf-8 json> of {success, output, result, error?, tb?}

Usage:
  nohup python3 ue_daemon.py >/tmp/mavis_ue_daemon.log 2>&1 &

Health check:
  python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/tmp/mavis_ue_daemon.sock'); s.close()"

Fault handling:
  If UE editor dies or the bridge throws, daemon reports error to client and
  attempts a reconnect on the NEXT request. Daemon stays alive across UE
  restarts.
"""
import json
import os
import socket
import sys
import time
import traceback

BRIDGE_DIR = '/Users/zanearcher/.agents/skills/UnrealEngine/bridge'
sys.path.insert(0, BRIDGE_DIR)
from ue_bridge import UnrealBridge, UnrealBridgeError  # noqa: E402

SOCK_PATH = '/tmp/mavis_ue_daemon.sock'
TERMINATOR = b'\x00\x00END\x00\x00'
MAX_SCRIPT_BYTES = 4 * 1024 * 1024  # 4MB — way more than we'll ever need


def log(msg):
    sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stdout.flush()


PREWARM_SCRIPT = '''
# One-time MRQ + MetaHumanPerformance subsystem prewarm — loads the editor
# subsystems, Movie Render Queue classes, and the reusable MHP asset BEFORE
# the first user bake. Saves ~500-800ms on the first warm bake by amortizing
# subsystem cold-start cost into daemon startup.
import unreal
try:
    unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level("/Game/Mavis/RenderLevel")
    EAL = unreal.EditorAssetLibrary
    perf_path = "/Game/Mavis/Performance/Perf_Reusable"
    perf = EAL.load_asset(perf_path)
    if perf is None:
        ATH = unreal.AssetToolsHelpers.get_asset_tools()
        perf = ATH.create_asset("Perf_Reusable", "/Game/Mavis/Performance",
                                 unreal.MetaHumanPerformance,
                                 unreal.MetaHumanPerformanceFactoryNew())
        perf.set_editor_property("input_type", unreal.DataInputType.AUDIO)
    EAL.load_asset("/Game/Mavis/MH/Unpacked/Mavis_Built/BP_Mavis_Built")
    unreal.log("[mavis-daemon] prewarm done")
except Exception as e:
    unreal.log_warning(f"[mavis-daemon] prewarm warning: {e}")
'''


def open_bridge():
    log("opening fresh UnrealBridge")
    b = UnrealBridge()
    b.connect()
    log("bridge connected")
    try:
        log("prewarming MRQ + RenderLevel + reusable MHP…")
        b.run(PREWARM_SCRIPT)
        log("prewarm complete")
    except Exception as e:
        log(f"prewarm skipped: {e}")
    return b


def handle_request(bridge, code):
    """Run code; on bridge failure try ONE reconnect transparently.

    No per-request 'pass' probe — that added ~200-300ms to every bake. The
    bridge stays warm for the editor's lifetime; we only reconnect lazily
    when an exception surfaces.
    """
    for attempt in (1, 2):
        try:
            r = bridge.run(code)
            return {
                'success': bool(r.get('success')),
                'output': r.get('output', ''),
                'result': str(r.get('result', '')),
            }, bridge
        except Exception as e:
            if attempt == 1:
                log(f"bridge run failed ({e}); reconnecting once")
                try:
                    bridge.close()
                except Exception:
                    pass
                try:
                    bridge = open_bridge()
                    continue
                except Exception as e2:
                    return {'success': False, 'error': f'reconnect failed: {e2}', 'tb': traceback.format_exc()[-600:]}, None
            return {'success': False, 'error': str(e), 'tb': traceback.format_exc()[-600:]}, None


def main():
    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    log(f"binding {SOCK_PATH}")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    srv.listen(8)
    os.chmod(SOCK_PATH, 0o600)
    log("connecting to UE…")
    bridge = None
    try:
        bridge = open_bridge()
    except Exception as e:
        log(f"initial UE connect failed ({e}); will retry on first request")

    log("ready")
    while True:
        try:
            conn, _ = srv.accept()
        except KeyboardInterrupt:
            log("shutdown")
            return
        try:
            # Read framed request
            buf = b''
            while TERMINATOR not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > MAX_SCRIPT_BYTES:
                    raise RuntimeError(f'script too large ({len(buf)} bytes)')
            if TERMINATOR not in buf:
                conn.sendall(b'{"success":false,"error":"no terminator"}')
                continue
            code = buf.split(TERMINATOR, 1)[0].decode('utf-8', errors='replace')
            if bridge is None:
                try:
                    bridge = open_bridge()
                except Exception as e:
                    conn.sendall(json.dumps({
                        'success': False,
                        'error': f'no UE connection: {e}',
                    }).encode('utf-8'))
                    continue
            resp, bridge = handle_request(bridge, code)
            conn.sendall(json.dumps(resp).encode('utf-8'))
        except Exception as e:
            try:
                conn.sendall(json.dumps({
                    'success': False,
                    'error': f'daemon error: {e}',
                    'tb': traceback.format_exc()[-400:],
                }).encode('utf-8'))
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == '__main__':
    main()
