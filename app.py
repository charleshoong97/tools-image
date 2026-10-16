import io
import math
import re
import time
import uuid
import zipfile
import threading

from flask import Flask, render_template, request, jsonify, send_file
from compressor import compress_image, CompressionError
from imaging import ImageProcessingError, FORMATS, EXTENSION_FORMATS
from bg_remover import remove_background
from watermark import add_watermark, remove_watermark, POSITIONS, TILE

app = Flask(__name__)

# ---------------------------------------------------------------------------
# In-memory session store
# { session_id: { "updated_at": float, "files": [ {...}, ... ] } }
# Each file entry holds the processed bytes plus what is needed to serve them.
# ---------------------------------------------------------------------------
_store: dict = {}
_store_lock = threading.Lock()

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20 MB
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png"}  # compressor
TOOL_EXTENSIONS = set(EXTENSION_FORMATS)     # background / watermark tools
SESSION_TTL = 30 * 60  # 30 minutes of inactivity

HEX_COLOR = re.compile(r"#([0-9a-fA-F]{6})")


def _cleanup():
    """Purge sessions idle for longer than SESSION_TTL. Reschedules itself every 10 min."""
    cutoff = time.time() - SESSION_TTL
    with _store_lock:
        expired = [sid for sid, s in _store.items() if s["updated_at"] < cutoff]
        for sid in expired:
            del _store[sid]
    t = threading.Timer(600, _cleanup)
    t.daemon = True
    t.start()


# Start the cleanup loop
_cleanup()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_upload(f, allowed_extensions):
    """Return (filename, bytes) of an upload, or raise ImageProcessingError."""
    filename = f.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in allowed_extensions:
        raise ImageProcessingError("Unsupported file type")

    raw = f.read()
    if len(raw) > MAX_FILE_SIZE:
        raise ImageProcessingError("File exceeds 20 MB limit")
    return filename, raw


def _output_name(original_name, suffix, fmt):
    """e.g. ("photo.jpeg", "compressed", "JPEG") -> "photo_compressed.jpeg".
    The extension is replaced only when the output format differs."""
    base, dot, ext = original_name.rpartition(".")
    if not dot:
        base, ext = original_name, ""
    if EXTENSION_FORMATS.get(ext.lower()) != fmt:
        ext = FORMATS[fmt][0]
    return f"{base}_{suffix}.{ext}"


def _store_result(session_id, data, original_name, suffix, fmt):
    """Keep a processed file for download; returns its id."""
    file_id = uuid.uuid4().hex[:12]
    entry = {
        "id": file_id,
        "data": data,
        "download_name": _output_name(original_name, suffix, fmt),
        "mimetype": FORMATS[fmt][1],
        "suffix": suffix,
    }
    with _store_lock:
        session = _store.setdefault(session_id, {"files": []})
        session["updated_at"] = time.time()
        session["files"].append(entry)
    return file_id


def _process_uploads(session_id, files, suffix, process):
    """Run process(raw_bytes, filename) -> result dict on each upload and
    store the outputs. Per-file failures are reported, not raised."""
    results = []
    errors = []

    for f in files:
        filename = f.filename or "upload"
        try:
            filename, raw = _read_upload(f, TOOL_EXTENSIONS)
            out = process(raw, filename)
        except ImageProcessingError as e:
            errors.append({"filename": filename, "error": str(e)})
            continue

        file_id = _store_result(session_id, out["output_bytes"], filename, suffix, out["format"])
        results.append({
            "id": file_id,
            "original_name": filename,
            "original_size": len(raw),
            "output_size": len(out["output_bytes"]),
            "width": out["width"],
            "height": out["height"],
            "format": out["format"],
        })

    return jsonify({"results": results, "errors": errors})


def _form_number(name, default, lo, hi):
    """A numeric form field clamped to [lo, hi], or default if missing/invalid."""
    try:
        value = float(request.form.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, value)) if math.isfinite(value) else default


def _watermark_options():
    """Parse the layout options shared by /add-watermark and its preview.
    Returns (options, error_message)."""
    position = request.form.get("position", "bottom-right")
    if position != TILE and position not in POSITIONS:
        return None, f"Unknown position '{position}'"
    return {
        "size": _form_number("size", 25, 1, 100),
        "opacity": _form_number("opacity", 50, 0, 100),
        "rotation": _form_number("rotation", 0, -180, 180),
        "position": position,
        "margin": _form_number("margin", 3, 0, 25),
        "spacing": _form_number("spacing", 10, 0, 50),
    }, None


def _read_stamp():
    """Return the watermark stamp bytes, or (None, error_message)."""
    stamp = request.files.get("stamp")
    if not stamp:
        return None, "No watermark provided"
    data = stamp.read()
    if len(data) > MAX_FILE_SIZE:
        return None, "Watermark image exceeds 20 MB limit"
    return data, None


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("compress.html", active="compress")


@app.get("/remove-background")
def remove_background_page():
    return render_template("remove_background.html", active="remove-background")


@app.get("/add-watermark")
def add_watermark_page():
    return render_template("add_watermark.html", active="add-watermark")


@app.get("/remove-watermark")
def remove_watermark_page():
    return render_template("remove_watermark.html", active="remove-watermark")


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------

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
        try:
            filename, raw = _read_upload(f, ALLOWED_EXTENSIONS)
            result = compress_image(raw, filename, quality)
        except (ImageProcessingError, CompressionError) as e:
            errors.append({"filename": filename, "error": str(e)})
            continue

        file_id = _store_result(
            session_id, result["compressed_bytes"], filename, "compressed", result["format"]
        )
        results.append({
            "id": file_id,
            "original_name": filename,
            "original_size": result["original_size"],
            "compressed_size": result["compressed_size"],
            "ratio": result["ratio"],
            "width": result["width"],
            "height": result["height"],
            "format": result["format"],
            "quality": quality,
        })

    return jsonify({"results": results, "errors": errors})


@app.post("/remove-background")
def remove_background_route():
    session_id = request.form.get("session_id", "").strip()
    if not session_id:
        return jsonify({"error": "Missing session_id"}), 400

    files = request.files.getlist("files[]")
    if not files:
        return jsonify({"error": "No files provided"}), 400

    background = request.form.get("background", "transparent")
    if background == "transparent":
        color = None
    else:
        match = HEX_COLOR.fullmatch(background)
        if not match:
            return jsonify({"error": "background must be 'transparent' or a #rrggbb color"}), 400
        color = tuple(int(match.group(1)[i:i + 2], 16) for i in (0, 2, 4))

    return _process_uploads(
        session_id, files, "no_bg",
        lambda raw, name: remove_background(raw, name, background=color),
    )


@app.post("/add-watermark")
def add_watermark_route():
    session_id = request.form.get("session_id", "").strip()
    if not session_id:
        return jsonify({"error": "Missing session_id"}), 400

    files = request.files.getlist("files[]")
    if not files:
        return jsonify({"error": "No files provided"}), 400

    stamp, error = _read_stamp()
    if error:
        return jsonify({"error": error}), 400
    options, error = _watermark_options()
    if error:
        return jsonify({"error": error}), 400

    return _process_uploads(
        session_id, files, "watermarked",
        lambda raw, name: add_watermark(raw, name, stamp, **options),
    )


@app.post("/add-watermark/preview")
def add_watermark_preview():
    """Render the watermark onto one (typically downscaled) image and return
    it directly, without storing anything."""
    upload = request.files.get("file")
    if not upload:
        return jsonify({"error": "No file provided"}), 400

    stamp, error = _read_stamp()
    if error:
        return jsonify({"error": error}), 400
    options, error = _watermark_options()
    if error:
        return jsonify({"error": error}), 400

    try:
        filename, raw = _read_upload(upload, TOOL_EXTENSIONS)
        out = add_watermark(raw, filename, stamp, **options)
    except ImageProcessingError as e:
        return jsonify({"error": str(e)}), 400

    return send_file(io.BytesIO(out["output_bytes"]), mimetype=FORMATS[out["format"]][1])


@app.post("/remove-watermark")
def remove_watermark_route():
    session_id = request.form.get("session_id", "").strip()
    if not session_id:
        return jsonify({"error": "Missing session_id"}), 400

    upload = request.files.get("file")
    mask = request.files.get("mask")
    if not upload or not mask:
        return jsonify({"error": "An image and a selection mask are required"}), 400

    mask_bytes = mask.read()
    if len(mask_bytes) > MAX_FILE_SIZE:
        return jsonify({"error": "Mask exceeds 20 MB limit"}), 400

    return _process_uploads(
        session_id, [upload], "no_watermark",
        lambda raw, name: remove_watermark(raw, name, mask_bytes),
    )


# ---------------------------------------------------------------------------
# Downloads & sessions
# ---------------------------------------------------------------------------

@app.route("/download/<session_id>/<file_id>")
def download_one(session_id, file_id):
    with _store_lock:
        session = _store.get(session_id)

    if not session:
        return jsonify({"error": "Session not found"}), 404

    entry = next((f for f in session["files"] if f["id"] == file_id), None)
    if not entry:
        return jsonify({"error": "File not found"}), 404

    # ?inline=1 serves the file for display (result previews) rather than as a download
    return send_file(
        io.BytesIO(entry["data"]),
        as_attachment=request.args.get("inline") != "1",
        download_name=entry["download_name"],
        mimetype=entry["mimetype"],
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
            arc_name = entry["download_name"]

            # De-duplicate names inside zip
            if arc_name in seen_names:
                seen_names[arc_name] += 1
                base2, dot2, ext2 = arc_name.rpartition(".")
                arc_name = f"{base2}_{seen_names[arc_name]}{dot2}{ext2}"
            else:
                seen_names[arc_name] = 0

            zf.writestr(arc_name, entry["data"])

    buf.seek(0)
    timestamp = int(time.time())
    return send_file(
        buf,
        as_attachment=True,
        download_name=f"{session['files'][0]['suffix']}_images_{timestamp}.zip",
        mimetype="application/zip",
    )


# POST is accepted because navigator.sendBeacon (used on page unload) can only POST.
@app.route("/session/<session_id>", methods=["DELETE", "POST"])
def delete_session(session_id):
    with _store_lock:
        _store.pop(session_id, None)
    return "", 204


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
