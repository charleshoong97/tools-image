"""Adding watermarks (a text or logo stamp) and removing them by inpainting.

Text watermarks are rasterised in the browser, so every font and script the
user's browser can render (including CJK and emoji) works; both text and logo
watermarks arrive here as an RGBA stamp image.
"""
import io
import math

import cv2
import numpy as np
from PIL import Image

from imaging import ImageProcessingError, encode_image, open_image

# position -> (x, y) anchor as a fraction of the free space inside the margins
POSITIONS = {
    "top-left": (0, 0), "top": (0.5, 0), "top-right": (1, 0),
    "left": (0, 0.5), "center": (0.5, 0.5), "right": (1, 0.5),
    "bottom-left": (0, 1), "bottom": (0.5, 1), "bottom-right": (1, 1),
}
TILE = "tile"

# Frequency-selective reconstruction rebuilds texture far better than Telea
# inpainting, but runs single-threaded at roughly 10k selected pixels per
# second, so larger selections fall back to Telea to keep requests short.
DETAILED_MAX_PIXELS = 100_000
DETAILED_CONTEXT = 64  # px of surrounding image the reconstruction draws on
TELEA_RADIUS = 5


def _paste(base: Image.Image, stamp: Image.Image, x: float, y: float) -> None:
    """Alpha-composite stamp onto base at (x, y), clipped to base's bounds."""
    x, y = round(x), round(y)
    left, top = max(x, 0), max(y, 0)
    right = min(x + stamp.width, base.width)
    bottom = min(y + stamp.height, base.height)
    if right <= left or bottom <= top:
        return
    base.alpha_composite(stamp, dest=(left, top), source=(left - x, top - y, right - x, bottom - y))


def add_watermark(
    file_bytes: bytes,
    filename: str,
    stamp_bytes: bytes,
    *,
    size: float = 25,
    opacity: float = 50,
    rotation: float = 0,
    position: str = "bottom-right",
    margin: float = 3,
    spacing: float = 10,
) -> dict:
    """Stamp a watermark onto an image.

    Args:
        stamp_bytes: the watermark (text rendered to PNG, or a logo).
        size: stamp width as a percentage of the image width.
        opacity: 0-100.
        rotation: degrees, counter-clockwise.
        position: a key of POSITIONS, or "tile" to repeat across the image.
        margin: distance from the edges, as a percentage of the shorter side.
        spacing: gap between tiles, as a percentage of the shorter side.

    Returns:
        dict with keys: output_bytes, width, height, format
    Raises:
        ImageProcessingError: if either image cannot be processed.
    """
    if position != TILE and position not in POSITIONS:
        raise ImageProcessingError(f"Unknown position '{position}'")

    img, fmt, icc_profile = open_image(file_bytes, filename)
    stamp, _, _ = open_image(stamp_bytes, "watermark")
    stamp = stamp.convert("RGBA")
    width, height = img.size
    short_side = min(width, height)

    stamp_w = max(1, round(width * size / 100))
    stamp_h = max(1, round(stamp.height * stamp_w / stamp.width))
    stamp = stamp.resize((stamp_w, stamp_h), Image.Resampling.LANCZOS)
    if rotation:
        stamp = stamp.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True)
    if opacity < 100:
        alpha = np.asarray(stamp.getchannel("A"), dtype=np.float32) * (opacity / 100)
        stamp.putalpha(Image.fromarray(alpha.round().astype(np.uint8)))

    keep_alpha = img.has_transparency_data
    base = img.convert("RGBA")

    if position == TILE:
        # Brick pattern centred on the image, so it looks balanced on any size.
        gap = short_side * spacing / 100
        step_x, step_y = stamp.width + gap, stamp.height + gap
        cols = math.ceil(width / 2 / step_x) + 1
        rows = math.ceil(height / 2 / step_y) + 1
        for row in range(-rows, rows + 1):
            shift = step_x / 2 if row % 2 else 0
            y = height / 2 + row * step_y - stamp.height / 2
            for col in range(-cols, cols + 1):
                x = width / 2 + col * step_x + shift - stamp.width / 2
                _paste(base, stamp, x, y)
    else:
        fx, fy = POSITIONS[position]
        m = short_side * margin / 100
        _paste(base, stamp, m + fx * (width - 2 * m - stamp.width), m + fy * (height - 2 * m - stamp.height))

    result = base if keep_alpha else base.convert("RGB")
    return {
        "output_bytes": encode_image(result, fmt, icc_profile),
        "width": width,
        "height": height,
        "format": fmt,
    }


def _load_mask(mask_bytes: bytes, size: tuple) -> np.ndarray:
    """Decode a mask painted in the browser into a uint8 0/255 array of `size`.

    Painted pixels are the opaque ones (or white ones if the mask has no
    alpha). The browser may send it at a reduced resolution, so it is scaled
    up to the image size.
    """
    try:
        mask = Image.open(io.BytesIO(mask_bytes))
        mask.load()
    except Exception as e:
        raise ImageProcessingError(f"Cannot read the selection mask: {e}")

    mask = mask.getchannel("A") if mask.has_transparency_data else mask.convert("L")
    if mask.size != size:
        mask = mask.resize(size, Image.Resampling.BILINEAR)
    return np.where(np.asarray(mask) > 0, 255, 0).astype(np.uint8)


def _inpaint_detailed(pixels: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Frequency-selective reconstruction, run on a crop around the selection."""
    ys, xs = np.nonzero(mask)
    top = max(ys.min() - DETAILED_CONTEXT, 0)
    left = max(xs.min() - DETAILED_CONTEXT, 0)
    bottom = min(ys.max() + 1 + DETAILED_CONTEXT, mask.shape[0])
    right = min(xs.max() + 1 + DETAILED_CONTEXT, mask.shape[1])

    crop = np.ascontiguousarray(pixels[top:bottom, left:right])
    crop_mask = mask[top:bottom, left:right]
    filled = np.empty_like(crop)
    # xphoto takes the inverse convention: non-zero marks the *known* pixels.
    cv2.xphoto.inpaint(crop, np.where(crop_mask > 0, 0, 255).astype(np.uint8), filled, cv2.xphoto.INPAINT_FSR_FAST)

    result = pixels.copy()
    result[top:bottom, left:right] = np.where(crop_mask[..., np.newaxis] > 0, filled, crop)
    return result


def remove_watermark(file_bytes: bytes, filename: str, mask_bytes: bytes) -> dict:
    """Fill the masked area in from its surroundings.

    Small selections (the usual corner logo or date stamp) use
    frequency-selective reconstruction, which rebuilds texture; larger ones
    fall back to Telea inpainting, which is smoother but stays fast.

    Args:
        mask_bytes: PNG marking the area to remove.

    Returns:
        dict with keys: output_bytes, width, height, format
    Raises:
        ImageProcessingError: if the image or mask cannot be processed.
    """
    img, fmt, icc_profile = open_image(file_bytes, filename)
    mask = _load_mask(mask_bytes, img.size)
    if not mask.any():
        raise ImageProcessingError("Nothing selected: paint over the watermark first")

    # Grow the selection slightly to catch anti-aliased edges and glows that
    # are easy to miss with the brush and would otherwise leave a faint outline.
    grow = max(1, round(min(img.size) / 400))
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * grow + 1, 2 * grow + 1)))

    keep_alpha = img.has_transparency_data
    pixels = np.asarray(img.convert("RGBA" if keep_alpha else "RGB"))
    rgb = np.ascontiguousarray(pixels[..., :3])
    # Both methods treat channels independently, so RGB order is fine as-is.
    if np.count_nonzero(mask) <= DETAILED_MAX_PIXELS:
        filled = _inpaint_detailed(rgb, mask)
    else:
        filled = cv2.inpaint(rgb, mask, TELEA_RADIUS, cv2.INPAINT_TELEA)
    if keep_alpha:
        alpha = cv2.inpaint(np.ascontiguousarray(pixels[..., 3]), mask, TELEA_RADIUS, cv2.INPAINT_TELEA)
        filled = np.dstack([filled, alpha])

    result = Image.fromarray(filled)
    return {
        "output_bytes": encode_image(result, fmt, icc_profile),
        "width": result.width,
        "height": result.height,
        "format": fmt,
    }
