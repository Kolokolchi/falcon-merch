"""Временный локальный приёмник: страница Flow отправляет сюда скачанный ролик (POST /save?name=NN),
файл сохраняется в папку Video. Слушает только 127.0.0.1."""
import sys, os, re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "https://flow.google.com")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        q = parse_qs(urlparse(self.path).query)
        name = re.sub(r"[^0-9A-Za-z_-]", "", q.get("name", ["x"])[0])[:40] or "x"
        n = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(n)
        with open(os.path.join(OUT, f"turn_{name}.mp4"), "wb") as f: f.write(data)
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(str(len(data)).encode())
    def log_message(self, *a): pass

HTTPServer(("127.0.0.1", 3021), H).serve_forever()
