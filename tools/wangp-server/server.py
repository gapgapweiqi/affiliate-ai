"""
Tiny HTTP front for WanGP (https://github.com/deepbeepmeep/Wan2GP) so the
bot — running in Docker — can ask the host GPU for product videos.

Uses WanGP's in-process Python API (shared/api.py). The model stays loaded
between requests; generations are serialized (one GPU).

Run with the WanGP venv:
    D:\\ai\\Wan2GP\\venv\\Scripts\\python tools\\wangp-server\\server.py

Env:
    WANGP_ROOT     WanGP checkout                 (default D:\\ai\\Wan2GP)
    WANGP_OUT      where mp4s are written         (default D:\\ai\\wangp-out)
    WANGP_HOST     bind address                   (default 127.0.0.1)
    WANGP_PORT     port                           (default 7870)
    WANGP_PROFILE  WanGP memory profile           (default 4 = low RAM/VRAM)

API:
    GET  /health                    -> {"ok": true, "model": ...}
    POST /generate                  JSON body:
         image_url  (required*) start frame, http(s)
         image_file (required*) …or a file this server already produced (OUT)
         prompt     (required)  motion/scene description (English works best)
         resolution (optional)  "WxH", default "480x832" (vertical)
         seconds    (optional)  default 3
         steps      (optional)  default from model (FastWan = 3)
         seed       (optional)
         protect_text (optional) default true — paste original text regions
                    back over every frame (see protect_text.py)
       -> {"job": "<id>"}            (returns immediately)
    GET  /jobs/<id>                 -> {"status": "queued|running|done|error",
                                        "file": "<name>.mp4", "seconds_taken": 123.4,
                                        "error": "..."}
    POST /task                      any WanGP settings dict, e.g. an image model:
         {"settings": {"model_type": "flux2_klein_4b", "prompt": ..., ...},
          "image_refs_files": ["<file in OUT>"], "image_refs_urls": [...],
          "image_start_url": "..."}
       -> {"job": "<id>"}  (result file may be .png/.jpg/.mp4)
    POST /upload?ext=mp3            raw body -> {"file": "<name>"} (e.g. a voiceover)
         /task also takes "image_start_file" / "audio_guide_file" (names in OUT)
    GET  /files/<name>              -> the file

Uses WanGP — see its Terms and Conditions.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(os.environ.get("WANGP_ROOT", r"D:\ai\Wan2GP"))
OUT = Path(os.environ.get("WANGP_OUT", r"D:\ai\wangp-out"))
HOST = os.environ.get("WANGP_HOST", "127.0.0.1")
PORT = int(os.environ.get("WANGP_PORT", "7870"))
PROFILE = os.environ.get("WANGP_PROFILE", "4")
MODEL = os.environ.get("WANGP_MODEL", "ti2v_2_2_fastwan")

OUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)  # WanGP resolves ckpts/, defaults/ relative to cwd

from shared.api import init  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
from protect_text import protect_text  # noqa: E402

print(f"[wangp-server] loading WanGP from {ROOT} (profile {PROFILE})", flush=True)
session = init(
    root=ROOT,
    output_dir=OUT,
    cli_args=["--attention", "sdpa", "--profile", PROFILE],
    console_output=True,
)
gpu_lock = threading.Lock()
jobs: dict[str, dict] = {}
SAFE_NAME = re.compile(r"^[\w.\-]+\.(mp4|png|jpg|jpeg|webp|mp3|wav)$")
MIME = {
    "mp4": "video/mp4", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "mp3": "audio/mpeg", "wav": "audio/wav",
}
MAX_UPLOAD = 50 * 1024 * 1024


def download(url: str) -> Path:
    if not re.match(r"^https?://", url):
        raise ValueError("image_url must be http(s)")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(20 * 1024 * 1024)
    suffix = ".png" if url.lower().endswith(".png") else ".jpg"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="wangp-in-")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return Path(path)


def local_copy(name: str) -> Path:
    src = OUT / name
    if not SAFE_NAME.match(name) or not src.is_file():
        raise ValueError(f"unknown image_file {name}")
    fd, path = tempfile.mkstemp(suffix=src.suffix, prefix="wangp-in-")
    with os.fdopen(fd, "wb") as f:
        f.write(src.read_bytes())
    return Path(path)


def run_settings(settings: dict, temp_files: list[Path]) -> tuple[Path, float]:
    """Run one WanGP task on the GPU; return (output file in OUT, seconds)."""
    started = time.time()
    try:
        with gpu_lock:
            result = session.submit_task(settings).result()
    finally:
        for p in temp_files:
            p.unlink(missing_ok=True)
    if not result.success or not result.generated_files:
        raise RuntimeError("; ".join(str(e) for e in result.errors) or "no output")
    produced = Path(result.generated_files[-1])
    # Normalise into OUT with a URL-safe name
    final = OUT / f"wangp-{int(started)}-{uuid.uuid4().hex[:6]}{produced.suffix.lower()}"
    produced.replace(final)
    return final, round(time.time() - started, 1)


def task(body: dict) -> dict:
    settings = dict(body.get("settings") or {})
    if not settings.get("model_type"):
        raise ValueError("settings.model_type is required")
    temps: list[Path] = []
    # Order matters for multi-reference prompts ("the woman from the first
    # image…"): server-side files first (e.g. a saved presenter), then URLs.
    refs = [local_copy(n) for n in body.get("image_refs_files") or []]
    refs += [download(u) for u in body.get("image_refs_urls") or []]
    if refs:
        temps += refs
        settings["image_refs"] = [str(p) for p in refs]
    if body.get("image_start_url"):
        p = download(body["image_start_url"])
        temps.append(p)
        settings["image_start"] = str(p)
    if body.get("image_start_file"):
        p = local_copy(body["image_start_file"])
        temps.append(p)
        settings["image_start"] = str(p)
    if body.get("audio_guide_file"):  # e.g. a voiceover sent via POST /upload
        p = local_copy(body["audio_guide_file"])
        temps.append(p)
        settings["audio_guide"] = str(p)
    final, secs = run_settings(settings, temps)
    return {"file": final.name, "seconds_taken": secs}


def generate(body: dict) -> dict:
    prompt = str(body.get("prompt") or "").strip()
    image_url = str(body.get("image_url") or "").strip()
    image_file = str(body.get("image_file") or "").strip()
    if not prompt or not (image_url or image_file):
        raise ValueError("prompt and image_url (or image_file) are required")

    image_path = local_copy(image_file) if image_file else download(image_url)
    settings: dict = {
        "model_type": MODEL,
        "prompt": prompt,
        "image_start": str(image_path),
        "resolution": str(body.get("resolution") or "480x832"),
        "video_length": f"{float(body.get('seconds') or 3):g}s",
    }
    if body.get("steps"):
        settings["num_inference_steps"] = int(body["steps"])
    if body.get("seed") is not None:
        settings["seed"] = int(body["seed"])

    try:
        final, secs = run_settings(settings, [])
        protected = 0
        if body.get("protect_text", True):
            protected = protect_text(final, image_path)
    finally:
        image_path.unlink(missing_ok=True)

    return {"file": final.name, "seconds_taken": secs, "text_boxes_protected": protected}


def run_job(job_id: str, fn, body: dict) -> None:
    try:
        if gpu_lock.locked():
            print(f"[wangp-server] job {job_id} waiting for GPU", flush=True)
        jobs[job_id] = {"status": "running"}
        jobs[job_id] = {"status": "done", **fn(body)}
    except Exception as e:  # noqa: BLE001
        jobs[job_id] = {"status": "error", "error": f"{type(e).__name__}: {e}"}
    print(f"[wangp-server] job {job_id} -> {jobs[job_id]}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": MODEL, "busy": gpu_lock.locked()})
        if self.path.startswith("/jobs/"):
            job = jobs.get(self.path[len("/jobs/"):])
            return self._json(200, job) if job else self._json(404, {"error": "unknown job"})
        if self.path.startswith("/files/"):
            name = self.path[len("/files/"):]
            path = OUT / name
            if not SAFE_NAME.match(name) or not path.is_file():
                return self._json(404, {"error": "not found"})
            self.send_response(200)
            self.send_header("Content-Type", MIME[path.suffix.lower().lstrip(".")])
            self.send_header("Content-Length", str(path.stat().st_size))
            self.end_headers()
            with path.open("rb") as f:
                while chunk := f.read(1 << 20):
                    self.wfile.write(chunk)
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/upload"):
            # POST /upload?ext=mp3  (raw body) -> {"file": "<name>"} in OUT
            ext = (re.search(r"[?&]ext=(\w+)", self.path) or [None, "mp3"])[1].lower()
            length = int(self.headers.get("Content-Length") or 0)
            name = f"upload-{int(time.time())}-{uuid.uuid4().hex[:6]}.{ext}"
            if ext not in MIME or not 0 < length <= MAX_UPLOAD:
                return self._json(400, {"error": "bad ext or size"})
            (OUT / name).write_bytes(self.rfile.read(length))
            return self._json(200, {"file": name})
        fn = {"/generate": generate, "/task": task}.get(self.path)
        if fn is None:
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if fn is generate and not body.get("prompt"):
                raise ValueError("prompt is required")
            if fn is task and not (body.get("settings") or {}).get("model_type"):
                raise ValueError("settings.model_type is required")
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        job_id = uuid.uuid4().hex[:12]
        jobs[job_id] = {"status": "queued"}
        threading.Thread(target=run_job, args=(job_id, fn, body), daemon=True).start()
        self._json(202, {"job": job_id})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[wangp-server] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"[wangp-server] listening on http://{HOST}:{PORT}  model={MODEL}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
