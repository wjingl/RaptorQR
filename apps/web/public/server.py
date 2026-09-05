#!/usr/bin/env python3
"""Transfer Hub portable static server.

Cross-platform (Windows / macOS / Linux). Uses only the Python 3 standard
library, serves the folder this file lives in, binds to an OS-assigned free
localhost port (never a fixed port such as 8080), opens the default browser,
and runs until Ctrl-C.
"""
import http.server
import mimetypes
import os
import socketserver
import sys
import threading
import webbrowser

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/manifest+json", ".webmanifest")

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def pick_port():
    socketserver.TCPServer.allow_reuse_address = True
    # Let the OS allocate a free localhost port (never a fixed port like 8080).
    server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    return server, server.server_address[1]


def main():
    server, port = pick_port()
    url = "http://127.0.0.1:%d/" % port
    print("")
    print("  Transfer Hub portable server started")
    print("  Local URL: %s" % url)
    print("  To share on your LAN, other devices need HTTPS for the camera;")
    print("  press Ctrl-C to stop.")
    print("")
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
