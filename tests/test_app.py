"""Endpoint tests. Run with: pip install pytest && pytest

The background removal tests download the configured model on first run.
"""
import io
import os
import sys
import zipfile

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module  # noqa: E402

SESSION = "testsession"


@pytest.fixture
def client():
    app_module._store.clear()
    return app_module.app.test_client()


def image_bytes(fmt="JPEG", size=(200, 120), color=(40, 120, 200), mode="RGB", exif=None):
    img = Image.new(mode, size, color)
    buf = io.BytesIO()
    img.save(buf, format=fmt, **({"exif": exif} if exif else {}))
    return buf.getvalue()


def stamp_bytes(size=(100, 40)):
    """A solid white, fully opaque watermark."""
    return image_bytes("PNG", size, (255, 255, 255, 255), "RGBA")


def upload(data, name):
    return (io.BytesIO(data), name)


def open_result(client, result, session=SESSION):
    resp = client.get(f"/download/{session}/{result['id']}")
    assert resp.status_code == 200
    return Image.open(io.BytesIO(resp.data)), resp


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------

@pytest.mark.parametrize("path", ["/", "/remove-background", "/add-watermark", "/remove-watermark"])
def test_pages_render_with_navigation(client, path):
    resp = client.get(path)
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert f'href="{path}" aria-current="page"' in html
    for href in ("/remove-background", "/add-watermark", "/remove-watermark"):
        assert f'href="{href}"' in html


# --------------------------------------------------------------------------
# Compress (existing behaviour)
# --------------------------------------------------------------------------

def test_compress_keeps_names_and_zip(client):
    resp = client.post("/compress", data={
        "session_id": SESSION,
        "quality": "60",
        "files[]": [upload(image_bytes(), "Photo.JPG"), upload(image_bytes("PNG"), "a.png"),
                    upload(b"nope", "notes.txt")],
    })
    data = resp.get_json()
    assert [r["original_name"] for r in data["results"]] == ["Photo.JPG", "a.png"]
    assert data["errors"] == [{"filename": "notes.txt", "error": "Unsupported file type"}]
    assert {"compressed_size", "ratio", "quality"} <= set(data["results"][0])

    _, dl = open_result(client, data["results"][0])
    assert "Photo_compressed.JPG" in dl.headers["Content-Disposition"]

    resp = client.get(f"/download-all/{SESSION}")
    assert "compressed_images_" in resp.headers["Content-Disposition"]
    assert zipfile.ZipFile(io.BytesIO(resp.data)).namelist() == ["Photo_compressed.JPG", "a_compressed.png"]


def test_session_can_be_deleted_by_beacon_post(client):
    client.post("/compress", data={"session_id": SESSION, "files[]": [upload(image_bytes(), "a.jpg")]})
    assert SESSION in app_module._store
    assert client.post(f"/session/{SESSION}").status_code == 204
    assert SESSION not in app_module._store


# --------------------------------------------------------------------------
# Remove background
# --------------------------------------------------------------------------

def subject_photo():
    """A dark subject on a light, plain background."""
    img = Image.new("RGB", (240, 180), (235, 235, 235))
    img.paste((30, 60, 160), (80, 40, 160, 150))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def test_remove_background_transparent(client):
    resp = client.post("/remove-background", data={
        "session_id": SESSION, "files[]": [upload(subject_photo(), "shot.jpg")],
    })
    data = resp.get_json()
    assert data["errors"] == []
    result = data["results"][0]
    assert result["format"] == "PNG"

    img, dl = open_result(client, result)
    assert "shot_no_bg.png" in dl.headers["Content-Disposition"]
    assert img.mode == "RGBA" and img.size == (240, 180)
    alpha = np.asarray(img.getchannel("A"))
    assert alpha[95, 120] > 200   # subject kept
    assert alpha[5, 5] < 50       # background removed


def test_remove_background_on_color_keeps_format(client):
    resp = client.post("/remove-background", data={
        "session_id": SESSION, "background": "#ff0000",
        "files[]": [upload(subject_photo(), "shot.jpg")],
    })
    result = resp.get_json()["results"][0]
    assert result["format"] == "JPEG"
    img, _ = open_result(client, result)
    r, g, b = img.getpixel((5, 5))
    assert r > 200 and g < 60 and b < 60


def test_remove_background_rejects_bad_color(client):
    resp = client.post("/remove-background", data={
        "session_id": SESSION, "background": "red", "files[]": [upload(subject_photo(), "a.jpg")],
    })
    assert resp.status_code == 400


# --------------------------------------------------------------------------
# Add watermark
# --------------------------------------------------------------------------

def test_add_watermark_bottom_right(client):
    resp = client.post("/add-watermark", data={
        "session_id": SESSION, "position": "bottom-right", "size": "25", "opacity": "100", "margin": "0",
        "stamp": upload(stamp_bytes(), "stamp.png"),
        "files[]": [upload(image_bytes("PNG", (400, 200), (0, 0, 0)), "dark.png")],
    })
    result = resp.get_json()["results"][0]
    assert (result["width"], result["height"], result["format"]) == (400, 200, "PNG")

    img, dl = open_result(client, result)
    assert "dark_watermarked.png" in dl.headers["Content-Disposition"]
    # 25% of 400 px wide -> a 100 x 40 stamp in the bottom-right corner
    assert img.getpixel((350, 180)) == (255, 255, 255)
    assert img.getpixel((250, 180)) == (0, 0, 0)
    assert img.getpixel((350, 20)) == (0, 0, 0)


def test_add_watermark_opacity_and_tile(client):
    resp = client.post("/add-watermark", data={
        "session_id": SESSION, "position": "tile", "size": "10", "opacity": "50", "rotation": "30",
        "stamp": upload(stamp_bytes(), "stamp.png"),
        "files[]": [upload(image_bytes("PNG", (400, 300), (0, 0, 0)), "dark.png")],
    })
    img, _ = open_result(client, resp.get_json()["results"][0])
    values = np.asarray(img.convert("L"))
    assert values.max() in range(120, 135)          # half-opaque white over black
    assert (values > 100).mean() > 0.1               # repeated across the image
    assert (values[:150] > 100).any() and (values[150:] > 100).any()


def test_add_watermark_preserves_transparency(client):
    resp = client.post("/add-watermark", data={
        "session_id": SESSION, "position": "center", "opacity": "100",
        "stamp": upload(stamp_bytes(), "stamp.png"),
        "files[]": [upload(image_bytes("PNG", (200, 200), (0, 0, 0, 0), "RGBA"), "clear.png")],
    })
    img, _ = open_result(client, resp.get_json()["results"][0])
    assert img.mode == "RGBA"
    assert img.getpixel((0, 0))[3] == 0
    assert img.getpixel((100, 100)) == (255, 255, 255, 255)


def test_add_watermark_validation(client):
    files = {"session_id": SESSION, "files[]": [upload(image_bytes(), "a.jpg")]}
    assert client.post("/add-watermark", data=files).status_code == 400  # no stamp
    resp = client.post("/add-watermark", data={
        "session_id": SESSION, "position": "middle", "stamp": upload(stamp_bytes(), "s.png"),
        "files[]": [upload(image_bytes(), "a.jpg")],
    })
    assert resp.status_code == 400


def test_add_watermark_preview_returns_image_without_storing(client):
    resp = client.post("/add-watermark/preview", data={
        "position": "center", "file": upload(image_bytes(), "preview.jpg"),
        "stamp": upload(stamp_bytes(), "stamp.png"),
    })
    assert resp.status_code == 200 and resp.mimetype == "image/jpeg"
    assert Image.open(io.BytesIO(resp.data)).size == (200, 120)
    assert app_module._store == {}


# --------------------------------------------------------------------------
# Remove watermark
# --------------------------------------------------------------------------

def watermarked_photo():
    """A smooth gradient with a white square 'watermark' at (60..90, 40..70)."""
    x = np.linspace(0, 255, 200, dtype=np.uint8)
    pixels = np.dstack([np.tile(x, (120, 1))] * 3)
    pixels[40:70, 60:90] = 255
    buf = io.BytesIO()
    Image.fromarray(pixels).save(buf, format="PNG")
    return buf.getvalue(), pixels


def mask_png(size, box, scale=1):
    mask = Image.new("RGBA", (size[0] // scale, size[1] // scale), (0, 0, 0, 0))
    left, top, right, bottom = (v // scale for v in box)
    mask.paste((255, 255, 255, 255), (left, top, right, bottom))
    buf = io.BytesIO()
    mask.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.parametrize("mask_scale", [1, 2])  # the browser may send a reduced-size mask
def test_remove_watermark_fills_selection(client, mask_scale):
    photo, original = watermarked_photo()
    resp = client.post("/remove-watermark", data={
        "session_id": SESSION, "file": upload(photo, "grad.png"),
        "mask": upload(mask_png((200, 120), (56, 36, 94, 74), mask_scale), "mask.png"),
    })
    data = resp.get_json()
    assert data["errors"] == []
    img, dl = open_result(client, data["results"][0])
    assert "grad_no_watermark.png" in dl.headers["Content-Disposition"]

    out = np.asarray(img).astype(int)
    expected = np.tile(np.linspace(0, 255, 200), (120, 1))
    assert np.abs(out[40:70, 60:90, 0] - expected[40:70, 60:90]).max() < 40  # square gone
    assert (out[:, :50] == original[:, :50]).all()                           # rest untouched


def test_remove_watermark_requires_a_selection(client):
    photo, _ = watermarked_photo()
    resp = client.post("/remove-watermark", data={
        "session_id": SESSION, "file": upload(photo, "grad.png"),
        "mask": upload(mask_png((200, 120), (0, 0, 0, 0)), "mask.png"),
    })
    assert "Nothing selected" in resp.get_json()["errors"][0]["error"]
    assert client.post("/remove-watermark", data={"session_id": SESSION}).status_code == 400


def test_exif_orientation_is_applied(client):
    # Orientation 6 = rotate 90° CW for display; browsers draw masks on the rotated image
    exif = Image.Exif()
    exif[0x0112] = 6
    photo = image_bytes("JPEG", (200, 120), exif=exif.tobytes())
    resp = client.post("/remove-watermark", data={
        "session_id": SESSION, "file": upload(photo, "phone.jpg"),
        "mask": upload(mask_png((120, 200), (10, 10, 30, 30)), "mask.png"),
    })
    result = resp.get_json()["results"][0]
    assert (result["width"], result["height"]) == (120, 200)
