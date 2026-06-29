"""
PaperMind Embedding Server
Loads tencent/Youtu-Embedding model and serves embedding requests via HTTP.
"""
import json
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler

# Use HF mirror for China
# Use official HF endpoint (hf-mirror.com unreliable for Python HTTP)

MODEL_NAME = "tencent/Youtu-Embedding"
PORT = 9092
model = None

def load_model():
    global model
    from sentence_transformers import SentenceTransformer
    print(f"[embedding-server] Loading {MODEL_NAME}...", file=sys.stderr)
    model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
    print(f"[embedding-server] Model loaded. Dims: {model.get_sentence_embedding_dimension()}", file=sys.stderr)


class EmbeddingHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/embed":
            try:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length))
                texts = body.get("texts", [])
                if not texts:
                    self.send_error(400, "texts required")
                    return
                embeddings = model.encode(texts, normalize_embeddings=True)
                result = {"embeddings": [e.tolist() for e in embeddings]}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            except Exception as e:
                self.send_error(500, str(e))
        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode())
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass  # suppress HTTP logs


if __name__ == "__main__":
    load_model()
    server = HTTPServer(("127.0.0.1", PORT), EmbeddingHandler)
    print(f"[embedding-server] Ready on port {PORT}", file=sys.stderr)
    server.serve_forever()
