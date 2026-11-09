"""Laya companion server for pi-laya-model-router.

Protocol: newline-delimited JSON over a Unix socket.
  request:  {"id": str, "kind": "model_route", "text": str}
  response: {"id": str, "level": "low"|"medium"|"high", "confidence": float}
            or {"id": str, "error": str}

Routing: Laya's difficulty score (0 trivial .. 3 hard), bumped to "high" when the
request is security-sensitive.
"""
import json
import logging
import os
import socketserver
import threading

from laya import Router

SOCKET = os.environ.get("PI_LAYA_SOCKET", "/tmp/pi-laya-guardrails.sock")
LOW_BELOW = float(os.environ.get("LAYA_LOW_BELOW", "1.3"))
HIGH_FROM = float(os.environ.get("LAYA_HIGH_FROM", "2.0"))
SECURITY_FROM = float(os.environ.get("LAYA_SECURITY_FROM", "0.5"))
MAX_CHARS = 4000

QUESTIONS = {
    "difficulty": {
        "type": "score",
        "instructions": "How hard is `request` for a language model?",
        "criteria": [
            "trivial: a lookup or one-liner",
            "easy: short answer, no reasoning",
            "moderate: several steps",
            "hard: long multi-step reasoning or specialist knowledge",
        ],
    },
    "security": {
        "type": "noul",
        "instructions": "Does `request` involve security, authentication, credentials, permissions or vulnerabilities?",
    },
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("laya-server")

router = Router(default="english", max_loaded=2)
lock = threading.Lock()  # one forward pass at a time


def classify(text: str) -> dict:
    with lock:
        answers = router.predict({"request": text[:MAX_CHARS]}, QUESTIONS)["answers"]
    score = float(answers["difficulty"]["score"])
    security = float(answers["security"]["noul"])
    if score >= HIGH_FROM or security >= SECURITY_FROM:
        level = "high"
    elif score < LOW_BELOW:
        level = "low"
    else:
        level = "medium"
    confidence = float(answers["difficulty"].get("confidence", 0.0))
    log.info("level=%s difficulty=%.2f security=%.2f text=%r", level, score, security, text[:80])
    return {"level": level, "confidence": min(max(confidence, 0.0), 1.0)}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(1024 * 1024)
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            if req.get("kind") != "model_route":
                raise ValueError("unsupported kind %r" % req.get("kind"))
            resp = {"id": req_id, **classify(str(req.get("text") or ""))}
        except Exception as e:  # reply with an error so the client fails open
            log.exception("request failed")
            resp = {"id": req_id, "error": str(e)}
        self.wfile.write((json.dumps(resp) + "\n").encode())


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


if __name__ == "__main__":
    classify("warm up")
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with Server(SOCKET, Handler) as srv:
        os.chmod(SOCKET, 0o600)
        log.info("listening on %s", SOCKET)
        srv.serve_forever()
