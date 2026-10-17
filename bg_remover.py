"""Background removal using the U²-Net family of segmentation models.

The models are the ONNX exports published by the rembg project. They are run
directly through onnxruntime rather than via rembg itself, which would pull in
scipy, scikit-image and numba and push memory past a 512 MB instance.

Configuration (environment variables):
    BG_REMOVAL_MODEL      u2netp (default), silueta, u2net or isnet-general-use
    BG_REMOVAL_MODEL_DIR  where models are cached (default: ./models)

Run `python bg_remover.py` to download the configured model ahead of time
(the build step does this); otherwise it is downloaded on first use.
"""
import hashlib
import logging
import os
import threading
import urllib.request

import numpy as np
import onnxruntime as ort
from PIL import Image

from imaging import ImageProcessingError, encode_image, open_image

log = logging.getLogger(__name__)

MODEL_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/{name}.onnx"

_U2NET_NORM = ((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))

# name -> (sha256, input size, (mean, std)). Approximate peak memory of the
# whole app while processing an image is noted for sizing the instance.
MODELS = {
    # 4.6 MB, ~340 MB peak: fits a 512 MB instance
    "u2netp": ("309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8", 320, _U2NET_NORM),
    # 44 MB, ~500 MB peak
    "silueta": ("75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb", 320, _U2NET_NORM),
    # 176 MB, ~550 MB peak
    "u2net": ("8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491", 320, _U2NET_NORM),
    # 179 MB, ~800 MB peak: best edges and multi-subject handling
    "isnet-general-use": (
        "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a",
        1024,
        ((0.5, 0.5, 0.5), (1.0, 1.0, 1.0)),
    ),
}

MODEL_NAME = os.environ.get("BG_REMOVAL_MODEL", "u2netp")
if MODEL_NAME not in MODELS:
    raise ValueError(
        f"Unknown BG_REMOVAL_MODEL '{MODEL_NAME}'; choose one of: {', '.join(MODELS)}"
    )

MODEL_DIR = os.environ.get(
    "BG_REMOVAL_MODEL_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"),
)

_session = None
_session_lock = threading.Lock()


def ensure_model() -> str:
    """Return the local path of the configured model, downloading it if needed."""
    path = os.path.join(MODEL_DIR, f"{MODEL_NAME}.onnx")
    if os.path.exists(path):
        return path

    os.makedirs(MODEL_DIR, exist_ok=True)
    url = MODEL_URL.format(name=MODEL_NAME)
    log.info("Downloading background removal model %s from %s", MODEL_NAME, url)

    tmp_path = path + ".part"
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=60) as resp, open(tmp_path, "wb") as out:
        for chunk in iter(lambda: resp.read(1 << 20), b""):
            digest.update(chunk)
            out.write(chunk)

    if digest.hexdigest() != MODELS[MODEL_NAME][0]:
        os.remove(tmp_path)
        raise RuntimeError(f"Checksum mismatch for downloaded model {MODEL_NAME}")

    os.replace(tmp_path, path)
    return path


def _get_session() -> ort.InferenceSession:
    global _session
    with _session_lock:
        if _session is None:
            try:
                model_path = ensure_model()
            except Exception as e:
                log.exception("Background removal model unavailable")
                raise ImageProcessingError(f"Background removal model is unavailable: {e}")

            opts = ort.SessionOptions()
            # Without the arena and memory-pattern caches the process drops back
            # to its baseline after each image instead of holding peak-sized
            # buffers, which matters on 512 MB instances.
            opts.enable_cpu_mem_arena = False
            opts.enable_mem_pattern = False
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
            # cpu_count() reports host cores inside containers; cap it so a
            # CPU-limited instance isn't flooded with threads.
            opts.intra_op_num_threads = min(4, os.cpu_count() or 1)
            _session = ort.InferenceSession(
                model_path, opts, providers=["CPUExecutionProvider"]
            )
    return _session


def _predict_mask(img: Image.Image) -> Image.Image:
    """Return an 'L' mode foreground mask the same size as img (RGB)."""
    _, size, (mean, std) = MODELS[MODEL_NAME]
    session = _get_session()

    x = np.asarray(img.resize((size, size), Image.Resampling.LANCZOS), dtype=np.float32)
    x /= max(float(x.max()), 1e-6)
    x = (x - np.array(mean, dtype=np.float32)) / np.array(std, dtype=np.float32)
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[np.newaxis], dtype=np.float32)

    pred = session.run(None, {session.get_inputs()[0].name: x})[0][0, 0]
    lo, hi = float(pred.min()), float(pred.max())
    pred = (pred - lo) / max(hi - lo, 1e-6)

    mask = Image.fromarray((pred * 255).astype(np.uint8))
    return mask.resize(img.size, Image.Resampling.LANCZOS)


def remove_background(file_bytes: bytes, filename: str, background=None) -> dict:
    """Cut the subject out of an image.

    Args:
        background: None for a transparent PNG, or an (r, g, b) tuple to place
            the subject on a solid color (keeps the original format).

    Returns:
        dict with keys: output_bytes, width, height, format
    Raises:
        ImageProcessingError: if the image cannot be processed.
    """
    img, fmt, icc_profile = open_image(file_bytes, filename)
    # Avoid a full-size copy while the model is running; this is the peak.
    rgb = img if img.mode == "RGB" else img.convert("RGB")
    mask = _predict_mask(rgb)

    if img.has_transparency_data:
        # Keep pixels that were already transparent transparent.
        alpha = np.minimum(np.asarray(img.convert("RGBA").getchannel("A")), np.asarray(mask))
        mask = Image.fromarray(alpha)

    if background is None:
        result = rgb
        result.putalpha(mask)
        fmt = "PNG"
    else:
        result = Image.new("RGB", rgb.size, background)
        result.paste(rgb, mask=mask)

    return {
        "output_bytes": encode_image(result, fmt, icc_profile),
        "width": result.width,
        "height": result.height,
        "format": fmt,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(f"Model ready: {ensure_model()}")
