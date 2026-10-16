import io
from PIL import Image, ImageOps


class ImageProcessingError(Exception):
    pass


# Larger images risk exhausting memory on small instances (an RGBA copy of a
# 40 MP photo alone is 160 MB).
MAX_PIXELS = 40_000_000

# Output format -> (file extension, mimetype)
FORMATS = {
    "JPEG": ("jpg", "image/jpeg"),
    "PNG": ("png", "image/png"),
    "WEBP": ("webp", "image/webp"),
}
EXTENSION_FORMATS = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}


def open_image(file_bytes: bytes, filename: str):
    """Decode an upload and apply its EXIF orientation.

    Browsers display images with EXIF orientation applied, so doing the same
    here keeps server-side pixel coordinates in line with what the user sees
    (needed for masks drawn in the browser).

    Returns:
        (image, format, icc_profile) where format is one of FORMATS.
    Raises:
        ImageProcessingError: if the image cannot be opened or is too large.
    """
    try:
        img = Image.open(io.BytesIO(file_bytes))
        if img.width * img.height > MAX_PIXELS:
            raise ImageProcessingError(
                f"'{filename}' is too large ({img.width} × {img.height}); "
                f"the limit is {MAX_PIXELS // 1_000_000} megapixels"
            )
        img.load()  # force decode so errors surface here
    except ImageProcessingError:
        raise
    except Exception as e:
        raise ImageProcessingError(f"Cannot open image '{filename}': {e}")

    fmt = img.format if img.format in FORMATS else "PNG"
    icc_profile = img.info.get("icc_profile")
    # In place: otherwise a full copy is made even when nothing needs rotating.
    ImageOps.exif_transpose(img, in_place=True)
    return img, fmt, icc_profile


def encode_image(img: Image.Image, fmt: str, icc_profile: bytes | None = None) -> bytes:
    """Encode an image at high quality. EXIF is dropped (orientation is
    already baked into the pixels); the color profile is kept."""
    output = io.BytesIO()
    extra = {"icc_profile": icc_profile} if icc_profile else {}

    if fmt == "JPEG":
        if img.mode != "RGB":
            img = img.convert("RGB")
        img.save(output, format="JPEG", quality=95, subsampling=0, optimize=True, **extra)
    elif fmt == "WEBP":
        img.save(output, format="WEBP", quality=95, **extra)
    else:
        img.save(output, format="PNG", **extra)

    return output.getvalue()
