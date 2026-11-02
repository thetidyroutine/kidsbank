"""Serves docs/ on localhost with a fake Supabase client, so screens can be tested without real data."""
import http.server
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOCK = ROOT / "tools" / "mock_supabase.js"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "docs"), **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] == "/vendor/supabase.js":
            body = MOCK.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.ThreadingHTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
