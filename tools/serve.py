#!/usr/bin/env python3
"""Local preview server with HTTP Range support (needed for seeking/resume).

    python3 tools/serve.py [port]      then open http://localhost:8000

Python's built-in `http.server` can't serve byte ranges, so videos wouldn't
seek or resume properly. GitHub Pages does support them; this mimics it.
"""
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(SimpleHTTPRequestHandler):
    _range_len = None

    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng or "")
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start, end = m.groups()
        if start == "":
            if end == "":
                return super().send_head()
            start, end = max(0, size - int(end)), size - 1
        else:
            start, end = int(start), min(int(end) if end else size - 1, size - 1)
        if start > end or start >= size:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_len = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        n, self._range_len = self._range_len, None
        try:
            if n is None:
                return super().copyfile(source, outputfile)
            while n > 0:
                chunk = source.read(min(65536, n))
                if not chunk:
                    break
                outputfile.write(chunk)
                n -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser cancelled the request (normal while seeking)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving {ROOT} at http://localhost:{port}  (Ctrl+C to stop)")
    ThreadingHTTPServer(("", port), partial(Handler, directory=ROOT)).serve_forever()
