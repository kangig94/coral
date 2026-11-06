import json
import os
import signal
import sys

children = []
for session in (True, False):
    reader, writer = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(reader)
        if session:
            os.setsid()
        else:
            os.setpgid(0, 0)
        os.write(writer, b'ready')
        os.close(writer)
        while True:
            signal.pause()
    os.close(writer)
    assert os.read(reader, 5) == b'ready'
    os.close(reader)
    children.append(pid)
payload = {'provider': os.getpid(), 'escaped': children}
if '--jsonrpc' in sys.argv:
    payload = {'jsonrpc': '2.0', 'method': 'test.ready', 'params': payload}
print(json.dumps(payload), flush=True)
while True:
    signal.pause()
