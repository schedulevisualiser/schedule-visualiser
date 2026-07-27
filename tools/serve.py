"""Local dev server for the Schedule Visualiser.

Same as `python -m http.server 8642` but sends no-cache headers, so the
browser always picks up edited files instead of silently running stale
cached JavaScript/CSS.

Run from the project root:  python tools/serve.py
"""

import http.server
import os
import sys

PORT = 8642


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    # always serve the project root, wherever the script is run from
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    http.server.test(HandlerClass=NoCacheHandler, port=port)
