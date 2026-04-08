import io
import time
import uuid
import zipfile
import threading

from flask import Flask, render_template, request, jsonify, send_file
from compressor import compress_image, CompressionError

app = Flask(__name__)

# ---------------------------------------------------------------------------
# In-memory session store
# { session_id: { "created_at": float, "files": [ {...}, ... ] } }
# ---------------------------------------------------------------------------
_store: dict = {}
_store_lock = threading.Lock()

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png"}
SESSION_TTL = 30 * 60  # 30 minutes


def _cleanup():
    """Purge sessions older than SESSION_TTL. Reschedules itself every 10 min."""
    cutoff = time.time() - SESSION_TTL
    with _store_lock:
        expired = [sid for sid, s in _store.items() if s["created_at"] < cutoff]
        for sid in expired:
            del _store[sid]
    t = threading.Timer(600, _cleanup)
    t.daemon = True
    t.start()


# Start the cleanup loop
_cleanup()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/compress", methods=["POST"])
def compress():
    session_id = request.form.get("session_id", "").strip()
    if not session_id:
        return jsonify({"error": "Missing session_id"}), 400

    try:
        quality = int(request.form.get("quality", 75))
        quality = max(1, min(100, quality))
    except (TypeError, ValueError):
        quality = 75

    files = request.files.getlist("files[]")
    if not files:
        return jsonify({"error": "No files provided"}), 400

    results = []
    errors = []

    for f in files:
        filename = f.filename or "upload"
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

        if ext not in ALLOWED_EXTENSIONS:
            errors.append({"filename": filename, "error": "Unsupported file type"})
            continue

        raw = f.read()
        if len(raw) > MAX_FILE_SIZE:
            errors.append({"filename": filename, "error": "File exceeds 20 MB limit"})
            continue

        try:
            result = compress_image(raw, filename, quality)
        except CompressionError as e:
            errors.append({"filename": filename, "error": str(e)})
            continue

        file_id = uuid.uuid4().hex[:12]
        entry = {
            "id": file_id,
            "original_name": filename,
            "original_size": result["original_size"],
            "compressed_size": result["compressed_size"],
            "compressed_bytes": result["compressed_bytes"],
            "ratio": result["ratio"],
            "width": result["width"],
            "height": result["height"],
            "format": result["format"],
            "quality": quality,
        }

        with _store_lock:
            if session_id not in _store:
                _store[session_id] = {"created_at": time.time(), "files": []}
            _store[session_id]["files"].append(entry)

        results.append({k: v for k, v in entry.items() if k != "compressed_bytes"})

    return jsonify({"results": results, "errors": errors})


@app.route("/download/<session_id>/<file_id>")
def download_one(session_id, file_id):
    with _store_lock:
        session = _store.get(session_id)

    if not session:
        return jsonify({"error": "Session not found"}), 404

    entry = next((f for f in session["files"] if f["id"] == file_id), None)
    if not entry:
        return jsonify({"error": "File not found"}), 404

    name = entry["original_name"]
    base, dot, ext = name.rpartition(".")
    download_name = f"{base}_compressed{dot}{ext}" if dot else f"{name}_compressed"

    return send_file(
        io.BytesIO(entry["compressed_bytes"]),
        as_attachment=True,
        download_name=download_name,
        mimetype="image/jpeg" if entry["format"] == "JPEG" else "image/png",
    )


@app.route("/download-all/<session_id>")
def download_all(session_id):
    with _store_lock:
        session = _store.get(session_id)

    if not session or not session["files"]:
        return jsonify({"error": "Session not found or empty"}), 404

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        seen_names: dict = {}
        for entry in session["files"]:
            name = entry["original_name"]
            base, dot, ext = name.rpartition(".")
            arc_name = f"{base}_compressed{dot}{ext}" if dot else f"{name}_compressed"

            # De-duplicate names inside zip
            if arc_name in seen_names:
                seen_names[arc_name] += 1
                base2, dot2, ext2 = arc_name.rpartition(".")
                arc_name = f"{base2}_{seen_names[arc_name]}{dot2}{ext2}"
            else:
                seen_names[arc_name] = 0

            zf.writestr(arc_name, entry["compressed_bytes"])

    buf.seek(0)
    timestamp = int(time.time())
    return send_file(
        buf,
        as_attachment=True,
        download_name=f"compressed_images_{timestamp}.zip",
        mimetype="application/zip",
    )


@app.route("/session/<session_id>", methods=["DELETE"])
def delete_session(session_id):
    with _store_lock:
        _store.pop(session_id, None)
    return "", 204


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
