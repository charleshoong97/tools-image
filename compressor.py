import io
from PIL import Image, UnidentifiedImageError


class CompressionError(Exception):
    pass


def compress_image(file_bytes: bytes, filename: str, quality: int) -> dict:
    """Compress an image and return metadata + compressed bytes.

    Args:
        file_bytes: Raw bytes of the uploaded image.
        filename: Original filename (used to determine format).
        quality: 1-100 quality/compression slider value.

    Returns:
        dict with keys: compressed_bytes, original_size, compressed_size,
                        ratio, width, height, format
    Raises:
        CompressionError: if the image cannot be opened or processed.
    """
    original_size = len(file_bytes)
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    try:
        img = Image.open(io.BytesIO(file_bytes))
        img.load()  # force decode so errors surface here
    except (UnidentifiedImageError, Exception) as e:
        raise CompressionError(f"Cannot open image '{filename}': {e}")

    width, height = img.size
    output = io.BytesIO()

    # Determine target format
    if ext in ("jpg", "jpeg"):
        fmt = "JPEG"
    elif ext == "png":
        fmt = "PNG"
    else:
        # Fall back to detected format
        fmt = img.format if img.format in ("JPEG", "PNG") else "JPEG"

    if fmt == "JPEG":
        # Convert modes incompatible with JPEG
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        subsampling = 0 if quality >= 85 else 2
        img.save(
            output,
            format="JPEG",
            quality=quality,
            optimize=True,
            progressive=True,
            subsampling=subsampling,
            # Intentionally omit exif= to strip metadata
        )
    else:  # PNG
        # Preserve alpha; convert palette to RGBA
        if img.mode == "P":
            img = img.convert("RGBA")

        # quality 100 -> compress_level 0 (largest/fastest)
        # quality 1   -> compress_level 9 (smallest/slowest)
        compress_level = round((100 - quality) / 100 * 9)
        compress_level = max(0, min(9, compress_level))

        img.save(
            output,
            format="PNG",
            optimize=True,
            compress_level=compress_level,
        )

    compressed_bytes = output.getvalue()
    compressed_size = len(compressed_bytes)
    ratio = compressed_size / original_size if original_size > 0 else 1.0

    return {
        "compressed_bytes": compressed_bytes,
        "original_size": original_size,
        "compressed_size": compressed_size,
        "ratio": ratio,
        "width": width,
        "height": height,
        "format": fmt,
    }
