import json
import os
import signal

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
print(json.dumps({'provider': os.getpid(), 'escaped': children}), flush=True)
while True:
    signal.pause()
