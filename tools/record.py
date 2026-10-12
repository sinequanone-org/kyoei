#!/usr/bin/env python3
"""Record a terminal command to an asciicast v2 file, byte for byte.

Usage:
  python3 tools/record.py OUT.cast [--cols 120 --rows 36] -- COMMAND [ARGS...]
  python3 tools/record.py --check OUT.cast

The recorder runs COMMAND in a pseudo-terminal and writes every output chunk
with its time offset. It never edits or retimes output. --check validates a
recording: header, monotonic times, valid UTF-8, and no bearer secrets.
Standard library only.
"""

import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

SECRET = re.compile(r"art_v1_[0-9a-f]{20,}|adm_[0-9a-f]{20,}|ns_[0-9a-f]{20,}|Bearer\s+\S{20,}")


def record(out_path, cols, rows, argv):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["COLUMNS"], os.environ["LINES"] = str(cols), str(rows)
        os.execvp(argv[0], argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    start = time.monotonic()
    header = {"version": 2, "width": cols, "height": rows, "timestamp": int(time.time()),
              "env": {"TERM": os.environ.get("TERM", "xterm-256color")}, "command": " ".join(argv)}
    decoder = __import__("codecs").getincrementaldecoder("utf-8")("replace")
    with open(out_path, "w", encoding="utf-8") as out:
        out.write(json.dumps(header) + "\n")
        while True:
            try:
                ready, _, _ = select.select([fd], [], [], 0.5)
                if not ready:
                    if os.waitpid(pid, os.WNOHANG)[0]:
                        break
                    continue
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            text = decoder.decode(data)
            if text:
                out.write(json.dumps([round(time.monotonic() - start, 6), "o", text]) + "\n")
                out.flush()
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


def check(path):
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    header = json.loads(lines[0])
    assert header.get("version") == 2 and header["width"] > 0 and header["height"] > 0, "bad header"
    last = -1.0
    leaks = 0
    for n, line in enumerate(lines[1:], 2):
        t, kind, text = json.loads(line)
        assert kind == "o", f"line {n}: unexpected event kind {kind}"
        assert t >= last, f"line {n}: time goes backwards"
        last = t
        leaks += len(SECRET.findall(text))
    print(json.dumps({"file": path, "events": len(lines) - 1, "seconds": round(last, 3), "secret_matches": leaks}))
    return 0 if leaks == 0 else 1


def main():
    args = sys.argv[1:]
    if args[:1] == ["--check"]:
        return check(args[1])
    if "--" not in args:
        print(__doc__)
        return 2
    opts, argv = args[:args.index("--")], args[args.index("--") + 1:]
    out_path = opts[0]
    cols = int(opts[opts.index("--cols") + 1]) if "--cols" in opts else 120
    rows = int(opts[opts.index("--rows") + 1]) if "--rows" in opts else 36
    code = record(out_path, cols, rows, argv)
    check(out_path)
    return code


if __name__ == "__main__":
    sys.exit(main())
