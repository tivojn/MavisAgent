#!/usr/bin/env python3
"""Send a Python script to the Mavis UE daemon and print its JSON response.

Usage:
  python3 ue_send.py path/to/script.py     # send a file
  python3 ue_send.py -                     # read script from stdin

Exit code 0 if {success: true}, else 1.
"""
import socket
import sys

SOCK_PATH = '/tmp/mavis_ue_daemon.sock'
TERMINATOR = b'\x00\x00END\x00\x00'

if len(sys.argv) < 2:
    sys.stderr.write('usage: ue_send.py <script_path|->\n')
    sys.exit(2)

arg = sys.argv[1]
code = sys.stdin.read() if arg == '-' else open(arg, 'r', encoding='utf-8').read()

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(120.0)
s.connect(SOCK_PATH)
s.sendall(code.encode('utf-8') + TERMINATOR)
buf = b''
while True:
    chunk = s.recv(65536)
    if not chunk:
        break
    buf += chunk
s.close()
resp = buf.decode('utf-8', errors='replace')
sys.stdout.write(resp)
import json
try:
    sys.exit(0 if json.loads(resp).get('success') else 1)
except Exception:
    sys.exit(1)
